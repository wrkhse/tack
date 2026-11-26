//! The stall that runs tack's plugin VM inside the daemon.
//!
//! The wire handler sends one framed line at a time through [`StallClient`].
//! A line is either a barn-stall request, which runs on the sandbox held for
//! the length of one call, or a private reload frame, which replaces that
//! sandbox with a fresh VM from the plugin folder. A line the module cannot
//! answer yields a named error, never an allow.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use barn_stall::Request as StallRequest;
use tack_luau::{Capabilities, EngineError, Limits, Sandbox};
use tack_protocol::wire::{DEFAULT_DEADLINE_MS, DEFAULT_MEMORY_BYTES};

use crate::stall::{StallError, Transport};
use crate::{dispatch, frames};

/// The ack for a reload frame. It is a control reply, not a stall verdict, and
/// no `StallClient` ever sends a reload frame.
const RELOAD_ACK: &str = r#"{"type":"reload","ok":true}"#;

/// The two kinds of line accepted on the in-process transport.
enum Frame {
    Request(StallRequest),
    Reload,
}

/// Try a stall request first, then the private control frame's `reload` tag.
fn parse(frame: &str) -> Result<Frame, StallError> {
    let value: serde_json::Value =
        serde_json::from_str(frame).map_err(|_| StallError::Malformed)?;

    if value.get("type").and_then(serde_json::Value::as_str) == Some("reload") {
        return Ok(Frame::Reload);
    }

    serde_json::from_value(value)
        .map(Frame::Request)
        .map_err(|_| StallError::Malformed)
}

/// A stall that evaluates framed requests on one in-process plugin VM.
pub struct InProcessStall {
    sandbox: Mutex<Sandbox>,
    plugin: PathBuf,
    limits: Limits,
    capabilities: Capabilities,
}

impl InProcessStall {
    /// Build the first VM from the plugin folder under the daemon's bounds.
    ///
    /// # Errors
    ///
    /// Returns the limit or load error when the bounds or the plugin folder
    /// cannot be used.
    pub fn new(plugin: PathBuf) -> Result<Self, EngineError> {
        let limits = Limits::new(DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS)?;
        let capabilities = Capabilities::default();
        let sandbox = Sandbox::new(&plugin, limits, Capabilities::default())?;

        Ok(Self {
            sandbox: Mutex::new(sandbox),
            plugin,
            limits,
            capabilities,
        })
    }

    /// Build a fresh VM, moving the configured capabilities into it.
    fn build(&mut self) -> Result<Sandbox, EngineError> {
        let capabilities = std::mem::take(&mut self.capabilities);

        Sandbox::new(&self.plugin, self.limits, capabilities)
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

        match parse(frame)? {
            Frame::Request(request) => self.answer(&request),
            Frame::Reload => {
                let fresh = self
                    .build()
                    .map_err(|error| StallError::Io(format!("tack: {error}")))?;

                self.sandbox = Mutex::new(fresh);

                Ok(RELOAD_ACK.to_owned())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant, SystemTime};

    use barn_stall::{
        FRAMED_VERSION, Outcome as StallOutcome, Reply as StallReply, ToolCall as StallToolCall,
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
                name = "allow-test",
                toolBefore = function(payload, ctx)
                    if payload.command == "ls" then
                        return nil
                    end
                    return ctx.deny("unexpected invocation")
                end,
            }
            "#,
        );
        let mut stall = InProcessStall::new(folder.0.clone()).unwrap();
        let frame = hook_frame(7, "ls");

        assert_eq!(stall.call(&frame, Instant::now()), Err(StallError::Timeout));
        assert_eq!(
            stall.call(
                r#"{"type":"unknown"}"#,
                Instant::now() + Duration::from_secs(1)
            ),
            Err(StallError::Malformed)
        );
    }

    #[test]
    fn a_reload_frame_installs_a_fresh_sandbox() {
        let folder = PluginFolder::new(
            r#"
            return {
                name = "reload-test",
                toolBefore = function(payload, ctx)
                    return ctx.deny("v1")
                end,
            }
            "#,
        );
        let mut stall = InProcessStall::new(folder.0.clone()).unwrap();
        let frame = hook_frame(7, "git push");
        let deadline = Instant::now() + Duration::from_secs(1);

        assert_eq!(
            decode(&stall.call(&frame, deadline).unwrap()),
            deny(7, "v1")
        );

        folder.write(
            r#"
            return {
                name = "reload-test",
                toolBefore = function(payload, ctx)
                    return ctx.deny("v2")
                end,
            }
            "#,
        );
        assert_eq!(
            stall.call(r#"{"type":"reload"}"#, deadline),
            Ok(RELOAD_ACK.to_owned())
        );
        assert_eq!(
            decode(&stall.call(&frame, deadline).unwrap()),
            deny(7, "v2")
        );
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
}
