//! Entry point for the per-user tack daemon.

use std::ffi::OsString;
use std::fmt::{self, Write};
use std::io::{self, BufReader};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use rustix::process::{Pid, Signal, kill_process_group};
use tack_daemon::control;
use tack_daemon::grants::{Grants, MAX_CALLS, MAX_NAME_BYTES};
use tack_daemon::host_transport::{ControlBroker, HostEndpoint, HostTransport};
use tack_daemon::pipe::{self, PipeError};
use tack_daemon::stall::{Clock, StallClient, SystemClock};
use tack_daemon::transport::{TransportError, bind};
use tack_daemon::{
    ERR_SOCKET_MISMATCH, EXIT_ENGINE, EXIT_LOCK_BUSY, EXIT_USAGE, SOCKET_NAME, frames,
    socket_in_state_dir, state_dir,
};
use tack_protocol::wire::{
    DEFAULT_DEADLINE_MS, Outcome, PROTOCOL_VERSION, Reply, ReplyError, Request,
};

const GRANTS_ENV: &str = "TACK_GRANTS";
const BARN_BIN_ENV: &str = "TACK_BARN_BIN";
const BARN_BIN_NAME: &str = "barn";
const BARN_STATE_DIR_VAR: &str = "BARN_STATE_DIR";

/// The one named denial for a plugin the daemon cannot reach.
fn unavailable(reason: &str) -> String {
    format!("tack: plugin unavailable: {reason}")
}

/// The daemon's launch settings.
///
/// `--grants <path>` names the host grants file. Without it, `TACK_GRANTS`
/// is read the same way; an explicit argument wins over the environment.
/// `TACK_HARNESS_SOCK` optionally names the socket granted control calls are
/// forwarded to. With no name, needs or grants, every call stays denied.
struct Args {
    socket: PathBuf,
    plugin: PathBuf,
    grants: Grants,
    identity: control::LaunchIdentity,
    harness_socket: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    parse_args_with(
        std::env::args().skip(1),
        std::env::var(GRANTS_ENV).ok(),
        std::env::var(control::HARNESS_SOCK_ENV).ok(),
    )
}

/// Parse the launch settings from an explicit argument list and environment.
fn parse_args_with<I>(
    args: I,
    env_grants: Option<String>,
    env_harness: Option<String>,
) -> Result<Args, String>
where
    I: IntoIterator<Item = String>,
{
    let mut socket = None;
    let mut plugin = None;
    let mut grants: Option<PathBuf> = None;
    let mut name = None;
    let mut needs = Vec::new();
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket = Some(args.next().ok_or("--socket needs a path")?.into()),
            "--plugin" => plugin = Some(args.next().ok_or("--plugin needs a dir")?.into()),
            "--grants" => grants = Some(args.next().ok_or("--grants needs a path")?.into()),
            "--plugin-name" => {
                if name.is_some() {
                    return Err("--plugin-name given more than once".to_owned());
                }
                let value = args.next().ok_or("--plugin-name needs a name")?;
                if !launch_name_ok(&value) {
                    return Err(format!("invalid plugin name {value}"));
                }
                name = Some(value);
            }
            "--need" => {
                let value = args.next().ok_or("--need needs a capability")?;
                if !launch_name_ok(&value) {
                    return Err(format!("invalid need {value}"));
                }
                if needs.len() >= MAX_CALLS {
                    return Err(format!("too many --need flags (limit {MAX_CALLS})"));
                }
                needs.push(value);
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }

    let grants = match grants.or_else(|| env_grants.map(PathBuf::from)) {
        Some(path) => {
            Grants::from_file(&PathBuf::from(path)).map_err(|error| format!("grants: {error}"))?
        }
        None => Grants::default(),
    };

    Ok(Args {
        socket: socket.ok_or("missing --socket <path>")?,
        plugin: plugin.ok_or("missing --plugin <dir>")?,
        grants,
        identity: control::LaunchIdentity {
            name: name.unwrap_or_default(),
            needs,
        },
        harness_socket: env_harness.map(PathBuf::from),
    })
}

/// Names are non-empty ASCII `[a-z0-9_.-]` within the grants name bound.
fn launch_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_BYTES
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'-')
        })
}

/// A named error reply for a request that never reached a verdict.
fn daemon_error(id: u64, error: impl fmt::Display) -> Reply {
    let message = error.to_string();

    eprintln!("tack-daemon: {message}");

    Reply::Error {
        id,
        version: PROTOCOL_VERSION,
        error: ReplyError::DaemonError,
        message,
    }
}

type HostClient = StallClient<SystemClock, HostTransport>;

/// The stall serving requests, with its child, or the reason none started.
enum Stall {
    Host { client: HostClient, child: Child },
    Unavailable(String),
}

impl Drop for Stall {
    fn drop(&mut self) {
        if let Self::Host { child, .. } = self {
            kill_and_wait(child);
        }
    }
}

/// Stop a child and consume its exit so no process is left behind.
fn kill_and_wait(child: &mut Child) {
    // A stalled helper can inherit stdout and keep the pipe open past the
    // deadline, so kill the whole group before reaping the direct child.
    if let Some(group) = i32::try_from(child.id()).ok().and_then(Pid::from_raw) {
        let _ = kill_process_group(group, Signal::KILL);
    }
    let _ = child.kill();

    // An uninterruptible child can ignore both signals, so never wait on it
    // without a budget: startup and shutdown must stay bounded.
    let deadline = Instant::now()
        .checked_add(Duration::from_millis(500))
        .unwrap_or_else(Instant::now);
    if reap_timed_out(wait_bounded(|| child.try_wait(), deadline)) {
        eprintln!("tack-daemon: child reap timed out");
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reaped {
    Exited(ExitStatus),
    Timeout,
}

/// Only a missing exit is a timeout; an observed exit is not.
fn reap_timed_out(result: Reaped) -> bool {
    result == Reaped::Timeout
}

/// Wait for an exit inside the budget; an absent exit is not a success.
fn wait_bounded(
    mut poll: impl FnMut() -> io::Result<Option<ExitStatus>>,
    deadline: Instant,
) -> Reaped {
    loop {
        match poll() {
            Ok(Some(status)) => return Reaped::Exited(status),
            Ok(None) => {}
            Err(_) => return Reaped::Timeout,
        }

        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Reaped::Timeout;
        };
        let pause = remaining.min(Duration::from_millis(5));
        if pause.is_zero() {
            return Reaped::Timeout;
        }
        thread::sleep(pause);
    }
}

/// Reap a spawned child on every path that does not hand it to the stall.
struct Reaper<'a> {
    child: &'a mut Child,
    armed: bool,
}

impl Reaper<'_> {
    const fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for Reaper<'_> {
    fn drop(&mut self) {
        if self.armed {
            kill_and_wait(self.child);
        }
    }
}

/// Route one wire request through the stall and back into a wire reply.
fn handle(request: &Request, client: &Mutex<Stall>) -> Reply {
    let id = request.id();

    let frame = match frames::to_stall(request) {
        Ok(frame) => frame,
        Err(error) => return daemon_error(id, error),
    };

    let reply = {
        let Ok(mut stall) = client.lock() else {
            return daemon_error(id, "stall lock poisoned");
        };

        let host = match &mut *stall {
            Stall::Host { client, .. } => client,
            Stall::Unavailable(reason) => return daemon_error(id, reason),
        };

        match host.call(&frame) {
            Ok(reply) => reply,
            Err(error) => return daemon_error(id, error),
        }
    };

    let reply = match frames::from_stall(request, reply) {
        Ok(reply) => reply,
        Err(error) => return daemon_error(id, error),
    };

    if let Some(line) = verdict_line(request, &reply) {
        eprintln!("{line}");
    }

    reply
}

/// Escape control characters in request- or reply-supplied log text so it
/// cannot forge or split the single-line verdict log. Ordinary text is unchanged.
fn log_safe(text: &str) -> String {
    let mut safe = String::with_capacity(text.len());

    for ch in text.chars() {
        if ch.is_control() {
            let _ = write!(safe, "\\u{{{:x}}}", u32::from(ch));
        } else {
            safe.push(ch);
        }
    }

    safe
}

/// Format one verdict line, escaping every part the peer can supply.
fn verdict_line(request: &Request, reply: &Reply) -> Option<String> {
    match (request, reply) {
        (Request::Hook { hook, .. }, Reply::Hook { outcome, .. }) => {
            let hook = log_safe(hook);

            Some(match outcome {
                Outcome::Allow => format!("tack-daemon: hook {hook} allow"),
                Outcome::Deny { reason } => {
                    let reason = log_safe(reason);
                    format!("tack-daemon: hook {hook} deny {reason}")
                }
                Outcome::Rewrite { .. } => format!("tack-daemon: hook {hook} rewrite"),
                Outcome::Annotate { .. } => format!("tack-daemon: hook {hook} annotate"),
                Outcome::Drop => format!("tack-daemon: hook {hook} drop"),
            })
        }
        (Request::Tool { name, .. }, Reply::Tool { .. }) => {
            let name = log_safe(name);
            Some(format!("tack-daemon: tool {name} ok"))
        }
        _ => None,
    }
}

/// Pick the barn path from the override or the daemon's own folder.
fn barn_path(env: Option<&str>, current_exe: &Path) -> PathBuf {
    env.filter(|value| !value.is_empty()).map_or_else(
        || {
            current_exe
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .join(BARN_BIN_NAME)
        },
        PathBuf::from,
    )
}

/// Resolve barn without consulting `PATH`; only an absolute file is named.
fn find_barn(env: Option<&str>, current_exe: &Path) -> Result<PathBuf, String> {
    let path = barn_path(env, current_exe);

    if path.is_absolute() && path.is_file() {
        Ok(path)
    } else {
        Err(unavailable("barn not found"))
    }
}

/// Only a canonical absolute plugin folder can be passed to barn.
fn plugin_path(raw: &Path) -> Result<PathBuf, String> {
    if !raw.is_absolute() {
        return Err(unavailable("plugin path invalid"));
    }

    let canonical = std::fs::canonicalize(raw).map_err(|_| unavailable("plugin path invalid"))?;
    if !canonical.is_dir() {
        return Err(unavailable("plugin path invalid"));
    }

    Ok(canonical)
}

/// Where barn's streams go; `Command` exposes no getters for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildStream {
    Piped,
    Inherit,
}

impl ChildStream {
    fn stdio(self) -> Stdio {
        match self {
            Self::Piped => Stdio::piped(),
            Self::Inherit => Stdio::inherit(),
        }
    }
}

/// The launch settings barn receives, inspectable without those getters.
#[derive(Debug, PartialEq, Eq)]
struct BarnLaunch {
    program: PathBuf,
    args: Vec<OsString>,
    state_dir: PathBuf,
    stdout: ChildStream,
    stderr: ChildStream,
}

impl BarnLaunch {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);

        command
            .args(&self.args)
            .env(BARN_STATE_DIR_VAR, &self.state_dir)
            .process_group(0)
            .stdout(self.stdout.stdio())
            .stderr(self.stderr.stdio());

        command
    }
}

/// The exact launch: one stall, stdout for the endpoint, logs on stderr.
fn barn_launch(binary: &Path, plugin: &Path, daemon_pid: u32, state: &Path) -> BarnLaunch {
    BarnLaunch {
        program: binary.to_path_buf(),
        args: vec![
            OsString::from("stall"),
            OsString::from("start"),
            OsString::from("--plugin"),
            plugin.as_os_str().to_os_string(),
            OsString::from("--daemon-pid"),
            OsString::from(daemon_pid.to_string()),
        ],
        state_dir: state.join("barn"),
        stdout: ChildStream::Piped,
        stderr: ChildStream::Inherit,
    }
}

/// Build the client that talks to the endpoint barn printed.
fn host_client(endpoint: HostEndpoint, broker: Arc<dyn ControlBroker>) -> HostClient {
    StallClient::new(
        SystemClock,
        HostTransport::with_broker(endpoint, broker),
        Duration::from_millis(DEFAULT_DEADLINE_MS),
    )
}

/// Read the endpoint on a worker so an open stdout cannot block the daemon.
fn launch_from_child(
    child: &mut Child,
    deadline: Instant,
    broker: Arc<dyn ControlBroker>,
) -> Result<HostClient, PipeError> {
    let mut reaper = Reaper { child, armed: true };
    let stdout = reaper.child.stdout.take().ok_or(PipeError::Missing)?;
    let (sender, receiver) = mpsc::channel();
    let _worker = thread::spawn(move || {
        let _ = sender.send(pipe::read_endpoint(&mut BufReader::new(stdout), deadline));
    });

    let remaining = deadline
        .checked_duration_since(Instant::now())
        .unwrap_or(Duration::ZERO);
    let Ok(result) = receiver.recv_timeout(remaining) else {
        kill_and_wait(reaper.child);
        reaper.disarm();

        return Err(PipeError::Missing);
    };

    let endpoint = match result {
        Ok(endpoint) => endpoint,
        Err(PipeError::Error(reason)) => {
            let group = i32::try_from(reaper.child.id())
                .ok()
                .and_then(Pid::from_raw);

            let status = match wait_bounded(|| reaper.child.try_wait(), deadline) {
                Reaped::Exited(status) => Some(status),
                Reaped::Timeout => None,
            };

            // Only leftover helpers remain: barn itself was already reaped.
            // The PGID stays reserved while any group member is alive, so
            // the only residual exposure is a new process taking that PID
            // and making itself a group leader in the window after the last
            // member exits; the supervisor accepted that window on
            // 2026-11-27. ESRCH means the group already exited and counts
            // as success, so the result is ignored.
            if let Some(group) = group {
                let _ = kill_process_group(group, Signal::KILL);
            }

            if status.is_none() {
                kill_and_wait(reaper.child);
            }
            reaper.disarm();

            if let Some(status) = status
                && matches!(status.code(), Some(code) if code != 0)
            {
                return Err(PipeError::Error(reason));
            }

            return Err(PipeError::Malformed);
        }
        Err(error) => return Err(error),
    };

    reaper.disarm();

    Ok(host_client(endpoint, broker))
}

/// Start barn, read its one endpoint line and bind the host transport.
fn launch_stall(
    plugin: &Path,
    state: &Path,
    broker: Arc<dyn ControlBroker>,
) -> Result<Stall, String> {
    launch_stall_with(
        std::env::var(BARN_BIN_ENV).ok().as_deref(),
        plugin,
        state,
        broker,
    )
}

/// The launch with an explicit barn override, so the named deny is testable.
fn launch_stall_with(
    override_bin: Option<&str>,
    plugin: &Path,
    state: &Path,
    broker: Arc<dyn ControlBroker>,
) -> Result<Stall, String> {
    let plugin = plugin_path(plugin)?;
    let exe = std::env::current_exe().map_err(|_| unavailable("barn not found"))?;
    let binary = find_barn(override_bin, &exe)?;
    let mut child = barn_launch(&binary, &plugin, std::process::id(), state)
        .command()
        .spawn()
        .map_err(|error| unavailable(&format!("barn launch failed: {}", error.kind())))?;
    let deadline = SystemClock.deadline(Duration::from_millis(DEFAULT_DEADLINE_MS));
    let client =
        launch_from_child(&mut child, deadline, broker).map_err(|error| error.to_string())?;

    Ok(Stall::Host { client, child })
}

/// Return a code instead of exiting here so `client` and its live `Stall`
/// are dropped first; `Stall::drop` then reaps the barn child on every exit.
async fn run(args: Args, state: PathBuf) -> i32 {
    // The broker is the only place a control frame can be authorized. It
    // carries the launch identity, host grants and optional harness socket.
    let broker: Arc<dyn ControlBroker> = Arc::new(control::ControlBroker::new(
        args.identity,
        args.grants.clone(),
        args.harness_socket,
    ));

    if !socket_in_state_dir(&state, &args.socket) {
        eprintln!(
            "tack-daemon: {ERR_SOCKET_MISMATCH}: expected {} got {}",
            state.join(SOCKET_NAME).display(),
            args.socket.display()
        );
        return EXIT_USAGE;
    }

    let server = match bind(&state, &args.socket) {
        Ok(server) => server,
        Err(TransportError::LockBusy) => {
            eprintln!("tack-daemon: lock_busy");
            return EXIT_LOCK_BUSY;
        }
        Err(error) => {
            eprintln!("tack-daemon: bind: {error}");
            return EXIT_ENGINE;
        }
    };

    let stall = match launch_stall(&args.plugin, &state, broker) {
        Ok(stall) => stall,
        Err(reason) => {
            eprintln!("tack-daemon: {reason}");
            Stall::Unavailable(reason)
        }
    };
    let client = Mutex::new(stall);

    if let Err(error) = server.serve(move |request| handle(&request, &client)).await {
        eprintln!("tack-daemon: serve: {error}");
        return EXIT_ENGINE;
    }

    0
}

#[tokio::main]
async fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("tack-daemon: {message}");
            std::process::exit(EXIT_USAGE);
        }
    };

    let state = match state_dir() {
        Ok(state) => state,
        Err(message) => {
            eprintln!("tack-daemon: {message}");
            std::process::exit(EXIT_USAGE);
        }
    };

    std::process::exit(run(args, state).await);
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::fs::{self, Permissions};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::ExitStatusExt;
    use std::path::Path;
    use std::process::Command;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    use tack_daemon::grants::GrantError;

    use super::*;

    #[test]
    fn a_control_character_in_a_hook_name_is_escaped_for_the_log() {
        assert_eq!(log_safe("PreToolUse"), "PreToolUse");

        let escaped = log_safe("Pre\nTool\rUse\u{1b}");

        assert_eq!(escaped, "Pre\\u{a}Tool\\u{d}Use\\u{1b}");
        assert!(!escaped.contains('\n'));
        assert!(!escaped.contains('\r'));
    }

    #[test]
    fn a_newline_in_a_deny_reason_is_escaped_into_one_log_line() {
        let request = Request::Hook {
            id: 1,
            version: PROTOCOL_VERSION,
            hook: "PreToolUse".to_owned(),
            call: tack_protocol::wire::ToolCall {
                tool: "guard".to_owned(),
                name: "check".to_owned(),
                input: serde_json::json!({}),
                session_id: None,
            },
            _meta: None,
        };
        let reply = Reply::Hook {
            id: 1,
            version: PROTOCOL_VERSION,
            outcome: Outcome::Deny {
                reason: "blocked\nforged tack-daemon: hook x allow".to_owned(),
            },
        };

        let line = verdict_line(&request, &reply).expect("a hook verdict has a line");

        assert_eq!(
            line,
            "tack-daemon: hook PreToolUse deny blocked\\u{a}forged tack-daemon: hook x allow"
        );
        assert!(!line.contains('\n'));
        assert!(!line.contains('\r'));
    }

    #[test]
    fn a_newline_in_a_tool_name_is_escaped_into_one_log_line() {
        let request = Request::Tool {
            id: 2,
            version: PROTOCOL_VERSION,
            name: "check\nforged tack-daemon: hook x allow".to_owned(),
            input: serde_json::json!({}),
        };
        let reply = Reply::Tool {
            id: 2,
            version: PROTOCOL_VERSION,
            content: vec![],
        };

        let line = verdict_line(&request, &reply).expect("a tool verdict has a line");

        assert_eq!(
            line,
            "tack-daemon: tool check\\u{a}forged tack-daemon: hook x allow ok"
        );
        assert!(!line.contains('\n'));
    }

    #[tokio::test]
    async fn a_socket_outside_the_state_dir_returns_usage() {
        let args = Args {
            socket: PathBuf::from("/tmp/tack-not-in-state.sock"),
            plugin: PathBuf::from("/tmp"),
            grants: Grants::default(),
            identity: control::LaunchIdentity::default(),
            harness_socket: None,
        };

        let result = run(args, PathBuf::from("/tmp/tack-run-test-state")).await;

        assert_eq!(result, EXIT_USAGE);
    }

    #[test]
    fn explicit_grants_win_over_the_env_fallback() {
        let dir = Script::new("exit 0");
        let granted = dir.0.join("grants.json");
        fs::write(
            &granted,
            r#"{"grants":{"host-grants":{"control":{"calls":["navigate"]}}}}"#,
        )
        .unwrap();
        let granted = granted.to_string_lossy().into_owned();
        let missing = dir.0.join("absent.json").to_string_lossy().into_owned();
        let base = || {
            [
                "--socket".to_owned(),
                "/tmp/tack-test.sock".to_owned(),
                "--plugin".to_owned(),
                "/tmp".to_owned(),
            ]
        };
        let needs = ["control.call.navigate".to_owned()];

        let explicit = parse_args_with(base(), Some(missing.clone()), None).unwrap();
        assert_eq!(
            explicit.grants.authorize("host-grants", &needs, "navigate"),
            Ok(())
        );
        assert!(parse_args_with(base(), None, Some(missing)).is_err());

        let fallback = parse_args_with(base(), None, Some(granted)).unwrap();
        assert_eq!(
            fallback.grants.authorize("host-grants", &needs, "navigate"),
            Ok(())
        );
    }

    #[test]
    fn a_plugin_name_is_declared_once_and_needs_are_bounded() {
        let base = || {
            [
                "--socket".to_owned(),
                "/tmp/tack-test.sock".to_owned(),
                "--plugin".to_owned(),
                "/tmp".to_owned(),
            ]
        };
        let mut args = base().to_vec();
        args.extend(["--plugin-name".to_owned(), "plugin".to_owned()]);
        args.extend(["--need".to_owned(), "control.call.navigate".to_owned()]);
        args.extend(["--need".to_owned(), "control.call.other".to_owned()]);

        let parsed = parse_args_with(args, None, None).unwrap();

        assert_eq!(parsed.identity.name, "plugin");
        assert_eq!(parsed.identity.needs.len(), 2);
        assert_eq!(parsed.harness_socket, None);

        let mut duplicate = base().to_vec();
        duplicate.extend(["--plugin-name".to_owned(), "plugin".to_owned()]);
        duplicate.extend(["--plugin-name".to_owned(), "other".to_owned()]);

        assert_eq!(
            parse_args_with(duplicate, None, None).err(),
            Some("--plugin-name given more than once".to_owned())
        );

        let mut invalid = base().to_vec();
        invalid.extend(["--need".to_owned(), "Bad Name".to_owned()]);

        assert!(parse_args_with(invalid, None, None).is_err());

        let mut overflow = base().to_vec();
        for index in 0..=MAX_CALLS {
            overflow.extend(["--need".to_owned(), format!("cap-{index}")]);
        }

        assert!(parse_args_with(overflow, None, None).is_err());
    }

    #[test]
    fn the_env_override_selects_the_barn_binary() {
        assert_eq!(
            barn_path(
                Some("/opt/tack/bin/barn"),
                Path::new("/usr/local/bin/tack-daemon")
            ),
            PathBuf::from("/opt/tack/bin/barn")
        );
    }

    #[test]
    fn the_sibling_binary_is_used_without_a_path_lookup() {
        assert_eq!(
            barn_path(None, Path::new("/usr/local/bin/tack-daemon")),
            PathBuf::from("/usr/local/bin/barn")
        );
        assert_eq!(
            barn_path(Some(""), Path::new("/usr/local/bin/tack-daemon")),
            PathBuf::from("/usr/local/bin/barn")
        );
    }

    #[test]
    fn a_missing_barn_binary_is_the_named_deny() {
        assert_eq!(
            find_barn(None, Path::new("/no/such/tack/home/tack-daemon")),
            Err("tack: plugin unavailable: barn not found".to_owned())
        );
    }

    #[test]
    fn the_launch_returns_the_named_deny_to_the_caller() {
        let result = launch_stall_with(
            Some("/nonexistent/tack-test-barn"),
            &std::env::temp_dir(),
            Path::new("/state/tack"),
            test_broker(),
        )
        .map(|_| ());

        assert_eq!(
            result,
            Err("tack: plugin unavailable: barn not found".to_owned())
        );
    }

    #[test]
    fn every_pipe_error_carries_the_named_deny_prefix() {
        let cases = [
            (PipeError::Missing, "missing endpoint"),
            (PipeError::Malformed, "malformed endpoint"),
            (PipeError::Oversize, "oversize endpoint"),
            (PipeError::Protocol, "protocol mismatch"),
            (
                PipeError::Error("stall already running".to_owned()),
                "stall already running",
            ),
        ];

        for (error, reason) in cases {
            assert_eq!(
                format!("{error}"),
                format!("tack: plugin unavailable: {reason}")
            );
        }
    }

    #[test]
    fn the_barn_command_carries_the_tack_state_dir() {
        let launch = barn_launch(
            Path::new("/bin/barn"),
            Path::new("/plugins/demo"),
            4321,
            Path::new("/state/tack"),
        );

        assert_eq!(
            launch.args,
            vec![
                OsString::from("stall"),
                OsString::from("start"),
                OsString::from("--plugin"),
                OsString::from("/plugins/demo"),
                OsString::from("--daemon-pid"),
                OsString::from("4321"),
            ]
        );
        assert_eq!(launch.state_dir, PathBuf::from("/state/tack/barn"));
        assert_eq!(launch.stdout, ChildStream::Piped);
        assert_eq!(launch.stderr, ChildStream::Inherit);

        let command = launch.command();

        assert_eq!(command.get_program(), OsStr::new("/bin/barn"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            launch
                .args
                .iter()
                .map(OsString::as_os_str)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new(BARN_STATE_DIR_VAR))
                .and_then(|(_, value)| value)
                .map(OsStr::to_os_string),
            Some(OsString::from("/state/tack/barn"))
        );
    }

    static NEXT_SCRIPT: AtomicU64 = AtomicU64::new(0);

    // A concurrent fork inherits the script's write fd and can hit ETXTBSY.
    static SCRIPT_IO: std::sync::RwLock<()> = std::sync::RwLock::new(());

    const ENDPOINT: &str = r#"{"protocol":1,"socket_path":"/tmp/host.sock","token":"t"}"#;
    const ERROR_LINE: &str = r#"{"protocol":1,"error":"stall already running"}"#;

    struct Script(PathBuf);

    impl Script {
        fn new(body: &str) -> Self {
            let _write_guard = SCRIPT_IO.write().unwrap();
            let nanos = SystemTime::UNIX_EPOCH.elapsed().unwrap().as_nanos();
            let seq = NEXT_SCRIPT.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("tack-launch-{}-{nanos}-{seq}", std::process::id()));
            fs::create_dir(&dir).unwrap();

            let file = dir.join("barn");
            fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&file, Permissions::from_mode(0o755)).unwrap();

            Self(dir)
        }

        fn child(&self) -> Child {
            let mut command = Command::new(self.0.join("barn"));
            command
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .process_group(0);
            Self::spawn(&mut command)
        }

        fn spawn(command: &mut Command) -> Child {
            let _read_guard = SCRIPT_IO.read().unwrap();
            match command.spawn() {
                Ok(child) => child,
                Err(error) => panic!("barn spawn failed: {error}"),
            }
        }

        fn marker(&self) -> PathBuf {
            self.0.join("marker")
        }
    }

    impl Drop for Script {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn short_deadline() -> Instant {
        Instant::now()
            .checked_add(Duration::from_millis(250))
            .expect("the test budget is representable")
    }

    fn test_broker() -> Arc<dyn ControlBroker> {
        Arc::new(control::ControlBroker::new(
            control::LaunchIdentity::default(),
            Grants::default(),
            None,
        ))
    }

    fn assert_reaped(child: &mut Child) {
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn kill_and_wait_reaps_a_short_lived_child_within_its_budget() {
        let script = Script::new("exit 0");
        let mut child = script.child();
        let start = Instant::now();

        kill_and_wait(&mut child);

        assert!(start.elapsed() < Duration::from_secs(2));
        assert_reaped(&mut child);
    }

    #[test]
    fn a_never_exiting_poll_times_out_at_the_deadline() {
        let start = Instant::now();
        let deadline = start
            .checked_add(Duration::from_millis(500))
            .unwrap_or_else(Instant::now);

        let reaped = wait_bounded(|| -> io::Result<Option<ExitStatus>> { Ok(None) }, deadline);
        let elapsed = start.elapsed();

        assert_eq!(reaped, Reaped::Timeout);
        assert!(elapsed >= Duration::from_millis(500));
        assert!(elapsed < Duration::from_secs(2));
    }

    #[test]
    fn an_exit_after_two_empty_polls_is_reaped() {
        let status = ExitStatusExt::from_raw(0);
        let mut polls = 0;

        let reaped = wait_bounded(
            || -> io::Result<Option<ExitStatus>> {
                polls += 1;
                if polls < 3 {
                    Ok(None)
                } else {
                    Ok(Some(status))
                }
            },
            short_deadline(),
        );

        assert_eq!(reaped, Reaped::Exited(status));
    }

    #[test]
    fn reap_timed_out_distinguishes_timeout_from_exit() {
        use std::os::unix::process::ExitStatusExt;

        let exited = Reaped::Exited(ExitStatus::from_raw(0));

        assert!(reap_timed_out(Reaped::Timeout));
        assert!(!reap_timed_out(exited));
    }

    #[test]
    fn a_child_that_never_writes_is_a_named_missing() {
        let script = Script::new("sleep 5");
        let mut child = script.child();
        let start = Instant::now();

        let result = launch_from_child(&mut child, short_deadline(), test_broker()).map(|_| ());

        assert_eq!(result, Err(PipeError::Missing));
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_reaped(&mut child);
    }

    #[test]
    fn a_child_without_a_stdout_pipe_is_reaped() {
        let script = Script::new(
            r#"( sleep 1; touch "$(dirname "$0")/marker" ) &
sleep 5"#,
        );
        let mut command = Command::new(script.0.join("barn"));
        command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let mut child = Script::spawn(&mut command);

        let result = launch_from_child(&mut child, short_deadline(), test_broker()).map(|_| ());

        assert_eq!(result, Err(PipeError::Missing));

        thread::sleep(Duration::from_millis(1500));

        assert!(!script.marker().exists());
    }

    #[test]
    fn an_early_exit_without_a_line_is_missing() {
        let script = Script::new("exit 0");
        let mut child = script.child();
        let start = Instant::now();

        let result = launch_from_child(&mut child, short_deadline(), test_broker()).map(|_| ());

        assert_eq!(result, Err(PipeError::Missing));
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_reaped(&mut child);
    }

    #[test]
    fn a_valid_line_with_stdout_still_open_returns_promptly() {
        let script = Script::new(&format!("echo '{ENDPOINT}'\nsleep 5"));
        let mut child = script.child();
        let start = Instant::now();

        let result = launch_from_child(&mut child, short_deadline(), test_broker());

        assert!(result.is_ok());
        assert!(child.try_wait().unwrap().is_none());
        assert!(start.elapsed() < Duration::from_secs(2));
        kill_and_wait(&mut child);
    }

    #[test]
    fn an_error_line_with_a_zero_exit_is_malformed() {
        let script = Script::new(&format!("echo '{ERROR_LINE}'\nexit 0"));
        let mut child = script.child();

        let result = launch_from_child(&mut child, short_deadline(), test_broker()).map(|_| ());

        assert_eq!(result, Err(PipeError::Malformed));
        assert_reaped(&mut child);
    }

    #[test]
    fn an_error_line_with_a_failure_exit_keeps_the_reason() {
        let script = Script::new(&format!("echo '{ERROR_LINE}'\nexit 7"));
        let mut child = script.child();

        let result = launch_from_child(&mut child, short_deadline(), test_broker()).map(|_| ());

        assert_eq!(
            result,
            Err(PipeError::Error("stall already running".to_owned()))
        );
        assert_reaped(&mut child);
    }

    #[test]
    fn dropping_a_live_stall_stops_the_helper_group() {
        let script = Script::new(
            r#"( sleep 1; touch "$(dirname "$0")/marker" ) &
sleep 5"#,
        );
        let child = script.child();

        let stall = Stall::Host {
            client: host_client(
                HostEndpoint::new(PathBuf::from("/tmp/host.sock"), "t".to_owned()),
                test_broker(),
            ),
            child,
        };
        drop(stall);

        thread::sleep(Duration::from_millis(1500));

        assert!(!script.marker().exists());
    }

    #[test]
    fn an_error_line_reaps_the_helper_group() {
        let script = Script::new(&format!(
            r#"( sleep 1; touch "$(dirname "$0")/marker" ) &
echo '{ERROR_LINE}'
exit 7"#
        ));
        let mut child = script.child();

        let result = launch_from_child(&mut child, short_deadline(), test_broker()).map(|_| ());

        assert_eq!(
            result,
            Err(PipeError::Error("stall already running".to_owned()))
        );

        thread::sleep(Duration::from_millis(1500));

        assert!(!script.marker().exists());
    }

    #[test]
    fn an_error_line_timeout_reaps_the_helper_group() {
        let script = Script::new(&format!(
            r#"( sleep 1; touch "$(dirname "$0")/marker" ) &
echo '{ERROR_LINE}'
sleep 5"#
        ));
        let mut child = script.child();

        let result = launch_from_child(&mut child, short_deadline(), test_broker()).map(|_| ());

        assert_eq!(result, Err(PipeError::Malformed));

        thread::sleep(Duration::from_millis(1500));

        assert!(!script.marker().exists());
    }

    #[test]
    fn a_bare_or_relative_barn_name_is_not_resolved_through_path() {
        let exe = Path::new("/usr/local/bin/tack-daemon");
        let deny = Err("tack: plugin unavailable: barn not found".to_owned());

        assert_eq!(find_barn(Some("barn"), exe), deny);
        assert_eq!(find_barn(Some("bin/barn"), exe), deny);
        assert_eq!(find_barn(None, Path::new("tack-daemon")), deny);
    }

    #[test]
    fn a_plugin_must_be_an_absolute_existing_folder() {
        let valid = std::env::temp_dir();
        let deny = Err("tack: plugin unavailable: plugin path invalid".to_owned());

        assert_eq!(plugin_path(&valid), Ok(fs::canonicalize(&valid).unwrap()));
        assert_eq!(plugin_path(Path::new("plugins/demo")), deny);
        assert_eq!(plugin_path(&valid.join("no-such-tack-plugin")), deny);
    }

    #[test]
    fn a_plugin_file_is_rejected_and_a_folder_is_accepted() {
        let script = Script::new("exit 0");
        let file = script.0.join("barn");
        let deny = Err("tack: plugin unavailable: plugin path invalid".to_owned());

        assert!(file.is_absolute() && file.is_file());
        assert_eq!(plugin_path(&file), deny);
        assert_eq!(
            plugin_path(&script.0),
            Ok(fs::canonicalize(&script.0).unwrap())
        );
    }

    #[test]
    fn a_launch_failure_returns_a_named_deny() {
        let request = Request::Tool {
            id: 7,
            version: PROTOCOL_VERSION,
            name: "guard_status".into(),
            input: serde_json::json!({}),
        };

        let reply = handle(
            &request,
            &Mutex::new(Stall::Unavailable(
                "tack: plugin unavailable: barn not found".to_owned(),
            )),
        );

        assert_eq!(
            reply,
            Reply::Error {
                id: 7,
                version: PROTOCOL_VERSION,
                error: ReplyError::DaemonError,
                message: "tack: plugin unavailable: barn not found".to_owned(),
            }
        );
    }

    #[test]
    fn a_control_request_on_tack_sock_is_a_named_error() {
        let request = Request::Control {
            id: 9,
            version: PROTOCOL_VERSION,
            call: "navigate".into(),
            input: serde_json::json!({}),
        };

        let reply = handle(
            &request,
            &Mutex::new(Stall::Unavailable("a frame reached the stall".to_owned())),
        );

        assert_eq!(
            reply,
            Reply::Error {
                id: 9,
                version: PROTOCOL_VERSION,
                error: ReplyError::DaemonError,
                message: "unsupported_outcome".to_owned(),
            }
        );
    }

    #[test]
    fn grants_deny_undeclared_calls() {
        let text = r#"{"grants":{"host-grants":{"control":{"calls":["navigate"]}}}}"#;
        let grants = Grants::from_str(text).expect("one grant parses");

        assert_eq!(
            grants.authorize("plugin", &["control.call.navigate".to_owned()], "navigate"),
            Err(GrantError::Denied {
                plugin: "plugin".to_owned(),
                call: "navigate".to_owned(),
            })
        );
        assert_eq!(
            grants.authorize("host-grants", &[], "navigate"),
            Err(GrantError::Denied {
                plugin: "host-grants".to_owned(),
                call: "navigate".to_owned(),
            })
        );
    }

    #[test]
    #[ignore = "run only by the explicit CI 50x step"]
    fn launching_tests_hold_across_fifty_runs_in_ci() {
        for _ in 0..50 {
            a_child_that_never_writes_is_a_named_missing();
            an_error_line_reaps_the_helper_group();
            an_error_line_timeout_reaps_the_helper_group();
            a_child_without_a_stdout_pipe_is_reaped();
        }
    }
}
