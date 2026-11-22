//! Owner-only Unix-socket transport framed as newline-delimited JSON.
//!
//! A kernel `flock` in the state folder keeps two daemons from serving the
//! same socket. The kernel releases the lock when a daemon dies, so a living
//! daemon's lock or socket can never be removed by a second start.

use std::fmt;
use std::fs::{self, File, OpenOptions, Permissions, TryLockError};
use std::io::{self, ErrorKind, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tack_protocol::wire::{self, MAX_PENDING, PROTOCOL_VERSION, Reply, ReplyError, Request};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::JoinSet;

const LOCK_FILE: &str = "tack.lock";
const MAX_REQUESTS_PER_CONNECTION: usize = 1000;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

/// Failures from binding or serving the owner-only Unix socket.
#[derive(Debug)]
pub enum TransportError {
    /// Another daemon holds the start lock.
    LockBusy,
    /// The start lock could not be created or locked.
    LockIo,
    /// The state folder belongs to another user.
    StateNotOwned,
    /// The socket could not be prepared or bound.
    Bind(String),
    /// A socket read or write failed.
    Io,
    /// A frame could not be framed or decoded.
    Malformed,
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LockBusy => write!(f, "lock_busy"),
            Self::LockIo => write!(f, "lock_io"),
            Self::StateNotOwned => write!(f, "state_not_owned"),
            Self::Bind(context) => write!(f, "bind({context})"),
            Self::Io => write!(f, "io"),
            Self::Malformed => write!(f, "malformed"),
        }
    }
}

impl std::error::Error for TransportError {}

/// The held kernel lock. Keeping the descriptor open keeps the flock held.
#[derive(Debug)]
struct Lock {
    _file: File,
}

fn acquire_lock(lock_path: &Path) -> Result<Lock, TransportError> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|_| TransportError::LockIo)?;

    // The flock is held by the descriptor until it closes, which the kernel
    // does when the daemon exits. No guard and no stale-lock cleanup is needed.
    file.try_lock().map_err(|err| match err {
        TryLockError::WouldBlock => TransportError::LockBusy,
        TryLockError::Error(_) => TransportError::LockIo,
    })?;

    Ok(Lock { _file: file })
}

/// Create a missing state folder, or verify that an existing one is ours.
fn ensure_state_dir(state_dir: &Path) -> Result<(), TransportError> {
    match fs::metadata(state_dir) {
        Ok(meta) if meta.is_dir() => verify_owner(state_dir, &meta),
        Ok(_) => Err(TransportError::Bind(format!(
            "{} is not a directory",
            state_dir.display()
        ))),
        Err(err) if err.kind() == ErrorKind::NotFound => fs::DirBuilder::new()
            .mode(0o700)
            .recursive(true)
            .create(state_dir)
            .map_err(|err| TransportError::Bind(format!("create {}: {err}", state_dir.display()))),
        Err(err) => Err(TransportError::Bind(format!(
            "stat {}: {err}",
            state_dir.display()
        ))),
    }
}

/// A file created in a directory belongs to the creating user unless the
/// directory is setgid, which tack never sets. Comparing its uid with the
/// folder's uid detects a folder owned by somebody else without a dependency.
fn verify_owner(state_dir: &Path, meta: &fs::Metadata) -> Result<(), TransportError> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let probe = state_dir.join(format!(".tack-owner-{}-{nanos}", std::process::id()));

    let created = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|err| TransportError::Bind(format!("probe {}: {err}", probe.display())))?;
    drop(created);

    let probe_uid = fs::metadata(&probe)
        .map(|probe_meta| probe_meta.uid())
        .map_err(|err| TransportError::Bind(format!("stat {}: {err}", probe.display())))?;
    let _ = fs::remove_file(&probe);

    if probe_uid != meta.uid() {
        return Err(TransportError::StateNotOwned);
    }

    Ok(())
}

fn prepare_socket(socket: &Path) -> Result<(), TransportError> {
    match fs::remove_file(socket) {
        Ok(()) => {}
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => {
            return Err(TransportError::Bind(format!(
                "unlink {}: {err}",
                socket.display()
            )));
        }
    }

    Ok(())
}

/// A bound Unix listener together with the kernel lock that guards it.
#[derive(Debug)]
pub struct Server {
    listener: UnixListener,
    socket: PathBuf,
    _lock: Lock,
}

/// Bind the owner-only socket inside a verified state folder.
pub async fn bind(state_dir: &Path, socket: &Path) -> Result<Server, TransportError> {
    ensure_state_dir(state_dir)?;

    let canonical_state = fs::canonicalize(state_dir)
        .map_err(|err| TransportError::Bind(format!("resolve {}: {err}", state_dir.display())))?;
    let parent = socket
        .parent()
        .ok_or_else(|| TransportError::Bind("socket path has no parent".into()))?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|err| TransportError::Bind(format!("resolve {}: {err}", parent.display())))?;
    if canonical_parent != canonical_state {
        return Err(TransportError::Bind(
            "socket must live directly in the state dir".into(),
        ));
    }

    let lock = acquire_lock(&canonical_state.join(LOCK_FILE))?;
    prepare_socket(socket)?;

    let listener = UnixListener::bind(socket)
        .map_err(|err| TransportError::Bind(format!("bind {}: {err}", socket.display())))?;

    fs::set_permissions(socket, Permissions::from_mode(0o600))
        .map_err(|err| TransportError::Bind(format!("chmod {}: {err}", socket.display())))?;

    Ok(Server {
        listener,
        socket: socket.to_path_buf(),
        _lock: lock,
    })
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket);
    }
}

impl Server {
    /// Serve requests until the listener fails. Connections are bounded by
    /// `MAX_PENDING` in flight, and each by `MAX_REQUESTS_PER_CONNECTION` frames.
    pub async fn serve<F>(self, handle: F) -> Result<(), TransportError>
    where
        F: Fn(Request) -> Reply + Send + Sync + 'static,
    {
        let handle = Arc::new(handle);
        let mut connections = JoinSet::new();

        loop {
            while connections.len() >= MAX_PENDING {
                let _ = connections.join_next().await;
            }

            let (stream, _) = match self.listener.accept().await {
                Ok(accepted) => accepted,
                Err(err) => {
                    eprintln!("tack-daemon: accept failed: {err}");
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                    continue;
                }
            };

            let task_handle = Arc::clone(&handle);
            connections.spawn_blocking(move || run_connection(stream, task_handle));
        }
    }
}

fn error_reply(error: ReplyError, message: &str) -> Reply {
    Reply::Error {
        id: 0,
        version: PROTOCOL_VERSION,
        error,
        message: message.into(),
    }
}

fn send_error(writer: &mut StdUnixStream, error: ReplyError, message: &str) {
    if let Ok(encoded) = wire::encode_line(&error_reply(error, message)) {
        if writer.write_all(&encoded).is_err() {
            return;
        }
        let _ = writer.flush();
    }
}

fn run_connection<F>(stream: UnixStream, handle: Arc<F>)
where
    F: Fn(Request) -> Reply + Send + Sync + 'static,
{
    let stream = match stream.into_std() {
        Ok(stream) => stream,
        Err(_) => return,
    };

    if stream.set_nonblocking(false).is_err()
        || stream.set_read_timeout(Some(IO_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(IO_TIMEOUT)).is_err()
    {
        return;
    }

    let mut writer = match stream.try_clone() {
        Ok(writer) => writer,
        Err(_) => return,
    };
    let mut reader = io::BufReader::new(stream);

    for _ in 0..MAX_REQUESTS_PER_CONNECTION {
        let line = match wire::read_line(&mut reader) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(wire::WireError::TooLarge) => {
                send_error(&mut writer, ReplyError::TooLarge, "too_large");

                break;
            }
            Err(_) => break,
        };

        let reply = match serde_json::from_slice::<Request>(&line) {
            Ok(request) => handle(request),
            Err(_) => error_reply(ReplyError::Malformed, "malformed"),
        };

        let encoded = match wire::encode_line(&reply) {
            Ok(encoded) => encoded,
            Err(_) => break,
        };

        if writer.write_all(&encoded).is_err() || writer.flush().is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use tack_protocol::wire::{MAX_FRAME_BYTES, Outcome, ReplyError, ToolCall};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};

    use super::*;

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let seq = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                % 1_000_000_000;
            let path =
                std::env::temp_dir().join(format!("tack-tr-{}-{nanos}-{seq}", std::process::id()));

            fs::create_dir_all(&path).unwrap();

            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn allow_all(request: Request) -> Reply {
        match request {
            Request::Hook { id, .. } => Reply::Hook {
                id,
                version: PROTOCOL_VERSION,
                outcome: Outcome::Allow,
            },
            Request::Tool { id, .. } => Reply::Tool {
                id,
                version: PROTOCOL_VERSION,
                content: vec![],
            },
        }
    }

    async fn read_reply(client: UnixStream) -> Reply {
        let mut reader = AsyncBufReader::new(client);
        let mut buffer = Vec::new();

        reader.read_until(b'\n', &mut buffer).await.unwrap();

        serde_json::from_slice(&buffer).unwrap()
    }

    #[tokio::test]
    async fn concurrent_binds_contend_for_the_lock() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");

        let (first, second) = tokio::join!(bind(&state, &socket), bind(&state, &socket));

        let wins = [first.is_ok(), second.is_ok()];
        assert_eq!(wins.iter().filter(|won| **won).count(), 1);

        let loser_is_busy = match (&first, &second) {
            (Ok(_), Err(err)) | (Err(err), Ok(_)) => matches!(err, TransportError::LockBusy),
            _ => false,
        };
        assert!(loser_is_busy);
    }

    #[tokio::test]
    async fn bind_into_a_fresh_nested_folder() {
        let dir = TempDir::new();
        let state = dir.path().join("a/b/c");
        let socket = state.join("tack.sock");

        let server = bind(&state, &socket).await.unwrap();
        assert!(socket.exists());

        drop(server);
    }

    #[tokio::test]
    async fn state_folder_and_socket_have_owner_only_modes() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let _server = bind(&state, &socket).await.unwrap();

        let socket_mode = fs::metadata(&socket).unwrap().permissions().mode() & 0o777;
        let state_mode = fs::metadata(&state).unwrap().permissions().mode() & 0o777;

        assert_eq!(socket_mode, 0o600);
        assert_eq!(state_mode, 0o700);
    }

    #[tokio::test]
    async fn existing_state_folder_is_not_chmodded() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        fs::create_dir(&state).unwrap();

        let before = fs::metadata(&state).unwrap().permissions().mode() & 0o777;
        let _server = bind(&state, &socket).await.unwrap();
        let after = fs::metadata(&state).unwrap().permissions().mode() & 0o777;

        assert_eq!(before, after);
    }

    #[tokio::test]
    async fn socket_outside_the_state_folder_is_refused() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = dir.path().join("elsewhere.sock");

        let err = bind(&state, &socket).await.unwrap_err();
        assert!(matches!(err, TransportError::Bind(_)));
    }

    #[tokio::test]
    async fn round_trips_a_hook_request() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).await.unwrap();

        let task = tokio::spawn(server.serve(allow_all));

        let mut client = UnixStream::connect(&socket).await.unwrap();
        let line = wire::encode_line(&Request::Hook {
            id: 7,
            version: PROTOCOL_VERSION,
            hook: "toolBefore".into(),
            call: ToolCall {
                tool: "shell".into(),
                name: "shell".into(),
                input: serde_json::json!({ "command": "ls" }),
                session_id: None,
            },
        })
        .unwrap();

        client.write_all(&line).await.unwrap();
        client.flush().await.unwrap();

        let reply = read_reply(client).await;
        assert_eq!(
            reply,
            Reply::Hook {
                id: 7,
                version: PROTOCOL_VERSION,
                outcome: Outcome::Allow,
            }
        );

        task.abort();
    }

    #[tokio::test]
    async fn malformed_frame_gets_a_typed_malformed_reply() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).await.unwrap();

        let task = tokio::spawn(server.serve(allow_all));

        let mut client = UnixStream::connect(&socket).await.unwrap();
        client.write_all(b"not json\n").await.unwrap();
        client.flush().await.unwrap();

        let reply = read_reply(client).await;
        assert_eq!(
            reply,
            Reply::Error {
                id: 0,
                version: PROTOCOL_VERSION,
                error: ReplyError::Malformed,
                message: "malformed".into(),
            }
        );

        task.abort();
    }

    #[tokio::test]
    async fn oversized_frame_gets_a_typed_too_large_reply() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).await.unwrap();

        let task = tokio::spawn(server.serve(allow_all));

        let mut client = UnixStream::connect(&socket).await.unwrap();
        let mut frame = vec![b'x'; MAX_FRAME_BYTES + 1];
        frame.push(b'\n');
        client.write_all(&frame).await.unwrap();
        client.flush().await.unwrap();

        let reply = read_reply(client).await;
        assert_eq!(
            reply,
            Reply::Error {
                id: 0,
                version: PROTOCOL_VERSION,
                error: ReplyError::TooLarge,
                message: "too_large".into(),
            }
        );

        task.abort();
    }

    #[tokio::test]
    async fn dropping_server_removes_only_its_socket() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let lock = state.join(LOCK_FILE);
        let foreign = state.join("keep-me");
        fs::create_dir_all(&state).unwrap();
        fs::write(&foreign, b"keep").unwrap();

        let server = bind(&state, &socket).await.unwrap();
        assert!(socket.exists());
        assert!(lock.exists());

        drop(server);

        assert!(!socket.exists());
        assert!(lock.exists());
        assert!(foreign.exists());
    }

    #[tokio::test]
    async fn lock_is_released_when_the_server_drops() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");

        let first = bind(&state, &socket).await.unwrap();
        drop(first);

        let second = bind(&state, &socket).await;
        assert!(second.is_ok());
    }

    #[tokio::test]
    async fn a_state_folder_owned_by_another_user_is_refused() {
        let ours = TempDir::new();
        let probe = ours.path().join("probe");
        fs::write(&probe, b"").unwrap();
        let our_uid = fs::metadata(&probe).unwrap().uid();

        // macOS keeps a root-owned, world-writable /private/tmp. We cannot
        // chown a folder as an unprivileged user, so this is the only folder
        // with a foreign uid that tack is still able to write a probe into.
        let state = Path::new("/private/tmp");
        let Ok(meta) = fs::metadata(state) else {
            return;
        };
        if meta.uid() == our_uid || meta.permissions().mode() & 0o002 == 0 {
            return;
        }

        let socket = state.join(format!("tack-sock-{}", std::process::id()));
        let err = bind(state, &socket).await.unwrap_err();
        assert!(matches!(err, TransportError::StateNotOwned));
    }
}
