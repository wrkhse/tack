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

/// A reply passes when it is a protocol reply of this version that answers
/// `request`: the same id, and the same kind or an error.
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
        Reply::Error { id, version, .. } => (*id, *version, true),
    };

    if version != PROTOCOL_VERSION {
        return Err(Failure::new(
            ReplyError::ProtocolVersion,
            format_args!("the daemon speaks protocol {version}, this hook {PROTOCOL_VERSION}"),
        ));
    }

    if id != request.id() {
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
