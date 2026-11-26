//! Owner-only Unix-socket transport framed as newline-delimited JSON.
//!
//! A kernel `flock` in the state folder keeps two daemons from serving the
//! same socket. The kernel releases the lock when a daemon dies, so a living
//! daemon's lock or socket can never be removed by a second start.

use std::fmt;
use std::fs::{self, File, OpenOptions, Permissions, TryLockError};
use std::io::{self, ErrorKind, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rustix::process::geteuid;
use tack_protocol::wire::{self, MAX_PENDING, PROTOCOL_VERSION, Reply, ReplyError, Request};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::JoinSet;

const LOCK_FILE: &str = "tack.lock";
const MAX_REQUESTS_PER_CONNECTION: usize = 1000;
/// Hooks send one request per connection, so a little legitimate reuse fits
/// under this cap. A peer that pipelines more gets a named `busy` refusal, so
/// it cannot hold a slot indefinitely.
const MAX_FRAMES_PER_CONNECTION: usize = 4;
/// The message of every `busy` refusal: overflow and the frame cap alike.
const BUSY_MESSAGE: &str = "tack: busy";
/// How long one frame's reads, and each blocking write call of a reply, may
/// take before the connection gives up its slot. A stalled or dribbling peer,
/// or one that stops draining a reply, must release its slot well before a new
/// hook's own budget runs out, so a full set of slots cannot starve the next
/// request. `CONNECTION_LIFETIME` bounds the whole connection.
const CONNECTION_BUDGET: Duration = Duration::from_millis(750);
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
/// The absolute cap on one connection's I/O time, counted from its admission
/// with the handler's run time left out. It sits well below the hook's 8500 ms
/// whole-run budget, so no peer can pin a slot by making steady progress.
const CONNECTION_LIFETIME: Duration = Duration::from_millis(1500);

/// The read deadline of one frame: `CONNECTION_BUDGET` from now, falling back
/// to now if the clock cannot represent it.
fn frame_deadline() -> Instant {
    let now = Instant::now();

    now.checked_add(CONNECTION_BUDGET).unwrap_or(now)
}

/// When a connection admitted at `admitted` must end, falling back to
/// `admitted` if the clock cannot represent it.
fn lifetime_end(admitted: Instant) -> Instant {
    admitted
        .checked_add(CONNECTION_LIFETIME)
        .unwrap_or(admitted)
}

/// Failures from binding or serving the owner-only Unix socket.
#[derive(Debug, PartialEq, Eq)]
pub enum TransportError {
    /// Another daemon holds the start lock.
    LockBusy,
    /// The start lock could not be created or locked.
    LockIo,
    /// The state folder belongs to another user or is group/world writable.
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
    let mut file = OpenOptions::new()
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

    // Publish the owning pid so an external runner can find and stop this
    // daemon. Truncate after taking the lock so a stale, longer pid leaves no
    // tail behind.
    let pid = std::process::id().to_string();
    file.set_len(0).map_err(|_| TransportError::LockIo)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| TransportError::LockIo)?;
    file.write_all(pid.as_bytes())
        .map_err(|_| TransportError::LockIo)?;
    file.flush().map_err(|_| TransportError::LockIo)?;

    Ok(Lock { _file: file })
}

/// Create a missing state folder, or verify that an existing one is ours.
fn ensure_state_dir(state_dir: &Path) -> Result<(), TransportError> {
    match fs::metadata(state_dir) {
        Ok(meta) if meta.is_dir() => verify_state_dir(&meta),
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

/// A state folder is safe when it belongs to us and cannot be written by its
/// group or by other users, so nobody else can plant a socket inside it.
const fn state_dir_is_safe(uid: u32, mode: u32, euid: u32) -> bool {
    uid == euid && mode & 0o022 == 0
}

/// Verify an existing state folder using only its metadata and the effective
/// uid. No file is written inside the folder before the check.
fn verify_state_dir(meta: &fs::Metadata) -> Result<(), TransportError> {
    let euid = geteuid().as_raw();
    if state_dir_is_safe(meta.uid(), meta.mode(), euid) {
        Ok(())
    } else {
        Err(TransportError::StateNotOwned)
    }
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
///
/// # Errors
///
/// Returns [`TransportError::StateNotOwned`] when the state folder is unsafe,
/// [`TransportError::LockBusy`] or [`TransportError::LockIo`] when the start
/// lock cannot be taken, and [`TransportError::Bind`] when the socket cannot be
/// prepared or bound.
pub fn bind(state_dir: &Path, socket: &Path) -> Result<Server, TransportError> {
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
    /// `MAX_PENDING` in flight, and each handles at most
    /// `MAX_FRAMES_PER_CONNECTION` frames; `MAX_REQUESTS_PER_CONNECTION` is only
    /// a hard ceiling on its loop.
    /// A connection that finds every slot taken gets a `busy` error line at
    /// once, in one nonblocking write; the loop never waits for a slot or a peer.
    ///
    /// # Errors
    ///
    /// Returns [`TransportError::Io`] when the listener cannot be polled.
    pub async fn serve<F>(self, handle: F) -> Result<(), TransportError>
    where
        F: Fn(Request) -> Reply + Send + Sync + 'static,
    {
        let handle = Arc::new(handle);
        let mut connections = JoinSet::new();

        loop {
            // Free the slots of connections that ended since the last accept.
            while connections.try_join_next().is_some() {}

            let (stream, _) = match self.listener.accept().await {
                Ok(accepted) => accepted,
                Err(err) => {
                    eprintln!("tack-daemon: accept failed: {err}");
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                    continue;
                }
            };

            // Free the slots of connections that ended while accept waited.
            while connections.try_join_next().is_some() {}

            if connections.len() >= MAX_PENDING {
                // Inline and nonblocking, so no task outlives it.
                busy_reply(stream);
                continue;
            }

            let task_handle = Arc::clone(&handle);
            connections.spawn_blocking(move || run_connection(stream, &task_handle));
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

fn send_error(writer: &mut impl Write, error: ReplyError, message: &str) {
    if let Ok(encoded) = wire::encode_line(&error_reply(error, message)) {
        let _ = writer.write_all(&encoded);
    }
}

/// Answer a connection that found every slot taken with one `busy` error
/// line, written in a single nonblocking attempt. It reads nothing from the
/// peer and never waits, so the accept loop moves on at once. Any I/O failure,
/// a full socket buffer included, ends it silently.
fn busy_reply(stream: UnixStream) {
    let Ok(mut stream) = stream.into_std() else {
        return;
    };

    if stream.set_nonblocking(true).is_err() {
        return;
    }

    let Ok(encoded) = wire::encode_line(&error_reply(ReplyError::Busy, BUSY_MESSAGE)) else {
        return;
    };

    let _ = stream.write_all(&encoded);
}

/// Wraps a socket so every blocking read spends only the time left in the
/// current frame's read budget, rather than resetting a fresh timeout per read.
struct DeadlineReader<'a> {
    stream: &'a StdUnixStream,
    deadline: Instant,
}

impl<'a> DeadlineReader<'a> {
    const fn new(stream: &'a StdUnixStream, deadline: Instant) -> Self {
        Self { stream, deadline }
    }

    const fn set_deadline(&mut self, deadline: Instant) {
        self.deadline = deadline;
    }
}

impl Read for DeadlineReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                ErrorKind::TimedOut,
                "frame deadline exceeded",
            ));
        }

        // A timeval of zero means "no timeout" on Unix, so keep it positive.
        let remaining = remaining.max(Duration::from_millis(1));
        self.stream.set_read_timeout(Some(remaining))?;
        self.stream.read(buf)
    }
}

/// Wraps a socket so every blocking write call waits at most `per_call`, and
/// never past `deadline`, however slowly the peer drains it.
struct DeadlineWriter<'a> {
    stream: &'a StdUnixStream,
    per_call: Duration,
    deadline: Instant,
}

impl<'a> DeadlineWriter<'a> {
    const fn new(stream: &'a StdUnixStream, per_call: Duration, deadline: Instant) -> Self {
        Self {
            stream,
            per_call,
            deadline,
        }
    }

    const fn set_deadline(&mut self, deadline: Instant) {
        self.deadline = deadline;
    }
}

impl Write for DeadlineWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                ErrorKind::TimedOut,
                "connection lifetime exceeded",
            ));
        }

        // A timeval of zero means "no timeout" on Unix, so keep it positive.
        let timeout = remaining.min(self.per_call).max(Duration::from_millis(1));
        self.stream.set_write_timeout(Some(timeout))?;
        self.stream.write(buf)
    }

    /// Writes go straight to the socket, so there is nothing to flush.
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn run_connection<F>(stream: UnixStream, handle: &Arc<F>)
where
    F: Fn(Request) -> Reply + Send + Sync + 'static,
{
    let Ok(stream) = stream.into_std() else {
        return;
    };

    if stream.set_nonblocking(false).is_err() {
        return;
    }

    let mut admitted = Instant::now();
    let mut end = lifetime_end(admitted);

    // Each blocking write call of a reply waits at most one budget, and never
    // past the lifetime, so a peer that stops or barely drains a large reply
    // releases its slot.
    let mut writer = DeadlineWriter::new(&stream, CONNECTION_BUDGET, end);
    let mut reader = io::BufReader::new(DeadlineReader::new(&stream, frame_deadline().min(end)));

    for frame in 0..MAX_REQUESTS_PER_CONNECTION {
        // The connection ends at its lifetime, whatever progress the peer makes.
        if end.saturating_duration_since(Instant::now()).is_zero() {
            break;
        }

        // Each frame gets a fresh read budget, starting when the daemon waits
        // for it and shared by all of its reads, so a peer that dribbles bytes
        // or sits idle cannot keep one frame's reads open past CONNECTION_BUDGET.
        // The lifetime caps it too.
        reader.get_mut().set_deadline(frame_deadline().min(end));

        let line = match wire::read_line(&mut reader) {
            Ok(Some(line)) => line,
            Err(wire::WireError::TooLarge) => {
                send_error(&mut writer, ReplyError::TooLarge, "too_large");

                break;
            }
            Ok(None) | Err(_) => break,
        };

        // Past the frame cap the frame is refused, not handled, so pipelined
        // requests cannot keep the slot.
        if frame >= MAX_FRAMES_PER_CONNECTION {
            send_error(&mut writer, ReplyError::Busy, BUSY_MESSAGE);

            break;
        }

        let handled = Instant::now();
        let reply = serde_json::from_slice::<Request>(&line).map_or_else(
            |_| error_reply(ReplyError::Malformed, "malformed"),
            |request| handle(request),
        );

        // The handler's run time is the daemon's own, not the peer's, so the
        // I/O lifetime moves forward by it. The next frame's read deadline is
        // taken from the new end at the top of the loop.
        admitted = admitted.checked_add(handled.elapsed()).unwrap_or(admitted);
        end = lifetime_end(admitted);
        writer.set_deadline(end);

        let Ok(encoded) = wire::encode_line(&reply) else {
            break;
        };

        if writer.write_all(&encoded).is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use tack_protocol::wire::{Content, MAX_FRAME_BYTES, Outcome, ReplyError, ToolCall};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader as AsyncBufReader};

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

    #[derive(Debug, PartialEq, Eq)]
    struct DirSnapshot {
        entries: Vec<OsString>,
        mode: u32,
        uid: u32,
    }

    fn snapshot_dir(dir: &Path) -> io::Result<DirSnapshot> {
        let mut entries = fs::read_dir(dir)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<io::Result<Vec<_>>>()?;
        entries.sort();

        let meta = fs::metadata(dir)?;

        Ok(DirSnapshot {
            entries,
            mode: meta.mode() & 0o777,
            uid: meta.uid(),
        })
    }

    fn allow_all(request: &Request) -> Reply {
        match request {
            Request::Hook { id, .. } => Reply::Hook {
                id: *id,
                version: PROTOCOL_VERSION,
                outcome: Outcome::Allow,
            },
            Request::Tool { id, .. } => Reply::Tool {
                id: *id,
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

        let first = bind(&state, &socket);
        let second = bind(&state, &socket);

        let wins = [first.is_ok(), second.is_ok()];
        assert_eq!(wins.iter().filter(|won| **won).count(), 1);

        let ((Ok(_), Err(loser)) | (Err(loser), Ok(_))) = (&first, &second) else {
            panic!("one bind must lose the lock")
        };
        assert_eq!(loser, &TransportError::LockBusy);
    }

    #[tokio::test]
    async fn bind_into_a_fresh_nested_folder() {
        let dir = TempDir::new();
        let state = dir.path().join("a/b/c");
        let socket = state.join("tack.sock");

        let server = bind(&state, &socket).unwrap();
        assert!(socket.exists());

        drop(server);
    }

    #[tokio::test]
    async fn state_folder_and_socket_have_owner_only_modes() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let _server = bind(&state, &socket).unwrap();

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
        let _server = bind(&state, &socket).unwrap();
        let after = fs::metadata(&state).unwrap().permissions().mode() & 0o777;

        assert_eq!(before, after);
    }

    #[tokio::test]
    async fn unsafe_state_dir_is_refused_before_writing_anything() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        fs::create_dir(&state).unwrap();

        // A group- or world-writable folder is unsafe even when we own it.
        fs::set_permissions(&state, Permissions::from_mode(0o777)).unwrap();

        // The old uid probe created, truncated and removed this exact file
        // before checking ownership. Its bytes and every directory entry
        // must survive the refusal unchanged.
        let probe = state.join(format!(".tack-uid-{}", std::process::id()));
        let sentinel = b"do not touch".to_vec();
        fs::write(&probe, &sentinel).unwrap();

        let before = snapshot_dir(&state).unwrap();

        let err = bind(&state, &socket).unwrap_err();
        assert_eq!(err, TransportError::StateNotOwned);

        assert_eq!(
            fs::read(&probe).expect("the uid probe must not be touched"),
            sentinel
        );
        assert_eq!(snapshot_dir(&state).unwrap(), before);
    }

    #[tokio::test]
    async fn socket_outside_the_state_folder_is_refused() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = dir.path().join("elsewhere.sock");

        let err = bind(&state, &socket).unwrap_err();
        assert!(matches!(err, TransportError::Bind(_)));
    }

    #[tokio::test]
    async fn round_trips_a_hook_request() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).unwrap();

        let task = tokio::spawn(server.serve(|request| allow_all(&request)));

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
        let server = bind(&state, &socket).unwrap();

        let task = tokio::spawn(server.serve(|request| allow_all(&request)));

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
        let server = bind(&state, &socket).unwrap();

        let task = tokio::spawn(server.serve(|request| allow_all(&request)));

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

        let server = bind(&state, &socket).unwrap();
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

        let first = bind(&state, &socket).unwrap();
        drop(first);

        let second = bind(&state, &socket);
        assert!(second.is_ok());
    }

    #[tokio::test]
    async fn lock_file_holds_the_bind_process_id() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");

        let _server = bind(&state, &socket).unwrap();
        let lock = state.join(LOCK_FILE);
        let content = fs::read_to_string(&lock).unwrap();

        assert_eq!(content, std::process::id().to_string());
    }

    #[tokio::test]
    async fn a_stale_longer_pid_is_truncated_on_bind() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        fs::create_dir(&state).unwrap();
        fs::write(state.join(LOCK_FILE), b"999999999999").unwrap();

        let _server = bind(&state, &socket).unwrap();
        let content = fs::read_to_string(state.join(LOCK_FILE)).unwrap();

        assert_eq!(content, std::process::id().to_string());
    }

    #[test]
    fn state_dir_safety_checks_owner_and_mode() {
        let euid = 501;

        // Owned by us and not writable by group or others.
        assert!(state_dir_is_safe(euid, 0o700, euid));
        assert!(state_dir_is_safe(euid, 0o755, euid));

        // World-writable and group-writable folders are refused.
        assert!(!state_dir_is_safe(euid, 0o777, euid));
        assert!(!state_dir_is_safe(euid, 0o770, euid));

        // A folder owned by somebody else is refused.
        assert!(!state_dir_is_safe(0, 0o700, euid));
    }

    #[tokio::test]
    async fn a_partial_frame_is_bounded_by_the_connection_budget() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).unwrap();

        let task = tokio::spawn(server.serve(|request| allow_all(&request)));

        let mut client = UnixStream::connect(&socket).await.unwrap();
        client
            .write_all(b"partial-line-without-a-newline")
            .await
            .unwrap();
        client.flush().await.unwrap();

        let start = Instant::now();
        let mut buf = [0u8; 8];
        let read = tokio::time::timeout(Duration::from_millis(1500), client.read(&mut buf))
            .await
            .expect("connection did not end within the bound");

        // The connection's clock starts at accept, a moment before `start`,
        // so allow a small slack below the budget. The window from 650 ms to
        // 1250 ms pins a 750 ms budget: a budget near 2 s fails it.
        let slack = Duration::from_millis(100);
        assert_eq!(read.unwrap(), 0, "expected EOF at the connection budget");
        assert!(start.elapsed() >= CONNECTION_BUDGET.saturating_sub(slack));
        assert!(start.elapsed() < Duration::from_millis(1250));

        task.abort();
    }

    #[tokio::test]
    async fn an_overflow_connection_gets_a_named_busy_denial() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).unwrap();

        let task = tokio::spawn(server.serve(|request| allow_all(&request)));

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
        let allow = Reply::Hook {
            id: 7,
            version: PROTOCOL_VERSION,
            outcome: Outcome::Allow,
        };

        let mut control = UnixStream::connect(&socket).await.unwrap();
        control.write_all(&line).await.unwrap();
        control.flush().await.unwrap();

        let reply = tokio::time::timeout(Duration::from_secs(2), read_reply(control))
            .await
            .expect("idle server replies");
        assert_eq!(reply, allow);

        // Let the control connection's slot free before the peers take them all.
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Each peer connects in its own task and hands back its stream. Awaiting
        // every handle proves all 16 connects completed, so all 16 sit in the
        // accept queue ahead of the client below.
        let connecting: Vec<_> = (0..MAX_PENDING)
            .map(|_| {
                let socket = socket.clone();

                tokio::spawn(async move { UnixStream::connect(&socket).await.unwrap() })
            })
            .collect();

        let mut peers = Vec::with_capacity(MAX_PENDING);

        for connected in connecting {
            peers.push(connected.await.unwrap());
        }

        let mut held = Vec::with_capacity(MAX_PENDING);

        for mut peer in peers {
            let frame = line.clone();

            // A complete frame every 300 ms keeps each slot taken. Replies stay
            // unread, and write errors are ignored until the peer is aborted.
            held.push(tokio::spawn(async move {
                loop {
                    let _ = peer.write_all(&frame).await;
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
            }));
        }

        // The accept loop takes the 16 queued peers before this client and has
        // no slot left for it.
        let mut client = UnixStream::connect(&socket).await.unwrap();
        client.write_all(&line).await.unwrap();
        client.flush().await.unwrap();

        let reply = tokio::time::timeout(Duration::from_secs(5), read_reply(client))
            .await
            .expect("an overflow connection must get a busy denial");
        assert_eq!(
            reply,
            Reply::Error {
                id: 0,
                version: PROTOCOL_VERSION,
                error: ReplyError::Busy,
                message: "tack: busy".into(),
            }
        );

        for peer in held {
            peer.abort();
        }
        task.abort();
    }

    #[tokio::test]
    async fn a_new_client_is_denied_busy_while_dribbling_peers_hold_every_slot() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).unwrap();

        let task = tokio::spawn(server.serve(|request| allow_all(&request)));

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

        let mut dribblers = Vec::with_capacity(MAX_PENDING);

        for _ in 0..MAX_PENDING {
            let mut peer = UnixStream::connect(&socket).await.unwrap();

            // One byte every 300 ms until aborted. Writes fail once the
            // daemon closes the slot; the peer keeps going regardless.
            dribblers.push(tokio::spawn(async move {
                loop {
                    let _ = peer.write_all(b"x").await;
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
            }));
        }

        // Let the accept loop take every dribbling peer before the new client.
        tokio::time::sleep(Duration::from_millis(200)).await;

        let mut client = UnixStream::connect(&socket).await.unwrap();
        client.write_all(&line).await.unwrap();
        client.flush().await.unwrap();

        let reply = tokio::time::timeout(Duration::from_secs(2), read_reply(client))
            .await
            .expect("a new request must get a busy reply while 16 peers dribble bytes");
        assert_eq!(
            reply,
            Reply::Error {
                id: 0,
                version: PROTOCOL_VERSION,
                error: ReplyError::Busy,
                message: "tack: busy".into(),
            }
        );

        for dribbler in dribblers {
            dribbler.abort();
        }
        task.abort();
    }

    #[tokio::test]
    async fn a_connection_serves_two_frames_within_its_budget() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).unwrap();

        let task = tokio::spawn(server.serve(|request| allow_all(&request)));

        let hook_line = |id| {
            wire::encode_line(&Request::Hook {
                id,
                version: PROTOCOL_VERSION,
                hook: "toolBefore".into(),
                call: ToolCall {
                    tool: "shell".into(),
                    name: "shell".into(),
                    input: serde_json::json!({ "command": "ls" }),
                    session_id: None,
                },
            })
            .unwrap()
        };
        let allow = |id| Reply::Hook {
            id,
            version: PROTOCOL_VERSION,
            outcome: Outcome::Allow,
        };

        let mut client = UnixStream::connect(&socket).await.unwrap();
        client.write_all(&hook_line(7)).await.unwrap();
        client.write_all(&hook_line(8)).await.unwrap();
        client.flush().await.unwrap();

        let mut reader = AsyncBufReader::new(client);
        let replies = tokio::time::timeout(Duration::from_millis(1500), async {
            let mut replies = Vec::new();

            for _ in 0..2 {
                let mut buffer = Vec::new();
                reader.read_until(b'\n', &mut buffer).await.unwrap();
                replies.push(serde_json::from_slice::<Reply>(&buffer).unwrap());
            }

            replies
        })
        .await
        .expect("both frames are served within the connection budget");

        assert_eq!(replies, vec![allow(7), allow(8)]);

        task.abort();
    }

    #[tokio::test]
    async fn a_later_frame_gets_a_fresh_read_budget() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).unwrap();

        let task = tokio::spawn(server.serve(|request| allow_all(&request)));

        let hook_line = |id| {
            wire::encode_line(&Request::Hook {
                id,
                version: PROTOCOL_VERSION,
                hook: "toolBefore".into(),
                call: ToolCall {
                    tool: "shell".into(),
                    name: "shell".into(),
                    input: serde_json::json!({ "command": "ls" }),
                    session_id: None,
                },
            })
            .unwrap()
        };
        let allow = |id| Reply::Hook {
            id,
            version: PROTOCOL_VERSION,
            outcome: Outcome::Allow,
        };

        // The two 500 ms gaps total 1000 ms: above the 750 ms per-frame budget
        // but below the 1500 ms I/O lifetime. A read deadline fixed at accept
        // would end the connection before frame 8, so this proves each frame
        // gets a fresh budget, not that the lifetime expires.
        let gap = Duration::from_millis(500);
        let mut client = AsyncBufReader::new(UnixStream::connect(&socket).await.unwrap());

        for id in [7, 8] {
            tokio::time::sleep(gap).await;
            client.get_mut().write_all(&hook_line(id)).await.unwrap();
            client.get_mut().flush().await.unwrap();

            let mut buffer = Vec::new();
            tokio::time::timeout(
                Duration::from_secs(2),
                client.read_until(b'\n', &mut buffer),
            )
            .await
            .expect("each frame is served within its own budget")
            .unwrap();

            assert_eq!(serde_json::from_slice::<Reply>(&buffer).unwrap(), allow(id));
        }

        task.abort();
    }

    #[tokio::test]
    async fn a_peer_that_stops_reading_a_large_reply_releases_its_slot() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).unwrap();

        // About 900 KiB of text: far more than a socket buffer holds, and
        // still under MAX_FRAME_BYTES once encoded.
        let large = |id| Reply::Tool {
            id,
            version: PROTOCOL_VERSION,
            content: vec![Content {
                kind: "text".into(),
                text: "x".repeat(900 * 1024),
            }],
        };
        let task = tokio::spawn(server.serve(move |request| match request {
            Request::Tool { id, .. } => large(id),
            hook @ Request::Hook { .. } => allow_all(&hook),
        }));

        let full = wire::encode_line(&large(9)).unwrap();
        let request = wire::encode_line(&Request::Tool {
            id: 9,
            version: PROTOCOL_VERSION,
            name: "dump".into(),
            input: serde_json::json!({}),
        })
        .unwrap();

        let mut client = UnixStream::connect(&socket).await.unwrap();
        client.write_all(&request).await.unwrap();
        client.flush().await.unwrap();

        // Read nothing while the daemon's writes give up. A write call that
        // sends part of the reply returns when its budget ends, and the next
        // one waits one more budget with no progress: 1.5 s at most.
        tokio::time::sleep(Duration::from_secs(2)).await;

        let mut received = Vec::new();
        tokio::time::timeout(Duration::from_secs(1), client.read_to_end(&mut received))
            .await
            .expect("the daemon closed the connection")
            .unwrap();

        assert!(received.len() < full.len(), "the reply must be cut short");
        assert_eq!(received.as_slice(), &full[..received.len()]);

        task.abort();
    }

    #[tokio::test]
    async fn a_peer_making_steady_progress_cannot_hold_a_slot_past_its_lifetime() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).unwrap();

        let task = tokio::spawn(server.serve(|request| allow_all(&request)));

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

        let mut peers = Vec::with_capacity(MAX_PENDING);

        for _ in 0..MAX_PENDING {
            let mut peer = UnixStream::connect(&socket).await.unwrap();
            let frame = line.clone();

            // A complete frame every 600 ms, inside the frame budget, until
            // aborted. Frames land at 0, 600 and 1200 ms, so only the lifetime
            // can end the connection before the 17th client at 1800 ms: the
            // frame cap would not refuse until the fifth frame, at 2400 ms.
            // Replies stay unread; writes fail once the daemon ends the
            // connection, and the peer keeps going regardless.
            peers.push(tokio::spawn(async move {
                loop {
                    let _ = peer.write_all(&frame).await;
                    tokio::time::sleep(Duration::from_millis(600)).await;
                }
            }));
        }

        // Outlast every peer's lifetime, so their slots must have freed.
        tokio::time::sleep(CONNECTION_LIFETIME.saturating_add(Duration::from_millis(300))).await;

        let mut client = UnixStream::connect(&socket).await.unwrap();
        client.write_all(&line).await.unwrap();
        client.flush().await.unwrap();

        let reply = tokio::time::timeout(Duration::from_secs(2), read_reply(client))
            .await
            .expect("a new request must be served once every lifetime has passed");
        assert_eq!(
            reply,
            Reply::Hook {
                id: 7,
                version: PROTOCOL_VERSION,
                outcome: Outcome::Allow,
            }
        );

        for peer in peers {
            peer.abort();
        }
        task.abort();
    }

    #[tokio::test]
    async fn busy_reply_writes_a_busy_line_without_reading() {
        let (daemon, client) = UnixStream::pair().unwrap();
        let expected = wire::encode_line(&Reply::Error {
            id: 0,
            version: PROTOCOL_VERSION,
            error: ReplyError::Busy,
            message: "tack: busy".into(),
        })
        .unwrap();

        // The client sends nothing: the busy line must not wait on the peer.
        busy_reply(daemon);

        let mut reader = AsyncBufReader::new(client);
        let mut line = Vec::new();
        tokio::time::timeout(Duration::from_secs(1), reader.read_until(b'\n', &mut line))
            .await
            .expect("the busy line arrives without the peer sending anything")
            .unwrap();

        assert_eq!(line, expected);
    }

    #[tokio::test]
    async fn handler_time_is_left_out_of_the_io_lifetime() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).unwrap();

        // Each call outlasts CONNECTION_LIFETIME on its own, so a lifetime that
        // counted handler time would end the connection before any reply.
        let task = tokio::spawn(server.serve(|request| {
            std::thread::sleep(Duration::from_millis(1600));
            allow_all(&request)
        }));

        let hook_line = |id| {
            wire::encode_line(&Request::Hook {
                id,
                version: PROTOCOL_VERSION,
                hook: "toolBefore".into(),
                call: ToolCall {
                    tool: "shell".into(),
                    name: "shell".into(),
                    input: serde_json::json!({ "command": "ls" }),
                    session_id: None,
                },
            })
            .unwrap()
        };
        let allow = |id| Reply::Hook {
            id,
            version: PROTOCOL_VERSION,
            outcome: Outcome::Allow,
        };

        let mut client = AsyncBufReader::new(UnixStream::connect(&socket).await.unwrap());

        for id in [7, 8] {
            client.get_mut().write_all(&hook_line(id)).await.unwrap();
            client.get_mut().flush().await.unwrap();

            let mut buffer = Vec::new();
            tokio::time::timeout(
                Duration::from_secs(3),
                client.read_until(b'\n', &mut buffer),
            )
            .await
            .expect("a slow handler's reply still arrives on the same connection")
            .unwrap();

            assert_eq!(serde_json::from_slice::<Reply>(&buffer).unwrap(), allow(id));
        }

        task.abort();
    }

    #[tokio::test]
    async fn a_fifth_frame_on_one_connection_gets_a_named_busy_refusal() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).unwrap();

        let task = tokio::spawn(server.serve(|request| allow_all(&request)));

        let hook_line = |id| {
            wire::encode_line(&Request::Hook {
                id,
                version: PROTOCOL_VERSION,
                hook: "toolBefore".into(),
                call: ToolCall {
                    tool: "shell".into(),
                    name: "shell".into(),
                    input: serde_json::json!({ "command": "ls" }),
                    session_id: None,
                },
            })
            .unwrap()
        };
        let allow = |id| Reply::Hook {
            id,
            version: PROTOCOL_VERSION,
            outcome: Outcome::Allow,
        };

        let mut client = UnixStream::connect(&socket).await.unwrap();

        for id in 1..=5 {
            client.write_all(&hook_line(id)).await.unwrap();
        }

        client.flush().await.unwrap();

        // read_to_end returns only at EOF, so the daemon must close after the
        // refusal.
        let mut received = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut received))
            .await
            .expect("the connection ends after the refusal")
            .unwrap();

        let replies: Vec<Reply> = received
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();

        assert_eq!(
            replies,
            vec![
                allow(1),
                allow(2),
                allow(3),
                allow(4),
                Reply::Error {
                    id: 0,
                    version: PROTOCOL_VERSION,
                    error: ReplyError::Busy,
                    message: "tack: busy".into(),
                },
            ]
        );

        task.abort();
    }

    #[tokio::test]
    async fn a_slow_but_progressing_frame_is_handled() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).unwrap();

        let task = tokio::spawn(server.serve(|request| allow_all(&request)));

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

        // Six chunks with a 200 ms gap before each one after the first: the
        // frame takes about 1 s to arrive, past the 750 ms frame budget, but
        // every gap is short and the peer keeps making progress.
        let mut client = UnixStream::connect(&socket).await.unwrap();

        for (index, chunk) in line.chunks(line.len().div_ceil(6)).enumerate() {
            if index > 0 {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }

            client.write_all(chunk).await.unwrap();
            client.flush().await.unwrap();
        }

        let reply = tokio::time::timeout(Duration::from_secs(3), read_reply(client))
            .await
            .expect("a frame that keeps making progress is handled");
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
    async fn an_overflow_client_sending_a_large_request_still_gets_busy() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let socket = state.join("tack.sock");
        let server = bind(&state, &socket).unwrap();

        let task = tokio::spawn(server.serve(|request| allow_all(&request)));

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

        // About 900 KiB of input: far more than a socket buffer holds, and
        // still under MAX_FRAME_BYTES once encoded.
        let large = wire::encode_line(&Request::Tool {
            id: 9,
            version: PROTOCOL_VERSION,
            name: "dump".into(),
            input: serde_json::json!({ "text": "x".repeat(900 * 1024) }),
        })
        .unwrap();
        assert!(large.len() < MAX_FRAME_BYTES);

        // Each peer connects in its own task and hands back its stream. Awaiting
        // every handle proves all 16 connects completed, so all 16 sit in the
        // accept queue ahead of the client below.
        let connecting: Vec<_> = (0..MAX_PENDING)
            .map(|_| {
                let socket = socket.clone();

                tokio::spawn(async move { UnixStream::connect(&socket).await.unwrap() })
            })
            .collect();

        let mut peers = Vec::with_capacity(MAX_PENDING);

        for connected in connecting {
            peers.push(connected.await.unwrap());
        }

        let mut held = Vec::with_capacity(MAX_PENDING);

        for mut peer in peers {
            let frame = line.clone();

            // A complete frame every 300 ms keeps each slot taken. Replies stay
            // unread, and write errors are ignored until the peer is aborted.
            held.push(tokio::spawn(async move {
                loop {
                    let _ = peer.write_all(&frame).await;
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
            }));
        }

        // The accept loop takes the 16 queued peers before this client and has
        // no slot left for it. The whole request must go through, and the busy
        // line must follow, though the daemon never handles the request.
        let mut client = UnixStream::connect(&socket).await.unwrap();

        let reply = tokio::time::timeout(Duration::from_secs(5), async {
            client
                .write_all(&large)
                .await
                .expect("the overflow client can send its whole request");
            client.flush().await.unwrap();

            read_reply(client).await
        })
        .await
        .expect("an overflow client with a large request must get a busy denial");
        assert_eq!(
            reply,
            Reply::Error {
                id: 0,
                version: PROTOCOL_VERSION,
                error: ReplyError::Busy,
                message: "tack: busy".into(),
            }
        );

        for peer in held {
            peer.abort();
        }
        task.abort();
    }
}
