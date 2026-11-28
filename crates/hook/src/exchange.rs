//! One connect, one request line, one bounded reply line, then the checks that
//! make the reply safe to pass through unchanged.

use std::io::{self, ErrorKind};
use std::path::Path;

use tack_protocol::wire::{MAX_FRAME_BYTES, PROTOCOL_VERSION, Reply, ReplyError, Request};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::{Budget, Failure, trust};

/// How one attempt ended without a reply line.
pub enum Attempt {
    /// No daemon listens: the socket is missing or refuses connections. A
    /// cold start may help.
    Absent(io::Error),
    /// A daemon was reached, or the socket failed otherwise.
    Failed(Failure),
}

impl Attempt {
    fn connect_error(socket: &Path, error: io::Error) -> Self {
        if matches!(
            error.kind(),
            ErrorKind::NotFound | ErrorKind::ConnectionRefused
        ) {
            return Self::Absent(error);
        }

        Self::Failed(Failure::new(
            ReplyError::SocketClosed,
            format_args!("cannot connect to {}: {error}", socket.display()),
        ))
    }

    pub fn into_failure(self, socket: &Path) -> Failure {
        match self {
            Self::Absent(error) if error.kind() == ErrorKind::NotFound => Failure::new(
                ReplyError::SocketMissing,
                format_args!("no tack daemon at {}", socket.display()),
            ),
            Self::Absent(error) => Failure::new(
                ReplyError::SocketClosed,
                format_args!("the socket at {} refused: {error}", socket.display()),
            ),
            Self::Failed(failure) => failure,
        }
    }
}

fn closed(message: impl std::fmt::Display) -> Failure {
    Failure::new(ReplyError::SocketClosed, message)
}

fn malformed(message: impl std::fmt::Display) -> Failure {
    Failure::new(ReplyError::MalformedReply, message)
}

/// Check the socket is this user's, then connect, send `line` and read one
/// reply line, all by the budget's deadline.
pub async fn attempt(socket: &Path, line: &[u8], budget: &Budget) -> Result<Vec<u8>, Attempt> {
    let exchange = async {
        trust::verify(socket)?;

        let mut stream = UnixStream::connect(socket)
            .await
            .map_err(|error| Attempt::connect_error(socket, error))?;

        stream
            .write_all(line)
            .await
            .map_err(|error| Attempt::Failed(closed(format_args!("cannot send: {error}"))))?;

        read_reply(&mut stream).await.map_err(Attempt::Failed)
    };

    tokio::time::timeout_at(budget.deadline(), exchange)
        .await
        .unwrap_or_else(|_| Err(Attempt::Failed(budget.timed_out("reply"))))
}

async fn read_reply(stream: &mut UnixStream) -> Result<Vec<u8>, Failure> {
    let mut reader = BufReader::new(stream.take(crate::frame_cap()));
    let mut reply = Vec::new();

    let read = reader
        .read_until(b'\n', &mut reply)
        .await
        .map_err(|error| closed(format_args!("cannot read the reply: {error}")))?;

    if read == 0 {
        return Err(closed("the daemon closed the connection without a reply"));
    }

    if reply.len() > MAX_FRAME_BYTES {
        return Err(malformed("the reply exceeds 1 MiB"));
    }

    if reply.last() != Some(&b'\n') {
        return Err(closed("the daemon closed the connection mid-reply"));
    }

    Ok(reply)
}

/// A reply must use this protocol version. A `busy` error passes with any
/// id because the daemon can reject the connection without reading `request`.
/// Every other reply must have the same id and be the same kind or an error.
///
/// # Errors
///
/// Returns `malformed_reply` or `protocol_version` naming what failed.
pub fn check(reply: &[u8], request: &Request) -> Result<(), Failure> {
    let parsed: Reply = serde_json::from_slice(reply)
        .map_err(|error| malformed(format_args!("the reply is not a tack reply: {error}")))?;

    let (id, version, answers) = match &parsed {
        Reply::Hook { id, version, .. } => (*id, *version, matches!(request, Request::Hook { .. })),
        Reply::Tool { id, version, .. } => (*id, *version, matches!(request, Request::Tool { .. })),
        // A control reply is outside the hook's closed set of verdicts.
        // UnsupportedHook names that refusal; ProtocolVersion would blame a
        // version that the check below has not reached yet.
        Reply::Control { .. } => {
            return Err(Failure::new(
                ReplyError::UnsupportedHook,
                "the daemon sent a control reply to a hook",
            ));
        }
        Reply::Error { id, version, .. } => (*id, *version, true),
        // A future reply kind is refused the way a control reply is.
        _ => {
            return Err(Failure::new(
                ReplyError::UnsupportedHook,
                "unsupported reply kind",
            ));
        }
    };

    if version != PROTOCOL_VERSION {
        return Err(Failure::new(
            ReplyError::ProtocolVersion,
            format_args!("the daemon speaks protocol {version}, this hook {PROTOCOL_VERSION}"),
        ));
    }

    let busy = matches!(
        parsed,
        Reply::Error {
            error: ReplyError::Busy,
            ..
        }
    );

    if !busy && id != request.id() {
        return Err(malformed(format_args!(
            "the reply id {id} does not match the request id {}",
            request.id()
        )));
    }

    if !answers {
        return Err(malformed("the reply kind does not answer the request"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    use tack_protocol::wire::{self, Outcome};

    /// Far above a correct read, so only a broken read reaches it.
    const READ_LIMIT: Duration = Duration::from_secs(2);

    fn tool_request() -> Request {
        Request::Tool {
            id: 7,
            version: PROTOCOL_VERSION,
            name: "status".into(),
            input: serde_json::Value::Null,
        }
    }

    #[test]
    fn a_busy_reply_without_the_request_id_passes() {
        let reply = wire::encode_line(&Reply::Error {
            id: 0,
            version: PROTOCOL_VERSION,
            error: ReplyError::Busy,
            message: "tack: busy".into(),
        })
        .unwrap();

        assert_eq!(check(&reply, &tool_request()), Ok(()));
    }

    #[test]
    fn a_non_busy_error_without_the_request_id_is_malformed() {
        let reply = wire::encode_line(&Reply::Error {
            id: 0,
            version: PROTOCOL_VERSION,
            error: ReplyError::Script,
            message: "tack: script".into(),
        })
        .unwrap();

        assert_eq!(
            check(&reply, &tool_request()),
            Err(Failure::new(
                ReplyError::MalformedReply,
                "the reply id 0 does not match the request id 7",
            ))
        );
    }

    #[test]
    fn a_control_reply_to_a_hook_is_unsupported() {
        let reply = wire::encode_line(&Reply::Control {
            id: 7,
            version: PROTOCOL_VERSION,
            result: serde_json::json!({ "denied": true }),
        })
        .unwrap();

        assert_eq!(
            check(&reply, &tool_request()),
            Err(Failure::new(
                ReplyError::UnsupportedHook,
                "the daemon sent a control reply to a hook",
            ))
        );
    }

    #[test]
    fn a_missing_socket_is_socket_missing_and_a_refusing_one_socket_closed() {
        let socket = Path::new("/run/tack/tack.sock");

        let missing = Attempt::Absent(io::Error::from(ErrorKind::NotFound)).into_failure(socket);
        let refused =
            Attempt::Absent(io::Error::from(ErrorKind::ConnectionRefused)).into_failure(socket);

        assert_eq!(missing.kind, ReplyError::SocketMissing);
        assert_eq!(refused.kind, ReplyError::SocketClosed);
    }

    #[tokio::test]
    async fn a_reply_of_exactly_the_frame_limit_is_read_whole() {
        let mut line = wire::encode_line(&Reply::Hook {
            id: 1,
            version: PROTOCOL_VERSION,
            outcome: Outcome::Allow,
        })
        .unwrap();
        line.pop();
        line.resize(MAX_FRAME_BYTES.checked_sub(1).unwrap(), b' ');
        line.push(b'\n');
        assert_eq!(line.len(), MAX_FRAME_BYTES);

        let (mut daemon, mut hook) = UnixStream::pair().unwrap();
        let sent = line.clone();
        let writer = tokio::spawn(async move { daemon.write_all(&sent).await });

        let reply = tokio::time::timeout(READ_LIMIT, read_reply(&mut hook)).await;

        // A read that stops short leaves the writer blocked on a full
        // socket, so it is stopped on every path instead of awaited.
        writer.abort();
        let _ = writer.await;

        let reply = reply.expect("read_reply did not finish within the limit");
        assert_eq!(reply, Ok(line));
    }
}
