//! The fail-closed verdict: one `Reply::Error` line naming why no daemon
//! verdict arrived.

use std::fmt;

use tack_protocol::wire::{self, PROTOCOL_VERSION, Reply, ReplyError};

/// Why the hook answers with an error instead of the daemon's reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub kind: ReplyError,
    pub message: String,
}

impl Failure {
    /// A failure of `kind`, its message prefixed with `tack-hook: `.
    #[must_use]
    pub fn new(kind: ReplyError, message: impl fmt::Display) -> Self {
        Self {
            kind,
            message: format!("tack-hook: {message}"),
        }
    }

    /// The newline-terminated `Reply::Error` line for request `id`.
    #[must_use]
    pub fn into_line(self, id: u64) -> Vec<u8> {
        let reply = Reply::Error {
            id,
            version: PROTOCOL_VERSION,
            error: self.kind,
            message: self.message,
        };

        // Only an oversize frame fails to encode; a message near 1 MiB still
        // yields a verdict the caller can read.
        wire::encode_line(&reply).unwrap_or_else(|_| oversize_line(id))
    }
}

fn oversize_line(id: u64) -> Vec<u8> {
    format!(
        "{{\"kind\":\"error\",\"id\":{id},\"version\":{PROTOCOL_VERSION},\
         \"error\":\"daemon_error\",\"message\":\"tack-hook: the error message is too large\"}}\n"
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_becomes_one_error_reply_line() {
        let line = Failure::new(ReplyError::SocketMissing, "no daemon").into_line(7);

        assert_eq!(line.last(), Some(&b'\n'));
        assert_eq!(
            serde_json::from_slice::<Reply>(&line).unwrap(),
            Reply::Error {
                id: 7,
                version: PROTOCOL_VERSION,
                error: ReplyError::SocketMissing,
                message: "tack-hook: no daemon".into(),
            }
        );
    }

    #[test]
    fn an_oversize_message_still_yields_a_daemon_error_line() {
        let huge = "x".repeat(wire::MAX_FRAME_BYTES);
        let line = Failure::new(ReplyError::Timeout, huge).into_line(3);

        assert_eq!(
            serde_json::from_slice::<Reply>(&line).unwrap(),
            Reply::Error {
                id: 3,
                version: PROTOCOL_VERSION,
                error: ReplyError::DaemonError,
                message: "tack-hook: the error message is too large".into(),
            }
        );
    }
}
