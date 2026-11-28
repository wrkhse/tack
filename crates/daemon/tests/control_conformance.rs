//! Real-stall control conformance.
//!
//! Drives the actual daemon binary against the actual barn stall. The plugin
//! reaches a vendor-neutral harness through a computed control key, so the
//! frame carries no plugin identity: authorization must come from the daemon's
//! own launch arguments and the host grants file. Each test is inert unless
//! `TACK_BARN_BIN` names a barn binary; CI supplies one.

use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;
use tack_protocol::wire::{
    Content, PROTOCOL_VERSION, Reply, ReplyError, Request, encode_line, read_line,
};

const WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(10);
const HARNESS_CALL: &str = r#"{"call":"navigate","input":{"target":"proof"}}"#;
const HARNESS_REPLY: &str = "{\"result\":{\"reached\":\"harness\"}}\n";
const GRANTS: &str = r#"{"grants":{"control-proof":{"control":{"calls":["navigate"]}}}}"#;

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

/// A private folder holding the state dir, the copied plugin, both sockets
/// and, in the granted case, the host grants file.
struct Sandbox(PathBuf);

impl Sandbox {
    fn new() -> Self {
        let seq = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            % 1_000_000_000;
        let path = std::env::temp_dir().join(format!(
            "tack-control-conformance-{}-{nanos}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();

        Self(path)
    }

    fn plugin(&self) -> PathBuf {
        self.copy_plugin("control-proof")
    }

    fn undeclared_plugin(&self) -> PathBuf {
        self.copy_plugin("control-proof-undeclared")
    }

    fn copy_plugin(&self, fixture: &str) -> PathBuf {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures")
            .join(fixture);
        let plugin = self.0.join("plugin");
        fs::create_dir(&plugin).unwrap();

        for entry in fs::read_dir(&source).unwrap() {
            let entry = entry.unwrap();
            assert!(entry.file_type().unwrap().is_file());
            fs::copy(entry.path(), plugin.join(entry.file_name())).unwrap();
        }

        plugin
    }

    fn socket(&self) -> PathBuf {
        self.0.join("tack.sock")
    }

    fn harness_socket(&self) -> PathBuf {
        self.0.join("harness.sock")
    }

    fn grants(&self, text: &str) -> PathBuf {
        let path = self.0.join("grants.json");
        fs::write(&path, text).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        path
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A bounded listener that answers one call and counts every call it accepts,
/// so a denial can also prove the harness saw nothing.
struct FakeHarness {
    calls: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl FakeHarness {
    fn start(socket: &Path) -> Self {
        let listener = UnixListener::bind(socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let seen = Arc::clone(&calls);
        let halted = Arc::clone(&stop);

        let worker = thread::spawn(move || {
            let deadline = Instant::now()
                .checked_add(WAIT)
                .unwrap_or_else(Instant::now);

            loop {
                if halted.load(Ordering::SeqCst) {
                    break;
                }

                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream.set_read_timeout(Some(WAIT)).unwrap();
                        stream.set_write_timeout(Some(WAIT)).unwrap();
                        let mut reader = BufReader::new(stream.try_clone().unwrap());

                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        assert_eq!(line, format!("{HARNESS_CALL}\n"));

                        stream.write_all(HARNESS_REPLY.as_bytes()).unwrap();
                        stream.flush().unwrap();
                        seen.fetch_add(1, Ordering::SeqCst);
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "harness accept timed out");
                        thread::sleep(POLL);
                    }
                    Err(error) => panic!("harness accept failed: {error}"),
                }
            }
        });

        Self {
            calls,
            stop,
            worker: Some(worker),
        }
    }

    /// Stop the listener, join it and report how many calls it accepted.
    fn finish(mut self) -> usize {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }

        self.calls.load(Ordering::SeqCst)
    }
}

impl Drop for FakeHarness {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// A spawned daemon, always killed and reaped even when an assertion fails.
struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let deadline = Instant::now()
            .checked_add(WAIT)
            .unwrap_or_else(Instant::now);

        while let Ok(None) = self.0.try_wait() {
            if Instant::now() >= deadline {
                eprintln!("tack-daemon: reap timed out");
                break;
            }
            thread::sleep(POLL);
        }
    }
}

fn start_daemon(barn: &str, sandbox: &Sandbox, plugin: &Path, grants: Option<&Path>) -> Daemon {
    start_daemon_with(barn, sandbox, plugin, grants, true)
}

/// Launch without `--need`, so no need is declared to the daemon.
fn start_daemon_undeclared(
    barn: &str,
    sandbox: &Sandbox,
    plugin: &Path,
    grants: Option<&Path>,
) -> Daemon {
    start_daemon_with(barn, sandbox, plugin, grants, false)
}

fn start_daemon_with(
    barn: &str,
    sandbox: &Sandbox,
    plugin: &Path,
    grants: Option<&Path>,
    declare_need: bool,
) -> Daemon {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tack-daemon"));
    command
        .arg("--socket")
        .arg(sandbox.socket())
        .arg("--plugin")
        .arg(plugin)
        .arg("--plugin-name")
        .arg("control-proof");

    if declare_need {
        command.arg("--need").arg("control.call.navigate");
    }

    command
        .env("TACK_STATE_DIR", &sandbox.0)
        .env("TACK_BARN_BIN", barn)
        .env("TACK_HARNESS_SOCK", sandbox.harness_socket())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());

    match grants {
        Some(path) => {
            command.env("TACK_GRANTS", path);
        }
        None => {
            command.env_remove("TACK_GRANTS");
        }
    }

    Daemon(command.spawn().unwrap())
}

fn wait_for_socket(socket: &Path) -> UnixStream {
    let deadline = Instant::now()
        .checked_add(WAIT)
        .unwrap_or_else(Instant::now);

    loop {
        match UnixStream::connect(socket) {
            Ok(stream) => return stream,
            Err(error)
                if error.kind() == ErrorKind::NotFound
                    || error.kind() == ErrorKind::ConnectionRefused =>
            {
                assert!(
                    Instant::now() < deadline,
                    "tack.sock never appeared: {error}"
                );
                thread::sleep(POLL);
            }
            Err(error) => panic!("tack.sock connect failed: {error}"),
        }
    }
}

fn tool_reply(socket: &Path) -> Reply {
    let mut stream = wait_for_socket(socket);
    stream.set_read_timeout(Some(WAIT)).unwrap();
    stream.set_write_timeout(Some(WAIT)).unwrap();

    let request = Request::Tool {
        id: 7,
        version: PROTOCOL_VERSION,
        name: "control_probe".to_owned(),
        input: json!({}),
    };
    stream.write_all(&encode_line(&request).unwrap()).unwrap();
    stream.flush().unwrap();

    let mut reader = BufReader::new(stream);
    let line = read_line(&mut reader).unwrap().expect("the daemon replied");
    serde_json::from_slice(&line).unwrap()
}

#[test]
fn a_denied_control_call_never_reaches_the_harness() {
    let Ok(barn) = std::env::var("TACK_BARN_BIN") else {
        println!("skipping: TACK_BARN_BIN is not set");
        return;
    };

    let sandbox = Sandbox::new();
    let harness = FakeHarness::start(&sandbox.harness_socket());
    let plugin = sandbox.plugin();
    let _daemon = start_daemon(&barn, &sandbox, &plugin, None);

    assert_eq!(
        tool_reply(&sandbox.socket()),
        Reply::Error {
            id: 7,
            version: PROTOCOL_VERSION,
            error: ReplyError::DaemonError,
            message: "grant_denied".to_owned(),
        }
    );
    assert_eq!(harness.finish(), 0);
}

#[test]
fn a_granted_control_call_returns_the_harness_result() {
    let Ok(barn) = std::env::var("TACK_BARN_BIN") else {
        println!("skipping: TACK_BARN_BIN is not set");
        return;
    };

    let sandbox = Sandbox::new();
    let harness = FakeHarness::start(&sandbox.harness_socket());
    let plugin = sandbox.plugin();
    let grants = sandbox.grants(GRANTS);
    let _daemon = start_daemon(&barn, &sandbox, &plugin, Some(&grants));

    assert_eq!(
        tool_reply(&sandbox.socket()),
        Reply::Tool {
            id: 7,
            version: PROTOCOL_VERSION,
            content: vec![Content {
                kind: "text".to_owned(),
                text: "harness".to_owned(),
            }],
        }
    );
    assert_eq!(harness.finish(), 1);
}

#[test]
fn a_granted_call_without_a_declared_need_never_reaches_the_harness() {
    let Ok(barn) = std::env::var("TACK_BARN_BIN") else {
        println!("skipping: TACK_BARN_BIN is not set");
        return;
    };

    let sandbox = Sandbox::new();
    let harness = FakeHarness::start(&sandbox.harness_socket());
    let plugin = sandbox.undeclared_plugin();
    let grants = sandbox.grants(GRANTS);
    let _daemon = start_daemon_undeclared(&barn, &sandbox, &plugin, Some(&grants));

    assert_eq!(
        tool_reply(&sandbox.socket()),
        Reply::Error {
            id: 7,
            version: PROTOCOL_VERSION,
            error: ReplyError::DaemonError,
            message: "grant_denied".to_owned(),
        }
    );
    assert_eq!(harness.finish(), 0);
}
