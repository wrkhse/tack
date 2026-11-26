//! The stall that runs tack's plugin VM inside the daemon.
//!
//! The wire handler sends one framed line at a time through [`StallClient`].
//! A line is either a barn-stall request, which runs on the sandbox held for
//! the length of one call, or a private reload frame, which replaces that
//! sandbox with a fresh VM from the plugin folder. A line the module cannot
//! answer yields a named error, never an allow.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use barn_stall::Request as StallRequest;
use tack_luau::{Capabilities, EngineError, Limits, Sandbox};
use tack_protocol::wire::{DEFAULT_DEADLINE_MS, DEFAULT_MEMORY_BYTES};

use crate::stall::{StallError, Transport};
use crate::{dispatch, frames};

/// The single-line reply to a reload control frame.
pub const RELOAD_REPLY: &str = r#"{"type":"reloaded"}"#;

const MAX_PLUGIN_FILES: usize = 64;
const MAX_PLUGIN_FILE_BYTES: u64 = 1024 * 1024;

/// The reload control line sent when the plugin folder changes.
#[must_use]
pub const fn reload_frame() -> &'static str {
    r#"{"type":"reload"}"#
}

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

/// A bounded snapshot of a plugin folder's direct files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fingerprint {
    Value(u64),
    Unsafe,
}

/// Hash each direct file's path and bytes in path order. An unreadable
/// folder, too many files or an oversized file is `Unsafe`, which always
/// reports a change.
fn folder_fingerprint(plugin: &Path) -> Fingerprint {
    let Ok(entries) = fs::read_dir(plugin) else {
        return Fingerprint::Unsafe;
    };

    let mut paths = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            return Fingerprint::Unsafe;
        };
        match entry.file_type() {
            Ok(kind) if kind.is_file() => paths.push(entry.path()),
            Ok(_) => {}
            Err(_) => return Fingerprint::Unsafe,
        }
    }
    if paths.len() > MAX_PLUGIN_FILES {
        return Fingerprint::Unsafe;
    }
    paths.sort();

    let mut hasher = DefaultHasher::new();
    for path in paths {
        let Ok(mut file) = fs::File::open(&path) else {
            return Fingerprint::Unsafe;
        };
        let mut bytes = Vec::new();
        if file
            .by_ref()
            .take(MAX_PLUGIN_FILE_BYTES)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return Fingerprint::Unsafe;
        }
        let mut extra = [0u8; 1];
        match file.read(&mut extra) {
            Ok(0) => {}
            _ => return Fingerprint::Unsafe,
        }

        path.hash(&mut hasher);
        bytes.hash(&mut hasher);
    }

    Fingerprint::Value(hasher.finish())
}

/// Remembers the plugin folder's fingerprint between requests.
pub struct ReloadGuard {
    plugin: PathBuf,
    fingerprint: Fingerprint,
}

impl ReloadGuard {
    /// Snapshot the plugin folder now.
    #[must_use]
    pub fn new(plugin: PathBuf) -> Self {
        let fingerprint = folder_fingerprint(&plugin);

        Self {
            plugin,
            fingerprint,
        }
    }

    /// Report whether the folder differs from the committed snapshot.
    #[must_use]
    pub fn changed(&self) -> bool {
        let current = folder_fingerprint(&self.plugin);

        matches!(current, Fingerprint::Unsafe) || current != self.fingerprint
    }

    /// Commit the current snapshot after a successful reload.
    pub fn commit(&mut self) {
        self.fingerprint = folder_fingerprint(&self.plugin);
    }
}

/// A stall that evaluates framed requests on one in-process plugin VM.
pub struct InProcessStall {
    sandbox: Mutex<Sandbox>,
    plugin: PathBuf,
    limits: Limits,
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
        let sandbox = Sandbox::new(&plugin, limits, Capabilities::default())?;

        Ok(Self {
            sandbox: Mutex::new(sandbox),
            plugin,
            limits,
        })
    }

    /// Build a fresh VM with the same capabilities the daemon uses today.
    fn build(&self) -> Result<Sandbox, EngineError> {
        Sandbox::new(&self.plugin, self.limits, Capabilities::default())
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

                Ok(RELOAD_REPLY.to_owned())
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
            Ok(RELOAD_REPLY.to_owned())
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

    #[test]
    fn a_reload_guard_detects_a_changed_file() {
        let folder = PluginFolder::new("return { name = \"v1\" }");
        let guard = ReloadGuard::new(folder.0.clone());

        assert!(!guard.changed());

        folder.write("return { name = \"v2\" }");

        assert!(guard.changed());
    }

    #[test]
    fn a_guard_stays_changed_when_the_reload_fails() {
        let folder = PluginFolder::new("return { name = \"v1\" }");
        let guard = ReloadGuard::new(folder.0.clone());

        folder.write("return { name = \"v2\" }");

        assert!(guard.changed());
        assert!(guard.changed());
    }

    #[test]
    fn a_guard_is_clear_after_a_successful_reload_commits() {
        let folder = PluginFolder::new("return { name = \"v1\" }");
        let mut guard = ReloadGuard::new(folder.0.clone());

        folder.write("return { name = \"v2\" }");

        assert!(guard.changed());
        guard.commit();
        assert!(!guard.changed());
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
