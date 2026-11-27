//! The per-user daemon that evaluates hooks and runs tools inside an mlua
//! sandbox with memory and deadline limits.

pub mod frames;
pub mod host_transport;
pub mod in_process;
pub mod stall;
pub mod transport;

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tack_luau::api::{Invocation, Outcome as EngineOutcome};
use tack_luau::{EngineError, Sandbox};
use tack_protocol::wire::{
    Content, DEFAULT_DEADLINE_MS, Outcome, PROTOCOL_VERSION, Reply, ReplyError, Request, ToolCall,
};

pub const EXIT_USAGE: i32 = 2;
pub const EXIT_LOCK_BUSY: i32 = 3;
pub const EXIT_ENGINE: i32 = 4;

pub const SOCKET_NAME: &str = "tack.sock";
pub const ERR_SOCKET_MISMATCH: &str = "socket_not_in_state_dir";

fn state_dir_from(
    tack_state_dir: Option<&str>,
    xdg_state_home: Option<&str>,
    home: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(dir) = tack_state_dir.filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    if let Some(dir) = xdg_state_home.filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir).join("tack"));
    }

    let home = home
        .filter(|home| !home.is_empty())
        .ok_or_else(|| "cannot determine state dir: set TACK_STATE_DIR or HOME".to_owned())?;

    Ok(PathBuf::from(home).join(".local/state/tack"))
}

/// Resolve the state folder from `TACK_STATE_DIR`, `XDG_STATE_HOME` or `HOME`.
///
/// # Errors
///
/// Returns a message when none of the environment variables supplies a usable
/// home path.
pub fn state_dir() -> Result<PathBuf, String> {
    let tack = std::env::var("TACK_STATE_DIR").ok();
    let xdg = std::env::var("XDG_STATE_HOME").ok();
    let home = std::env::var("HOME").ok();

    state_dir_from(tack.as_deref(), xdg.as_deref(), home.as_deref())
}

#[must_use]
pub fn socket_in_state_dir(state_dir: &Path, socket: &Path) -> bool {
    socket == state_dir.join(SOCKET_NAME)
}

fn reply_error(id: u64, error: &EngineError) -> Reply {
    let kind = match error {
        EngineError::Limit(_) => ReplyError::Limit,
        EngineError::UnknownTool(_) => ReplyError::UnknownTool,
        _ => ReplyError::Script,
    };
    let message = format!("tack: {error}");

    eprintln!("tack-daemon: engine error {message}");

    Reply::Error {
        id,
        version: PROTOCOL_VERSION,
        error: kind,
        message,
    }
}

fn version_error(id: u64, version: u32) -> Reply {
    eprintln!("tack-daemon: unsupported protocol version {version}");

    Reply::Error {
        id,
        version: PROTOCOL_VERSION,
        error: ReplyError::ProtocolVersion,
        message: format!("unsupported protocol version {version}"),
    }
}

fn merge_rewrite(input: Value, payload: Value) -> Result<Outcome, EngineError> {
    let (Value::Object(mut input), Value::Object(payload)) = (input, payload) else {
        return Err(EngineError::InvalidResult(
            "hook rewrite requires object input and payload".into(),
        ));
    };

    input.extend(payload);

    Ok(Outcome::Rewrite {
        input: Value::Object(input),
    })
}

fn dispatch_hook(sandbox: &Sandbox, id: u64, hook: String, call: ToolCall) -> Reply {
    if hook != "toolBefore" {
        eprintln!("tack-daemon: hook {hook} unsupported");

        return Reply::Error {
            id,
            version: PROTOCOL_VERSION,
            error: ReplyError::UnsupportedHook,
            message: format!("unsupported_hook:{hook}"),
        };
    }

    let ToolCall {
        tool,
        name,
        input,
        session_id,
    } = call;
    let invocation = Invocation {
        hook,
        payload: input,
        context: json!({ "tool": tool, "name": name, "session_id": session_id }),
    };
    let outcome =
        sandbox
            .hook(&invocation, DEFAULT_DEADLINE_MS)
            .and_then(|outcome| match outcome {
                EngineOutcome::Allow => {
                    eprintln!("tack-daemon: hook toolBefore allow");

                    Ok(Outcome::Allow)
                }
                EngineOutcome::Deny { reason } => {
                    eprintln!("tack-daemon: hook toolBefore deny {reason}");

                    Ok(Outcome::Deny { reason })
                }
                EngineOutcome::Rewrite { payload } => {
                    let outcome = merge_rewrite(invocation.payload, payload)?;
                    eprintln!("tack-daemon: hook toolBefore rewrite");

                    Ok(outcome)
                }
                _ => Err(EngineError::InvalidResult(
                    "unsupported hook outcome".into(),
                )),
            });

    match outcome {
        Ok(outcome) => Reply::Hook {
            id,
            version: PROTOCOL_VERSION,
            outcome,
        },
        Err(error) => reply_error(id, &error),
    }
}

fn decode_tool_content(result: Value) -> Result<Vec<Content>, EngineError> {
    let Value::Object(mut result) = result else {
        return Err(EngineError::InvalidResult(
            "tool must return a table".into(),
        ));
    };
    let content = result
        .remove("content")
        .ok_or_else(|| EngineError::InvalidResult("tool result needs content".into()))?;

    // The engine represents an empty Luau table as an object.
    if matches!(&content, Value::Object(table) if table.is_empty()) {
        return Ok(Vec::new());
    }

    serde_json::from_value(content)
        .map_err(|error| EngineError::InvalidResult(format!("invalid tool content: {error}")))
}

fn dispatch_tool(sandbox: &Sandbox, id: u64, name: &str, input: &Value) -> Reply {
    let content = sandbox
        .run(name, input, DEFAULT_DEADLINE_MS)
        .and_then(decode_tool_content);

    match content {
        Ok(content) => {
            eprintln!("tack-daemon: tool {name} ok");

            Reply::Tool {
                id,
                version: PROTOCOL_VERSION,
                content,
            }
        }
        Err(error) => reply_error(id, &error),
    }
}

pub fn dispatch(sandbox: &Sandbox, request: Request) -> Reply {
    let version = request.version();

    if version != PROTOCOL_VERSION {
        return version_error(request.id(), version);
    }

    match request {
        Request::Hook { id, hook, call, .. } => dispatch_hook(sandbox, id, hook, call),
        Request::Tool {
            id, name, input, ..
        } => dispatch_tool(sandbox, id, &name, &input),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    use tack_luau::{Capabilities, Limits};
    use tack_protocol::wire::DEFAULT_MEMORY_BYTES;

    use super::*;

    static NEXT_PLUGIN: AtomicU64 = AtomicU64::new(0);

    struct PluginFolder(PathBuf);

    impl PluginFolder {
        fn new(source: &str) -> Self {
            let nanos = SystemTime::UNIX_EPOCH.elapsed().unwrap().as_nanos();
            let seq = NEXT_PLUGIN.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "tack-dispatch-{}-{nanos}-{seq}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();

            let folder = Self(path);
            fs::write(folder.0.join("plugin.luau"), source).unwrap();

            folder
        }
    }

    impl Drop for PluginFolder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sandbox(folder: &Path) -> Sandbox {
        let limits = Limits::new(DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS).unwrap();

        Sandbox::new(folder, limits, Capabilities::default()).unwrap()
    }

    fn shell_request(input: Value) -> Request {
        Request::Hook {
            id: 7,
            version: PROTOCOL_VERSION,
            hook: "toolBefore".into(),
            call: ToolCall {
                tool: "shell".into(),
                name: "bash".into(),
                input,
                session_id: Some("s-1".into()),
            },
            _meta: None,
        }
    }

    fn tool_request(name: &str) -> Request {
        Request::Tool {
            id: 8,
            version: PROTOCOL_VERSION,
            name: name.into(),
            input: json!({}),
        }
    }

    #[test]
    fn shell_rewrite_preserves_other_input_fields() {
        let folder = PluginFolder::new(
            r#"
            return {
                name = "rewrite-test",
                toolBefore = function(payload, ctx)
                    if ctx.tool == "shell" and ctx.name == "bash"
                        and ctx.session_id == "s-1" and payload.command == "pwd" then
                        return ctx.rewrite({ command = "pwd -P" })
                    end
                    return ctx.deny("unexpected invocation")
                end,
            }
            "#,
        );
        let sandbox = sandbox(&folder.0);

        let reply = dispatch(
            &sandbox,
            shell_request(json!({ "command": "pwd", "cwd": "/repo", "timeout": 5000 })),
        );

        assert_eq!(
            reply,
            Reply::Hook {
                id: 7,
                version: PROTOCOL_VERSION,
                outcome: Outcome::Rewrite {
                    input: json!({ "command": "pwd -P", "cwd": "/repo", "timeout": 5000 }),
                },
            }
        );
    }

    #[test]
    fn non_object_rewrites_fail_closed() {
        let folder = PluginFolder::new(
            r#"
            return {
                name = "rewrite-test",
                toolBefore = function(payload, ctx)
                    if type(payload) ~= "table" then
                        return ctx.rewrite({ command = "pwd" })
                    end
                    return ctx.rewrite("pwd")
                end,
            }
            "#,
        );
        let sandbox = sandbox(&folder.0);

        for input in [json!("pwd"), json!({ "command": "pwd" })] {
            assert_eq!(
                dispatch(&sandbox, shell_request(input)),
                Reply::Error {
                    id: 7,
                    version: PROTOCOL_VERSION,
                    error: ReplyError::Script,
                    message: "tack: hook rewrite requires object input and payload".into(),
                }
            );
        }
    }

    #[test]
    fn safe_push_fixture_returns_wire_deny_and_tool_content() {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/safe-push");
        let sandbox = sandbox(&folder);

        assert_eq!(
            dispatch(&sandbox, shell_request(json!({ "command": "git push" }))),
            Reply::Hook {
                id: 7,
                version: PROTOCOL_VERSION,
                outcome: Outcome::Deny {
                    reason: "push blocked".into(),
                },
            }
        );
        assert_eq!(
            dispatch(&sandbox, tool_request("guard_status")),
            Reply::Tool {
                id: 8,
                version: PROTOCOL_VERSION,
                content: vec![Content {
                    kind: "text".into(),
                    text: "guard_status: daemon ok".into(),
                }],
            }
        );
    }

    #[test]
    fn tool_content_accepts_an_empty_list_but_requires_a_content_field() {
        let folder = PluginFolder::new(
            r#"
            return {
                name = "tool-content-test",
                tools = {
                    empty = { run = function() return { content = {} } end },
                    missing = { run = function() return {} end },
                },
            }
            "#,
        );
        let sandbox = sandbox(&folder.0);

        assert_eq!(
            dispatch(&sandbox, tool_request("empty")),
            Reply::Tool {
                id: 8,
                version: PROTOCOL_VERSION,
                content: vec![],
            }
        );
        assert_eq!(
            dispatch(&sandbox, tool_request("missing")),
            Reply::Error {
                id: 8,
                version: PROTOCOL_VERSION,
                error: ReplyError::Script,
                message: "tack: tool result needs content".into(),
            }
        );
    }

    #[test]
    fn hook_allow_returns_a_wire_allow() {
        let folder = PluginFolder::new(
            r#"
            return {
                name = "allow-test",
                toolBefore = function(payload, ctx)
                    if ctx.tool == "shell" and payload.command == "ls" then
                        return ctx.allow()
                    end
                    return ctx.deny("unexpected invocation")
                end,
            }
            "#,
        );
        let sandbox = sandbox(&folder.0);

        assert_eq!(
            dispatch(&sandbox, shell_request(json!({ "command": "ls" }))),
            Reply::Hook {
                id: 7,
                version: PROTOCOL_VERSION,
                outcome: Outcome::Allow,
            }
        );
    }

    #[test]
    fn unknown_tool_returns_a_wire_unknown_tool_error() {
        let folder = PluginFolder::new(
            r#"
            return {
                name = "unknown-tool-test",
                tools = {
                    known = { run = function() return { content = {} } end },
                },
            }
            "#,
        );
        let sandbox = sandbox(&folder.0);

        assert_eq!(
            dispatch(&sandbox, tool_request("missing_tool")),
            Reply::Error {
                id: 8,
                version: PROTOCOL_VERSION,
                error: ReplyError::UnknownTool,
                message: "tack: unknown tool: missing_tool".into(),
            }
        );
    }

    #[test]
    fn state_dir_follows_the_environment_precedence() {
        assert_eq!(
            state_dir_from(Some("/custom"), Some("/xdg"), Some("/home/u")).unwrap(),
            PathBuf::from("/custom")
        );
        assert_eq!(
            state_dir_from(None, Some("/xdg"), Some("/home/u")).unwrap(),
            PathBuf::from("/xdg/tack")
        );
        assert_eq!(
            state_dir_from(None, None, Some("/home/u")).unwrap(),
            PathBuf::from("/home/u/.local/state/tack")
        );
        assert!(state_dir_from(None, None, None).is_err());
    }

    #[test]
    fn empty_environment_values_are_ignored() {
        assert_eq!(
            state_dir_from(Some(""), Some("/xdg"), Some("/home/u")).unwrap(),
            PathBuf::from("/xdg/tack")
        );
        assert_eq!(
            state_dir_from(None, Some(""), Some("/home/u")).unwrap(),
            PathBuf::from("/home/u/.local/state/tack")
        );
    }

    #[test]
    fn socket_must_be_the_state_dir_socket() {
        let state = PathBuf::from("/state");

        assert!(socket_in_state_dir(&state, &state.join("tack.sock")));
        assert!(!socket_in_state_dir(&state, &state.join("other.sock")));
        assert!(!socket_in_state_dir(&state, Path::new("/other/tack.sock")));
    }
}
