//! The NDJSON contract between a generated wrapper and the daemon.
//!
//! Every message is one line of JSON. Enums are internally tagged so a peer
//! can dispatch on `kind` without knowing the variant set in advance.

use std::fmt;
use std::io::{BufRead, Read};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::{DEFAULT_DEADLINE_MS, DEFAULT_MEMORY_BYTES, MAX_FRAME_BYTES, MAX_PENDING};

/// Every request and reply carries this version; peers refuse other versions.
pub const PROTOCOL_VERSION: u32 = 1;

/// The machine-readable class carried by an error reply.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReplyError {
    Malformed,
    TooLarge,
    Limit,
    Script,
    UnsupportedHook,
    UnknownTool,
    ProtocolVersion,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Hook {
        id: u64,
        version: u32,
        hook: String,
        call: ToolCall,
    },
    Tool {
        id: u64,
        version: u32,
        name: String,
        input: Value,
    },
}

impl Request {
    #[must_use]
    pub const fn id(&self) -> u64 {
        match self {
            Self::Hook { id, .. } | Self::Tool { id, .. } => *id,
        }
    }

    #[must_use]
    pub const fn version(&self) -> u32 {
        match self {
            Self::Hook { version, .. } | Self::Tool { version, .. } => *version,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub tool: String,
    pub name: String,
    pub input: Value,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Allow,
    Deny { reason: String },
    Rewrite { input: Value },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Content {
    pub kind: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reply {
    Hook {
        id: u64,
        version: u32,
        outcome: Outcome,
    },
    Tool {
        id: u64,
        version: u32,
        content: Vec<Content>,
    },
    Error {
        id: u64,
        version: u32,
        error: ReplyError,
        message: String,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input: Value,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PluginManifest {
    pub name: String,
    #[serde(default)]
    pub needs: Vec<String>,
    pub tools: Vec<ToolDef>,
}

/// Why the wrapper denied a call without a verdict from the daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DenyReason {
    SocketMissing,
    Timeout,
    SocketClosed,
    MalformedReply,
    ProtocolVersion,
    Limit,
    Script,
    UnknownTool,
    DaemonError,
    Aborted,
}

impl DenyReason {
    pub const ALL: [Self; 10] = [
        Self::SocketMissing,
        Self::Timeout,
        Self::SocketClosed,
        Self::MalformedReply,
        Self::ProtocolVersion,
        Self::Limit,
        Self::Script,
        Self::UnknownTool,
        Self::DaemonError,
        Self::Aborted,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SocketMissing => "socket_missing",
            Self::Timeout => "timeout",
            Self::SocketClosed => "socket_closed",
            Self::MalformedReply => "malformed_reply",
            Self::ProtocolVersion => "protocol_version",
            Self::Limit => "limit",
            Self::Script => "script",
            Self::UnknownTool => "unknown_tool",
            Self::DaemonError => "daemon_error",
            Self::Aborted => "aborted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    TooLarge,
    Malformed,
    Closed,
    Io,
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::TooLarge => "frame exceeds the size cap",
            Self::Malformed => "frame is not valid JSON",
            Self::Closed => "peer closed the frame mid-line",
            Self::Io => "frame I/O failed",
        };
        f.write_str(message)
    }
}

impl std::error::Error for WireError {}

/// Serialize one value as a newline-terminated frame.
///
/// # Errors
///
/// Returns [`WireError::Malformed`] when `value` cannot be serialized, or
/// [`WireError::TooLarge`] when the encoded frame exceeds [`MAX_FRAME_BYTES`].
pub fn encode_line<T: Serialize>(value: &T) -> Result<Vec<u8>, WireError> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| WireError::Malformed)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(WireError::TooLarge);
    }
    Ok(bytes)
}

/// Read one newline-terminated frame under a hard size cap.
///
/// EOF before any byte is a clean close; EOF part-way through a line is a
/// protocol error because the peer abandoned a frame.
///
/// # Errors
///
/// Returns [`WireError::TooLarge`] when the frame exceeds [`MAX_FRAME_BYTES`],
/// [`WireError::Closed`] when the peer ends a frame mid-line, and
/// [`WireError::Io`] when reading from `reader` fails.
pub fn read_line<R: BufRead>(reader: &mut R) -> Result<Option<Vec<u8>>, WireError> {
    let mut bytes = Vec::new();
    let cap = u64::try_from(MAX_FRAME_BYTES + 1).map_err(|_| WireError::TooLarge)?;
    let read = reader
        .take(cap)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| WireError::Io)?;

    if read == 0 {
        return Ok(None);
    }
    if bytes.last() == Some(&b'\n') {
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(WireError::TooLarge);
        }
        return Ok(Some(bytes));
    }
    if bytes.len() < MAX_FRAME_BYTES + 1 {
        return Err(WireError::Closed);
    }

    // The cap was reached without a newline. One more byte tells an oversize
    // frame from a clean EOF exactly at the cap.
    match reader.read(&mut [0u8; 1]).map_err(|_| WireError::Io)? {
        0 => Err(WireError::Closed),
        _ => Err(WireError::TooLarge),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn hook_request() -> Request {
        Request::Hook {
            id: 7,
            version: PROTOCOL_VERSION,
            hook: "toolBefore".into(),
            call: ToolCall {
                tool: "shell".into(),
                name: "shell".into(),
                input: serde_json::json!({ "command": "git push" }),
                session_id: None,
            },
        }
    }

    #[test]
    fn round_trip_tagged_messages() {
        let request = hook_request();
        let line = encode_line(&request).unwrap();
        assert!(line.ends_with(b"\n"));
        let decoded: Request = serde_json::from_slice(&line).unwrap();
        assert_eq!(decoded, request);

        let reply = Reply::Hook {
            id: 7,
            version: PROTOCOL_VERSION,
            outcome: Outcome::Deny {
                reason: "push blocked".into(),
            },
        };
        let decoded: Reply = serde_json::from_slice(&encode_line(&reply).unwrap()).unwrap();
        assert_eq!(decoded, reply);

        let tool = Reply::Tool {
            id: 8,
            version: PROTOCOL_VERSION,
            content: vec![Content {
                kind: "text".into(),
                text: "guard_status: daemon ok".into(),
            }],
        };
        let decoded: Reply = serde_json::from_slice(&encode_line(&tool).unwrap()).unwrap();
        assert_eq!(decoded, tool);

        let error = Reply::Error {
            id: 9,
            version: PROTOCOL_VERSION,
            error: ReplyError::TooLarge,
            message: "too_large".into(),
        };
        let decoded: Reply = serde_json::from_slice(&encode_line(&error).unwrap()).unwrap();
        assert_eq!(decoded, error);
    }

    #[test]
    fn tags_and_defaults_are_wire_stable() {
        assert_eq!(
            serde_json::to_value(hook_request()).unwrap(),
            serde_json::json!({
                "kind": "hook",
                "id": 7,
                "version": PROTOCOL_VERSION,
                "hook": "toolBefore",
                "call": {
                    "tool": "shell",
                    "name": "shell",
                    "input": { "command": "git push" },
                    "session_id": null
                }
            })
        );
        assert_eq!(
            serde_json::to_value(Outcome::Allow).unwrap(),
            serde_json::json!({ "kind": "allow" })
        );
        assert_eq!(
            serde_json::to_value(Outcome::Rewrite {
                input: serde_json::json!({ "command": "git push --dry-run" })
            })
            .unwrap(),
            serde_json::json!({ "kind": "rewrite", "input": { "command": "git push --dry-run" } })
        );
        let call: ToolCall = serde_json::from_value(serde_json::json!({
            "tool": "shell",
            "name": "shell",
            "input": {}
        }))
        .unwrap();
        assert_eq!(call.session_id, None);

        assert_eq!(
            serde_json::to_value(ReplyError::UnsupportedHook).unwrap(),
            serde_json::json!("unsupported_hook")
        );
        assert_eq!(
            serde_json::to_value(ReplyError::UnknownTool).unwrap(),
            serde_json::json!("unknown_tool")
        );
        assert_eq!(
            serde_json::to_value(ReplyError::ProtocolVersion).unwrap(),
            serde_json::json!("protocol_version")
        );
        let version: ReplyError = serde_json::from_str("\"protocol_version\"").unwrap();
        assert_eq!(version, ReplyError::ProtocolVersion);
        assert_eq!(
            serde_json::to_value(Reply::Error {
                id: 9,
                version: PROTOCOL_VERSION,
                error: ReplyError::Malformed,
                message: "malformed".into(),
            })
            .unwrap(),
            serde_json::json!({
                "kind": "error",
                "id": 9,
                "version": PROTOCOL_VERSION,
                "error": "malformed",
                "message": "malformed"
            })
        );
    }

    #[test]
    fn wire_errors_display_their_messages() {
        for (error, expected) in [
            (WireError::TooLarge, "frame exceeds the size cap"),
            (WireError::Malformed, "frame is not valid JSON"),
            (WireError::Closed, "peer closed the frame mid-line"),
            (WireError::Io, "frame I/O failed"),
        ] {
            assert_eq!(error.to_string(), expected);
        }
    }

    #[test]
    fn encode_rejects_an_oversize_frame() {
        let huge = serde_json::json!({ "blob": "x".repeat(MAX_FRAME_BYTES) });
        assert_eq!(encode_line(&huge), Err(WireError::TooLarge));
    }

    #[test]
    fn read_line_handles_eof_cap_and_partial_frames() {
        assert_eq!(read_line(&mut Cursor::new(b"")), Ok(None));
        assert_eq!(
            read_line(&mut Cursor::new(b"partial")),
            Err(WireError::Closed)
        );

        let line = b"hello\n".to_vec();
        assert_eq!(read_line(&mut Cursor::new(&line)), Ok(Some(line.clone())));

        let mut exact = vec![b'x'; MAX_FRAME_BYTES - 1];
        exact.push(b'\n');
        assert_eq!(read_line(&mut Cursor::new(exact.clone())), Ok(Some(exact)));

        let mut oversize = vec![b'x'; MAX_FRAME_BYTES + 1];
        oversize.push(b'\n');
        assert_eq!(
            read_line(&mut Cursor::new(oversize)),
            Err(WireError::TooLarge)
        );
    }

    #[test]
    fn malformed_frames_are_rejected() {
        assert!(serde_json::from_slice::<Request>(br#"{"kind":"hook"}"#).is_err());
        assert!(serde_json::from_slice::<Reply>(b"not json\n").is_err());
        assert!(serde_json::from_slice::<Outcome>(br#"{"kind":"deny"}"#).is_err());
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let request = serde_json::to_value(hook_request()).unwrap();
        let mut with_extra = request.as_object().unwrap().clone();
        with_extra.insert("extra".into(), serde_json::json!(1));

        assert!(serde_json::from_value::<Request>(serde_json::json!(with_extra)).is_err());

        let mut call = serde_json::to_value(ToolCall {
            tool: "shell".into(),
            name: "shell".into(),
            input: serde_json::json!({}),
            session_id: None,
        })
        .unwrap();
        call.as_object_mut()
            .unwrap()
            .insert("extra".into(), serde_json::json!(1));

        assert!(serde_json::from_value::<ToolCall>(call).is_err());
    }

    #[test]
    fn accessors_read_id_and_version() {
        let request = hook_request();
        assert_eq!(request.id(), 7);
        assert_eq!(request.version(), PROTOCOL_VERSION);

        let tool = Request::Tool {
            id: 11,
            version: PROTOCOL_VERSION,
            name: "shell".into(),
            input: serde_json::json!({}),
        };
        assert_eq!(tool.id(), 11);
        assert_eq!(tool.version(), PROTOCOL_VERSION);
    }

    #[test]
    fn deny_reasons_serialize_to_their_named_strings() {
        for (reason, expected) in [
            (DenyReason::SocketMissing, "socket_missing"),
            (DenyReason::Timeout, "timeout"),
            (DenyReason::SocketClosed, "socket_closed"),
            (DenyReason::MalformedReply, "malformed_reply"),
            (DenyReason::ProtocolVersion, "protocol_version"),
            (DenyReason::Limit, "limit"),
            (DenyReason::Script, "script"),
            (DenyReason::UnknownTool, "unknown_tool"),
            (DenyReason::DaemonError, "daemon_error"),
            (DenyReason::Aborted, "aborted"),
        ] {
            assert_eq!(reason.as_str(), expected);
            assert_eq!(
                serde_json::to_value(reason).unwrap(),
                serde_json::json!(expected)
            );
        }
    }

    #[test]
    fn every_deny_reason_round_trips() {
        for reason in DenyReason::ALL {
            let line = serde_json::to_string(&reason).unwrap();
            let decoded: DenyReason = serde_json::from_str(&line).unwrap();
            assert_eq!(decoded, reason);
        }
    }
}
