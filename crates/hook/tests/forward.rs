//! In-process proofs of the hook client against stub daemons. No child
//! process starts and no signal is sent: every daemon is a tokio listener in
//! this test, bound in a temporary folder that is removed afterwards.

#![cfg(test)]

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use tack_hook::{Budget, Call, Failure, Limits, forward, plugin_dir, read_request};
use tack_protocol::wire::{
    self, Content, MAX_FRAME_BYTES, Outcome, PROTOCOL_VERSION, Reply, ReplyError, Request, ToolCall,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;

const LIMITS: Limits = Limits {
    total: Duration::from_millis(300),
    start: Duration::from_millis(500),
};

type Start = fn() -> Result<(), Failure>;

const NO_START: Option<Start> = None;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let seq = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("tack-hook-{}-{seq}", std::process::id()));

        std::fs::create_dir_all(&path).unwrap();

        Self(path)
    }

    fn socket(&self) -> PathBuf {
        self.0.join("tack.sock")
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
    })
    .unwrap()
}

fn hook_call(id: u64) -> Call {
    Call::parse(hook_line(id)).unwrap()
}

fn line(reply: &Reply) -> Vec<u8> {
    wire::encode_line(reply).unwrap()
}

fn allow(id: u64) -> Vec<u8> {
    line(&Reply::Hook {
        id,
        version: PROTOCOL_VERSION,
        outcome: Outcome::Allow,
    })
}

/// How a stub daemon treats the one connection it accepts.
enum Stub {
    Reply(Vec<u8>),
    Close,
    Hold,
}

/// Accept one connection, read its request line, act as `stub` says and
/// return the request line it read.
async fn answer(listener: UnixListener, stub: Stub) -> Vec<u8> {
    let (stream, _) = listener.accept().await.unwrap();
    let mut reader = BufReader::new(stream);
    let mut request = Vec::new();

    reader.read_until(b'\n', &mut request).await.unwrap();

    match stub {
        Stub::Reply(reply) => {
            let _ = reader.get_mut().write_all(&reply).await;
        }
        Stub::Close => {}
        // Outlast every budget; the test's runtime ends the task.
        Stub::Hold => tokio::time::sleep(Duration::from_secs(60)).await,
    }

    request
}

async fn forward_to(stub: Stub, call: &Call) -> Result<Vec<u8>, Failure> {
    let scratch = Scratch::new();
    let listener = UnixListener::bind(scratch.socket()).unwrap();
    let server = tokio::spawn(answer(listener, stub));

    let result = forward(call, &scratch.socket(), NO_START, Budget::from_now(LIMITS)).await;

    server.abort();

    result
}

#[tokio::test]
async fn the_reply_line_passes_through_unchanged() {
    let scratch = Scratch::new();
    let listener = UnixListener::bind(scratch.socket()).unwrap();
    let server = tokio::spawn(answer(listener, Stub::Reply(allow(7))));

    let output = forward(
        &hook_call(7),
        &scratch.socket(),
        NO_START,
        Budget::from_now(LIMITS),
    )
    .await;

    assert_eq!(output, Ok(allow(7)));
    assert_eq!(server.await.unwrap(), hook_line(7));
}

#[tokio::test]
async fn a_tool_reply_and_a_daemon_error_pass_through() {
    let tool = Call::parse(
        wire::encode_line(&Request::Tool {
            id: 8,
            version: PROTOCOL_VERSION,
            name: "guard_status".into(),
            input: serde_json::json!({}),
        })
        .unwrap(),
    )
    .unwrap();
    let content = line(&Reply::Tool {
        id: 8,
        version: PROTOCOL_VERSION,
        content: vec![Content {
            kind: "text".into(),
            text: "guard_status: daemon ok".into(),
        }],
    });
    let script = line(&Reply::Error {
        id: 7,
        version: PROTOCOL_VERSION,
        error: ReplyError::Script,
        message: "tack: boom".into(),
    });

    assert_eq!(
        forward_to(Stub::Reply(content.clone()), &tool).await,
        Ok(content)
    );
    assert_eq!(
        forward_to(Stub::Reply(script.clone()), &hook_call(7)).await,
        Ok(script)
    );
}

#[tokio::test]
async fn a_cold_start_binds_the_socket_and_the_one_retry_reaches_it() {
    let scratch = Scratch::new();
    let socket = scratch.socket();
    let starts = Arc::new(AtomicUsize::new(0));

    let start = {
        let socket = socket.clone();
        let starts = Arc::clone(&starts);

        move || {
            starts.fetch_add(1, Ordering::SeqCst);
            let listener = UnixListener::bind(&socket)
                .map_err(|error| Failure::new(ReplyError::DaemonError, error))?;
            drop(tokio::spawn(answer(listener, Stub::Reply(allow(7)))));

            Ok(())
        }
    };

    let output = forward(
        &hook_call(7),
        &socket,
        Some(start),
        Budget::from_now(LIMITS),
    )
    .await;

    assert_eq!(output, Ok(allow(7)));
    assert_eq!(starts.load(Ordering::SeqCst), 1);
}

fn missing(socket: &Path) -> Failure {
    Failure::new(
        ReplyError::SocketMissing,
        format_args!("no tack daemon at {}", socket.display()),
    )
}

#[tokio::test]
async fn a_missing_daemon_without_a_plugin_is_socket_missing() {
    let scratch = Scratch::new();
    let socket = scratch.socket();

    let output = forward(&hook_call(7), &socket, NO_START, Budget::from_now(LIMITS)).await;

    assert_eq!(output, Err(missing(&socket)));
}

#[tokio::test]
async fn a_start_that_never_binds_is_socket_missing_after_one_retry() {
    let scratch = Scratch::new();
    let socket = scratch.socket();
    let starts = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&starts);

    let output = forward(
        &hook_call(7),
        &socket,
        Some(move || {
            counted.fetch_add(1, Ordering::SeqCst);

            Ok(())
        }),
        Budget::from_now(LIMITS),
    )
    .await;

    assert_eq!(output, Err(missing(&socket)));
    assert_eq!(starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_daemon_that_binds_late_and_never_replies_denies_by_the_total_deadline() {
    let scratch = Scratch::new();
    let socket = scratch.socket();
    let bind_after = Duration::from_secs(2);

    let start = {
        let socket = socket.clone();

        move || {
            drop(tokio::spawn(async move {
                tokio::time::sleep(bind_after).await;
                let listener = UnixListener::bind(&socket).unwrap();
                answer(listener, Stub::Hold).await
            }));

            Ok(())
        }
    };

    let began = std::time::Instant::now();
    let budget = Budget::from_now(Limits::DEFAULT);
    let output = forward(&hook_call(7), &socket, Some(start), budget).await;
    let elapsed = began.elapsed();

    // A fresh 9 s per attempt after a 2 s start would deny near 11 s.
    assert_eq!(
        output,
        Err(Failure::new(ReplyError::Timeout, "no reply within 9000 ms"))
    );
    assert!(elapsed >= Duration::from_millis(9000), "{elapsed:?}");
    assert!(elapsed < Duration::from_millis(9500), "{elapsed:?}");
}

#[tokio::test]
async fn the_start_wait_is_cut_to_the_budget_left() {
    let scratch = Scratch::new();
    let socket = scratch.socket();
    let limits = Limits {
        total: Duration::from_millis(300),
        start: Duration::from_millis(3000),
    };

    let began = std::time::Instant::now();
    let output = forward(
        &hook_call(7),
        &socket,
        Some(|| Ok(())),
        Budget::from_now(limits),
    )
    .await;
    let elapsed = began.elapsed();

    assert_eq!(output, Err(missing(&socket)));
    assert!(elapsed >= Duration::from_millis(300), "{elapsed:?}");
    assert!(elapsed < Duration::from_millis(1000), "{elapsed:?}");
}

#[tokio::test]
async fn a_failed_start_is_its_own_failure() {
    let scratch = Scratch::new();
    let failure = Failure::new(ReplyError::DaemonError, "cannot start tack-daemon");
    let reported = failure.clone();

    let output = forward(
        &hook_call(7),
        &scratch.socket(),
        Some(move || Err(reported)),
        Budget::from_now(LIMITS),
    )
    .await;

    assert_eq!(output, Err(failure));
}

#[tokio::test]
async fn a_daemon_that_closes_without_replying_is_socket_closed() {
    let output = forward_to(Stub::Close, &hook_call(7)).await;

    assert_eq!(
        output,
        Err(Failure::new(
            ReplyError::SocketClosed,
            "the daemon closed the connection without a reply",
        ))
    );
}

#[tokio::test]
async fn a_daemon_that_closes_mid_reply_is_socket_closed() {
    let output = forward_to(Stub::Reply(b"{\"kind\":".to_vec()), &hook_call(7)).await;

    assert_eq!(
        output,
        Err(Failure::new(
            ReplyError::SocketClosed,
            "the daemon closed the connection mid-reply",
        ))
    );
}

#[tokio::test]
async fn no_reply_within_the_call_limit_is_timeout() {
    let output = forward_to(Stub::Hold, &hook_call(7)).await;

    assert_eq!(
        output,
        Err(Failure::new(ReplyError::Timeout, "no reply within 300 ms"))
    );
}

#[tokio::test]
async fn a_reply_that_is_not_json_is_malformed_reply() {
    let output = forward_to(Stub::Reply(b"not json\n".to_vec()), &hook_call(7)).await;

    assert_eq!(
        output.map_err(|failure| failure.kind),
        Err(ReplyError::MalformedReply)
    );
}

#[tokio::test]
async fn an_oversize_reply_is_malformed_reply() {
    let mut huge = vec![b'x'; MAX_FRAME_BYTES];
    huge.push(b'\n');

    let output = forward_to(Stub::Reply(huge), &hook_call(7)).await;

    assert_eq!(
        output,
        Err(Failure::new(
            ReplyError::MalformedReply,
            "the reply exceeds 1 MiB",
        ))
    );
}

#[tokio::test]
async fn a_reply_for_another_call_is_malformed_reply() {
    let tool = line(&Reply::Tool {
        id: 7,
        version: PROTOCOL_VERSION,
        content: vec![],
    });

    assert_eq!(
        forward_to(Stub::Reply(allow(8)), &hook_call(7)).await,
        Err(Failure::new(
            ReplyError::MalformedReply,
            "the reply id 8 does not match the request id 7",
        ))
    );
    assert_eq!(
        forward_to(Stub::Reply(tool), &hook_call(7)).await,
        Err(Failure::new(
            ReplyError::MalformedReply,
            "the reply kind does not answer the request",
        ))
    );
}

#[tokio::test]
async fn a_reply_of_another_version_is_protocol_version() {
    let future = line(&Reply::Hook {
        id: 7,
        version: 2,
        outcome: Outcome::Allow,
    });

    let output = forward_to(Stub::Reply(future), &hook_call(7)).await;

    assert_eq!(
        output,
        Err(Failure::new(
            ReplyError::ProtocolVersion,
            "the daemon speaks protocol 2, this hook 1",
        ))
    );
}

#[test]
fn the_first_stdin_line_is_the_request() {
    let mut two = Cursor::new(b"first\nsecond\n".to_vec());
    let mut bare = Cursor::new(b"last".to_vec());

    assert_eq!(read_request(&mut two), Ok(b"first\n".to_vec()));
    assert_eq!(read_request(&mut bare), Ok(b"last\n".to_vec()));
    assert_eq!(
        read_request(&mut Cursor::new(Vec::new())),
        Err(Failure::new(ReplyError::Malformed, "no request on stdin"))
    );
}

#[test]
fn a_request_line_over_one_mib_is_too_large() {
    let too_large = Err(Failure::new(
        ReplyError::TooLarge,
        "the request exceeds 1 MiB",
    ));
    let mut exact = vec![b'x'; MAX_FRAME_BYTES - 1];
    exact.push(b'\n');

    assert_eq!(read_request(&mut Cursor::new(exact.clone())), Ok(exact));
    assert_eq!(
        read_request(&mut Cursor::new(vec![b'x'; MAX_FRAME_BYTES])),
        too_large
    );
    assert_eq!(
        read_request(&mut Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 5])),
        too_large
    );
}

#[test]
fn a_line_that_is_not_a_request_is_malformed() {
    let call = Call::parse(b"{\"kind\":\"hook\"}\n".to_vec());

    assert_eq!(
        call.map_err(|failure| failure.kind),
        Err(ReplyError::Malformed)
    );
    assert_eq!(hook_call(9).id(), 9);
}

#[test]
fn only_plugin_is_an_argument() {
    let args = |list: &[&str]| plugin_dir(list.iter().map(Into::into));

    assert_eq!(args(&[]), Ok(None));
    assert_eq!(
        args(&["--plugin", "/plugins/safe-push"]),
        Ok(Some(PathBuf::from("/plugins/safe-push")))
    );
    assert_eq!(
        args(&["--plugin"]),
        Err(Failure::new(ReplyError::Malformed, "--plugin needs a dir"))
    );
    assert_eq!(
        args(&["--socket", "/x"]),
        Err(Failure::new(
            ReplyError::Malformed,
            "unknown argument --socket",
        ))
    );
}
