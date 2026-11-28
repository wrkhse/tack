//! Entry point for `tack-hook`: one request line in, one reply line out,
//! exit 0 so the caller always reads a verdict.

use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;

use tack_hook::locate::{self, SOCKET_NAME};
use tack_hook::start::Launch;
use tack_hook::{Budget, Call, Failure, HookArgs, Limits, forward, parse_args, read_request};
use tack_protocol::wire::ReplyError;

fn main() {
    // One deadline from process start bounds the whole run.
    let budget = Budget::from_now(Limits::DEFAULT);

    let line = run(
        std::env::args_os().skip(1),
        locate::state_dir,
        budget,
        || read_request(&mut std::io::stdin().lock()),
    );
    let mut stdout = std::io::stdout().lock();

    if stdout.write_all(&line).is_ok() {
        let _ = stdout.flush();
    }
}

/// The reply line for one run: `args` after the program name, `state`
/// resolving the state folder, and `read` blocking for the request line.
fn run<S, R>(args: impl IntoIterator<Item = OsString>, state: S, budget: Budget, read: R) -> Vec<u8>
where
    S: FnOnce() -> Result<PathBuf, Failure>,
    R: FnOnce() -> Result<Vec<u8>, Failure> + Send + 'static,
{
    let launch_args = match parse_args(args) {
        Ok(args) => args,
        Err(failure) => return failure.into_line(0),
    };

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let failure = Failure::new(
                ReplyError::DaemonError,
                format_args!("cannot start the runtime: {error}"),
            );

            return failure.into_line(0);
        }
    };

    let line = runtime.block_on(handle(launch_args, state, budget, read));

    // A stdin read that never ends must not hold the process open.
    runtime.shutdown_background();

    line
}

async fn handle<S, R>(args: HookArgs, state: S, budget: Budget, read: R) -> Vec<u8>
where
    S: FnOnce() -> Result<PathBuf, Failure>,
    R: FnOnce() -> Result<Vec<u8>, Failure> + Send + 'static,
{
    let call = match receive(&budget, read).await.and_then(Call::parse) {
        Ok(call) => call,
        Err(failure) => return failure.into_line(0),
    };

    let HookArgs {
        plugin,
        name,
        needs,
    } = args;

    let reply = match state() {
        Ok(state) => {
            let socket = state.join(SOCKET_NAME);
            // The daemon binary is found only for a cold start, so a running
            // daemon still answers when none sits beside the hook.
            let start = plugin.map(|plugin| {
                let socket = socket.clone();

                move || {
                    let launch = Launch {
                        bin: locate::daemon_bin()?,
                        socket,
                        plugin,
                        state,
                        name,
                        needs,
                    };

                    launch.spawn()
                }
            });

            forward(&call, &socket, start, budget).await
        }
        Err(failure) => Err(failure),
    };

    reply.unwrap_or_else(|failure| failure.into_line(call.id()))
}

/// Run the blocking `read` off the runtime, bounded by the budget's deadline.
async fn receive<R>(budget: &Budget, read: R) -> Result<Vec<u8>, Failure>
where
    R: FnOnce() -> Result<Vec<u8>, Failure> + Send + 'static,
{
    let read = tokio::task::spawn_blocking(read);

    match tokio::time::timeout_at(budget.deadline(), read).await {
        Ok(Ok(line)) => line,
        Ok(Err(error)) => Err(Failure::new(
            ReplyError::Aborted,
            format_args!("reading stdin failed: {error}"),
        )),
        Err(_) => Err(budget.timed_out("request on stdin")),
    }
}

#[cfg(test)]
mod tests {
    //! In-process proofs of one hook run. No child process starts and no
    //! environment variable changes: the state folder, the arguments and
    //! stdin are injected, and the stub daemon is a thread in this test.

    use std::fs::Permissions;
    use std::io::{BufRead, BufReader, Cursor};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    use tack_protocol::wire::{self, Outcome, PROTOCOL_VERSION, Reply, Request, ToolCall};

    use super::*;

    const LIMITS: Limits = Limits {
        total: Duration::from_millis(300),
        start: Duration::from_millis(300),
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);

    /// An owner-only temporary state folder, removed afterwards.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let seq = NEXT.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("tack-hook-main-{}-{seq}", std::process::id()));

            std::fs::create_dir_all(&path).unwrap();
            std::fs::set_permissions(&path, Permissions::from_mode(0o700)).unwrap();

            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn hook_line(id: u64) -> Vec<u8> {
        wire::encode_line(&Request::Hook {
            id,
            version: PROTOCOL_VERSION,
            hook: "toolBefore".into(),
            call: ToolCall {
                tool: "shell".into(),
                name: "Bash".into(),
                input: serde_json::json!({ "command": "git push" }),
                session_id: Some("s-1".into()),
            },
            _meta: None,
        })
        .unwrap()
    }

    fn allow(id: u64) -> Vec<u8> {
        wire::encode_line(&Reply::Hook {
            id,
            version: PROTOCOL_VERSION,
            outcome: Outcome::Allow,
        })
        .unwrap()
    }

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(Into::into).collect()
    }

    fn line(kind: ReplyError, message: impl std::fmt::Display, id: u64) -> Vec<u8> {
        Failure::new(kind, message).into_line(id)
    }

    fn in_dir(dir: &Path) -> impl FnOnce() -> Result<PathBuf, Failure> {
        let dir = dir.to_path_buf();

        move || Ok(dir)
    }

    fn stdin(bytes: &'static [u8]) -> impl FnOnce() -> Result<Vec<u8>, Failure> + Send + 'static {
        move || read_request(&mut Cursor::new(bytes))
    }

    #[test]
    fn an_unknown_argument_is_malformed_before_stdin_is_read() {
        let scratch = Scratch::new();

        let output = run(
            args(&["--socket", "/x"]),
            in_dir(&scratch.0),
            Budget::from_now(LIMITS),
            || panic!("stdin must not be read"),
        );

        assert_eq!(
            output,
            line(ReplyError::Malformed, "unknown argument --socket", 0)
        );
    }

    #[test]
    fn stdin_that_is_not_json_is_malformed() {
        let scratch = Scratch::new();

        let output = run(
            args(&[]),
            in_dir(&scratch.0),
            Budget::from_now(LIMITS),
            stdin(b"not json\n"),
        );

        assert_eq!(
            output,
            line(
                ReplyError::Malformed,
                "stdin is not a tack request: expected ident at line 1 column 2",
                0,
            )
        );
    }

    #[test]
    fn empty_stdin_is_malformed() {
        let scratch = Scratch::new();

        let output = run(
            args(&[]),
            in_dir(&scratch.0),
            Budget::from_now(LIMITS),
            stdin(b""),
        );

        assert_eq!(
            output,
            line(ReplyError::Malformed, "no request on stdin", 0)
        );
    }

    #[test]
    fn no_daemon_and_no_plugin_is_socket_missing_for_the_request_id() {
        let scratch = Scratch::new();
        let socket = scratch.0.join(SOCKET_NAME);

        let output = run(
            args(&[]),
            in_dir(&scratch.0),
            Budget::from_now(LIMITS),
            move || Ok(hook_line(7)),
        );

        assert_eq!(
            output,
            line(
                ReplyError::SocketMissing,
                format_args!("no tack daemon at {}", socket.display()),
                7,
            )
        );
    }

    #[test]
    fn a_state_dir_that_cannot_be_found_is_its_failure_for_the_request_id() {
        let output = run(
            args(&[]),
            || Err(Failure::new(ReplyError::SocketMissing, "no state dir")),
            Budget::from_now(LIMITS),
            move || Ok(hook_line(7)),
        );

        assert_eq!(output, line(ReplyError::SocketMissing, "no state dir", 7));
    }

    #[test]
    fn the_daemon_reply_is_the_output_unchanged() {
        let scratch = Scratch::new();
        let socket = scratch.0.join(SOCKET_NAME);
        let listener = UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, Permissions::from_mode(0o600)).unwrap();

        // One connection: read the request line, answer allow, return the line.
        let daemon = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();

            BufReader::new(&stream)
                .read_until(b'\n', &mut request)
                .unwrap();
            stream.write_all(&allow(7)).unwrap();

            request
        });

        let output = run(
            args(&[]),
            in_dir(&scratch.0),
            Budget::from_now(LIMITS),
            move || Ok(hook_line(7)),
        );

        assert_eq!(output, allow(7));
        assert_eq!(daemon.join().unwrap(), hook_line(7));
    }

    #[test]
    fn stdin_that_never_ends_is_timeout_by_the_deadline() {
        let scratch = Scratch::new();
        let (release, held) = mpsc::channel::<()>();
        let limits = Limits {
            total: Duration::from_millis(100),
            start: Duration::from_millis(100),
        };

        let began = std::time::Instant::now();
        let output = run(
            args(&[]),
            in_dir(&scratch.0),
            Budget::from_now(limits),
            move || {
                let _ = held.recv();

                Err(Failure::new(ReplyError::Aborted, "released"))
            },
        );
        let elapsed = began.elapsed();

        // Lets the blocked read end now that the run has answered.
        drop(release);

        assert_eq!(
            output,
            line(ReplyError::Timeout, "no request on stdin within 100 ms", 0)
        );
        assert!(elapsed < Duration::from_millis(1000), "{elapsed:?}");
    }

    #[tokio::test]
    async fn receive_returns_the_line_read() {
        let budget = Budget::from_now(LIMITS);

        assert_eq!(
            receive(&budget, move || Ok(hook_line(7))).await,
            Ok(hook_line(7))
        );
    }
}
