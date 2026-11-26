//! The stall that runs tack's plugin VM inside the daemon.
//!
//! The wire handler sends one framed line at a time through [`StallClient`].
//! A line is a barn-stall request, which runs on the sandbox held for the
//! length of one call. A line the module cannot answer yields a named error,
//! never an allow.

use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use barn_stall::Request as StallRequest;
use tack_luau::{Capabilities, EngineError, Limits, Sandbox};
use tack_protocol::wire::{DEFAULT_DEADLINE_MS, DEFAULT_MEMORY_BYTES};

use crate::stall::{StallError, Transport};
use crate::{dispatch, frames};

/// A stall that evaluates framed requests on one in-process plugin VM.
pub struct InProcessStall {
    sandbox: Mutex<Sandbox>,
}

impl InProcessStall {
    /// Build the first VM from the plugin folder under the daemon's bounds.
    ///
    /// # Errors
    ///
    /// Returns the limit or load error when the bounds or the plugin folder
    /// cannot be used.
    pub fn new(plugin: impl AsRef<Path>) -> Result<Self, EngineError> {
        let limits = Limits::new(DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS)?;
        let sandbox = Sandbox::new(plugin.as_ref(), limits, Capabilities::default())?;

        Ok(Self {
            sandbox: Mutex::new(sandbox),
        })
    }

    /// Run one request while holding the sandbox for the whole call.
    fn answer(&self, request: &StallRequest) -> Result<String, StallError> {
        let sandbox = self
            .sandbox
            .lock()
            .map_err(|_| StallError::Io("sandbox lock poisoned".into()))?;
        let wire = frames::from_stall_request(request).map_err(|_| StallError::Malformed)?;
        let reply = dispatch(&sandbox, wire);
        drop(sandbox);

        let stall = frames::to_stall_reply(&reply).map_err(|_| StallError::Malformed)?;

        serde_json::to_string(&stall).map_err(|error| StallError::Io(error.to_string()))
    }
}

impl Transport for InProcessStall {
    fn call(&mut self, frame: &str, deadline: Instant) -> Result<String, StallError> {
        if Instant::now() >= deadline {
            return Err(StallError::Timeout);
        }

        let request: StallRequest =
            serde_json::from_str(frame).map_err(|_| StallError::Malformed)?;

        self.answer(&request)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant, SystemTime};

    use barn_stall::{
        Content as StallContent, FRAMED_VERSION, Outcome as StallOutcome, Reply as StallReply,
        ToolCall as StallToolCall,
    };
    use serde_json::json;

    use super::*;

    static NEXT_PLUGIN: AtomicU64 = AtomicU64::new(0);

    struct PluginFolder(PathBuf);

    impl PluginFolder {
        fn new(source: &str) -> Self {
            let nanos = SystemTime::UNIX_EPOCH.elapsed().unwrap().as_nanos();
            let seq = NEXT_PLUGIN.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "tack-in-process-{}-{nanos}-{seq}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();

            let folder = Self(path);
            folder.write(source);

            folder
        }

        fn write(&self, source: &str) {
            fs::write(self.0.join("plugin.luau"), source).unwrap();
        }
    }

    impl Drop for PluginFolder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn hook_frame(id: u64, command: &str) -> String {
        serde_json::to_string(&StallRequest::Hook {
            id,
            version: FRAMED_VERSION,
            hook: "toolBefore".to_owned(),
            call: StallToolCall {
                tool: "shell".to_owned(),
                name: "bash".to_owned(),
                input: json!({ "command": command }),
                session_id: None,
            },
            _meta: None,
        })
        .unwrap()
    }

    fn tool_frame(id: u64, name: &str) -> String {
        serde_json::to_string(&StallRequest::Tool {
            id,
            version: FRAMED_VERSION,
            call: StallToolCall {
                tool: "tack".to_owned(),
                name: name.to_owned(),
                input: json!({}),
                session_id: None,
            },
        })
        .unwrap()
    }

    fn deny(id: u64, reason: &str) -> StallReply {
        StallReply::Hook {
            id,
            outcome: StallOutcome::Deny {
                reason: reason.to_owned(),
            },
        }
    }

    fn decode(line: &str) -> StallReply {
        serde_json::from_str(line).unwrap()
    }

    #[test]
    fn an_unanswerable_frame_names_an_error_instead_of_an_allow() {
        let folder = PluginFolder::new(
            r#"
            return {
                name = "two-content-test",
                tools = {
                    two = { run = function()
                        return { content = {
                            { kind = "text", text = "a" },
                            { kind = "text", text = "b" },
                        } }
                    end },
                },
            }
            "#,
        );
        let mut stall = InProcessStall::new(folder.0.clone()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);

        assert_eq!(
            stall.call(&tool_frame(8, "two"), deadline),
            Err(StallError::Malformed)
        );
        assert_eq!(
            stall.call(r#"{"type":"unknown"}"#, deadline),
            Err(StallError::Malformed)
        );
    }

    #[test]
    fn an_unregistered_hook_yields_a_named_error_instead_of_an_allow() {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/safe-push");
        let mut stall = InProcessStall::new(folder).unwrap();
        let frame = serde_json::to_string(&StallRequest::Hook {
            id: 7,
            version: FRAMED_VERSION,
            hook: "eventTool".to_owned(),
            call: StallToolCall {
                tool: "shell".to_owned(),
                name: "bash".to_owned(),
                input: json!({ "command": "ls" }),
                session_id: None,
            },
            _meta: None,
        })
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);

        assert_eq!(stall.call(&frame, deadline), Err(StallError::Malformed));
    }

    #[test]
    fn a_tool_before_hook_keeps_its_current_verdict() {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/safe-push");
        let mut stall = InProcessStall::new(folder).unwrap();
        let frame = hook_frame(7, "git push");
        let deadline = Instant::now() + Duration::from_secs(1);

        let line = stall.call(&frame, deadline).unwrap();

        assert_eq!(decode(&line), deny(7, "push blocked"));
    }

    #[test]
    fn an_expired_deadline_returns_timeout_without_dispatch() {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/safe-push");
        let mut stall = InProcessStall::new(folder).unwrap();
        let deadline = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .expect("the clock is far from the epoch");
        let frame = hook_frame(7, "git push");

        assert_eq!(stall.call(&frame, deadline), Err(StallError::Timeout));
    }

    #[test]
    fn a_tool_request_routes_through_the_stall_converters() {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/safe-push");
        let limits = Limits::new(DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS).unwrap();
        let sandbox = Sandbox::new(&folder, limits, Capabilities::default()).unwrap();
        let request = StallRequest::Tool {
            id: 9,
            version: FRAMED_VERSION,
            call: StallToolCall {
                tool: "tack".to_owned(),
                name: "guard_status".to_owned(),
                input: json!({}),
                session_id: None,
            },
        };

        let wire = frames::from_stall_request(&request).unwrap();
        let reply = dispatch(&sandbox, wire);
        let stall = frames::to_stall_reply(&reply).unwrap();

        assert_eq!(
            stall,
            StallReply::Tool {
                id: 9,
                content: StallContent {
                    kind: "text".to_owned(),
                    text: "guard_status: daemon ok".to_owned(),
                },
            }
        );
    }
}
