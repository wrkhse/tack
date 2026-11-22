//! Owner-only Unix-socket transport framed as newline-delimited JSON.
//!
//! An `O_EXCL` lock file in the state folder keeps two daemons from serving
//! the same socket. The lock and socket are removed when the server drops.

use std::fmt;
use std::fs::{self, OpenOptions, Permissions};
use std::io::{self, ErrorKind, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use tack_protocol::wire::{self, MAX_FRAME_BYTES, MAX_PENDING, Reply, Request};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::JoinSet;

const LOCK_STALE_AFTER: Duration = Duration::from_secs(10);
const MAX_REQUESTS_PER_CONNECTION: usize = 1000;

/// Failures from binding or serving the owner-only Unix socket.
#[derive(Debug)]
pub enum TransportError {
    /// Another daemon holds the start lock.
    LockBusy,
    /// The start lock could not be created, read or removed.
    LockIo,
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
            Self::Bind(context) => write!(f, "bind({context})"),
            Self::Io => write!(f, "io"),
            Self::Malformed => write!(f, "malformed"),
        }
    }
}

impl std::error::Error for TransportError {}

/// The held `O_EXCL` lock; keeping the file open keeps the lock visible.
struct Lock {
    path: PathBuf,
    _file: fs::File,
}

/// A bound Unix listener together with the start lock that guards it.
///
/// Both the socket and the lock are removed when this value is dropped.
pub struct Server {
    listener: UnixListener,
    socket: PathBuf,
    lock: Lock,
}

fn lock_age(lock_path: &Path) -> Result<Duration, TransportError> {
    let modified = fs::metadata(lock_path)
        .and_then(|meta| meta.modified())
        .map_err(|_| TransportError::LockIo)?;

    Ok(SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default())
}

fn retry_stale_lock(lock_path: &Path) -> Result<fs::File, TransportError> {
    let age = lock_age(lock_path)?;

    if age < LOCK_STALE_AFTER {
        return Err(TransportError::LockBusy);
    }

    fs::remove_file(lock_path).map_err(|_| TransportError::LockIo)?;

    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)
        .map_err(|err| {
            if err.kind() == ErrorKind::AlreadyExists {
                TransportError::LockBusy
            } else {
                TransportError::LockIo
            }
        })
}

fn acquire_lock(lock_path: &Path) -> Result<Lock, TransportError> {
    let created = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path);

    let mut file = match created {
        Ok(file) => file,
        Err(err) if err.kind() == ErrorKind::AlreadyExists => retry_stale_lock(lock_path)?,
        Err(_) => return Err(TransportError::LockIo),
    };

    write!(file, "{}", std::process::id()).map_err(|_| TransportError::LockIo)?;

    Ok(Lock {
        path: lock_path.to_path_buf(),
        _file: file,
    })
}

fn prepare_socket(socket: &Path) -> Result<(), TransportError> {
    let parent = socket
        .parent()
        .ok_or_else(|| TransportError::Bind("socket path has no parent".into()))?;

    fs::create_dir_all(parent)
        .map_err(|err| TransportError::Bind(format!("create {}: {err}", parent.display())))?;
    fs::set_permissions(parent, Permissions::from_mode(0o700))
        .map_err(|err| TransportError::Bind(format!("chmod {}: {err}", parent.display())))?;

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

/// Bind the owner-only socket, guarding the bind with an exclusive start lock.
pub async fn bind(socket: &Path, lock_path: &Path) -> Result<Server, TransportError> {
    let lock = acquire_lock(lock_path)?;

    prepare_socket(socket)?;

    let listener = UnixListener::bind(socket)
        .map_err(|err| TransportError::Bind(format!("bind {}: {err}", socket.display())))?;

    fs::set_permissions(socket, Permissions::from_mode(0o600))
        .map_err(|err| TransportError::Bind(format!("chmod {}: {err}", socket.display())))?;

    Ok(Server {
        listener,
        socket: socket.to_path_buf(),
        lock,
    })
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.lock.path);
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

            let (stream, _) = self
                .listener
                .accept()
                .await
                .map_err(|_| TransportError::Io)?;

            let task_handle = Arc::clone(&handle);
            connections.spawn_blocking(move || run_connection(stream, task_handle));
        }
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

    if stream.set_nonblocking(false).is_err() {
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
            Err(_) => break,
        };

        if line.len() > MAX_FRAME_BYTES {
            break;
        }

        let reply = match serde_json::from_slice::<Request>(&line) {
            Ok(request) => handle(request),
            Err(_) => Reply::Error {
                id: 0,
                message: "malformed_reply".into(),
            },
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

    use tack_protocol::wire::{Outcome, ToolCall};
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
                outcome: Outcome::Allow,
            },
            Request::Tool { id, .. } => Reply::Tool {
                id,
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
        let socket = dir.path().join("s");
        let lock = dir.path().join("s.lock");

        let (first, second) = tokio::join!(bind(&socket, &lock), bind(&socket, &lock));

        let wins = [first.is_ok(), second.is_ok()];
        assert_eq!(wins.iter().filter(|won| **won).count(), 1);

        let loser_is_busy = match (&first, &second) {
            (Ok(_), Err(err)) | (Err(err), Ok(_)) => matches!(err, TransportError::LockBusy),
            _ => false,
        };
        assert!(loser_is_busy);
    }

    #[tokio::test]
    async fn round_trips_a_hook_request() {
        let dir = TempDir::new();
        let socket = dir.path().join("s");
        let lock = dir.path().join("s.lock");
        let server = bind(&socket, &lock).await.unwrap();

        let task = tokio::spawn(server.serve(allow_all));

        let mut client = UnixStream::connect(&socket).await.unwrap();
        let line = wire::encode_line(&Request::Hook {
            id: 7,
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
        assert!(matches!(
            reply,
            Reply::Hook {
                id: 7,
                outcome: Outcome::Allow
            }
        ));

        task.abort();
    }

    #[tokio::test]
    async fn malformed_frame_gets_a_named_error() {
        let dir = TempDir::new();
        let socket = dir.path().join("s");
        let lock = dir.path().join("s.lock");
        let server = bind(&socket, &lock).await.unwrap();

        let task = tokio::spawn(server.serve(allow_all));

        let mut client = UnixStream::connect(&socket).await.unwrap();
        client.write_all(b"not json\n").await.unwrap();
        client.flush().await.unwrap();

        let reply = read_reply(client).await;
        assert!(matches!(
            reply,
            Reply::Error {
                id: 0,
                ref message
            } if message.as_str() == "malformed_reply"
        ));

        task.abort();
    }

    #[tokio::test]
    async fn socket_and_parent_have_owner_only_modes() {
        let dir = TempDir::new();
        let socket = dir.path().join("s");
        let lock = dir.path().join("s.lock");
        let _server = bind(&socket, &lock).await.unwrap();

        let socket_mode = fs::metadata(&socket).unwrap().permissions().mode() & 0o777;
        let parent_mode = fs::metadata(socket.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(socket_mode, 0o600);
        assert_eq!(parent_mode, 0o700);
    }

    #[tokio::test]
    async fn dropping_server_removes_lock_and_socket() {
        let dir = TempDir::new();
        let socket = dir.path().join("s");
        let lock = dir.path().join("s.lock");
        let server = bind(&socket, &lock).await.unwrap();

        assert!(socket.exists());
        assert!(lock.exists());

        drop(server);

        assert!(!socket.exists());
        assert!(!lock.exists());
    }
}
