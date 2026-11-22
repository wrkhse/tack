//! The NDJSON contract between a generated wrapper and the daemon.
//!
//! Every message is one line of JSON. Enums are internally tagged so a peer
//! can dispatch on `kind` without knowing the variant set in advance.

use std::fmt;
use std::io::{BufRead, Read};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::{DEFAULT_DEADLINE_MS, DEFAULT_MEMORY_BYTES, MAX_FRAME_BYTES, MAX_PENDING};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Request {
    Hook {
        id: u64,
        hook: String,
        call: ToolCall,
    },
    Tool {
        id: u64,
        name: String,
        input: Value,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub tool: String,
    pub name: String,
    pub input: Value,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Allow,
    Deny { reason: String },
    Rewrite { input: Value },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Content {
    pub kind: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reply {
    Hook { id: u64, outcome: Outcome },
    Tool { id: u64, content: Vec<Content> },
    Error { id: u64, message: String },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input: Value,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PluginManifest {
    pub name: String,
    #[serde(default)]
    pub needs: Vec<String>,
    pub tools: Vec<ToolDef>,
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
            WireError::TooLarge => "frame exceeds the size cap",
            WireError::Malformed => "frame is not valid JSON",
            WireError::Closed => "peer closed the frame mid-line",
            WireError::Io => "frame I/O failed",
        };
        f.write_str(message)
    }
}

impl std::error::Error for WireError {}

/// Serialize one value as a newline-terminated frame.
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
pub fn read_line<R: BufRead>(reader: &mut R) -> Result<Option<Vec<u8>>, WireError> {
    let mut bytes = Vec::new();
    let read = reader
        .take((MAX_FRAME_BYTES + 1) as u64)
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
            outcome: Outcome::Deny {
                reason: "push blocked".into(),
            },
        };
        let decoded: Reply = serde_json::from_slice(&encode_line(&reply).unwrap()).unwrap();
        assert_eq!(decoded, reply);

        let tool = Reply::Tool {
            id: 8,
            content: vec![Content {
                kind: "text".into(),
                text: "guard_status: daemon ok".into(),
            }],
        };
        let decoded: Reply = serde_json::from_slice(&encode_line(&tool).unwrap()).unwrap();
        assert_eq!(decoded, tool);
    }

    #[test]
    fn tags_and_defaults_are_wire_stable() {
        assert_eq!(
            serde_json::to_value(hook_request()).unwrap(),
            serde_json::json!({
                "kind": "hook",
                "id": 7,
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
}
