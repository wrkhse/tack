//! The hook identity Codex trusts: its hooks.json group, its state key and
//! the hash `[hooks.state.<key>].trusted_hash` must equal.
//!
//! Codex (rust-v0.172.0, `codex-rs/hooks/src/engine/discovery.rs`
//! `hook_hash`) hashes the normalized handler, not the file text: the event
//! label, the matcher when the event has one, and the one handler with its
//! timeout filled in and `async` explicit. `None` fields are left out, as
//! TOML cannot hold them. `codex-rs/config/src/fingerprint.rs`
//! `version_for_toml` then sorts every object, writes compact JSON and
//! prefixes the SHA-256 hex digest with `sha256:`.

use std::fmt::Write as _;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Codex's hook timeout for each generated handler, in seconds.
pub const HOOK_TIMEOUT_SEC: u64 = 10;

/// The timeout Codex fills in for a `PreToolUse` or `SessionStart` command hook
/// that names none, in seconds (`normalize_command_hook`).
const CODEX_DEFAULT_TIMEOUT_SEC: u64 = 600;

/// A Codex hook event tack registers a handler for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    PreToolUse,
    SessionStart,
}

impl Event {
    /// The event's name in hooks.json.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::PreToolUse => "PreToolUse",
            Self::SessionStart => "SessionStart",
        }
    }

    /// The event's label in state keys and the trust hash.
    #[must_use]
    pub const fn key_label(self) -> &'static str {
        match self {
            Self::PreToolUse => "pre_tool_use",
            Self::SessionStart => "session_start",
        }
    }
}

/// One generated command handler, alone in its matcher group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handler {
    pub event: Event,
    pub matcher: Option<&'static str>,
    pub command: String,
}

impl Handler {
    fn command_object(&self) -> Value {
        let mut handler = Map::new();
        handler.insert("type".into(), Value::from("command"));
        handler.insert("command".into(), Value::from(self.command.as_str()));
        handler.insert("timeout".into(), Value::from(HOOK_TIMEOUT_SEC));

        Value::Object(handler)
    }

    /// The matcher group as hooks.json holds it.
    #[must_use]
    pub fn group(&self) -> Value {
        let mut group = Map::new();

        if let Some(matcher) = self.matcher {
            group.insert("matcher".into(), Value::from(matcher));
        }

        group.insert("hooks".into(), Value::Array(vec![self.command_object()]));

        Value::Object(group)
    }

    /// The hash Codex computes for this handler, which its trusted hash
    /// must equal for Codex to run it.
    #[must_use]
    pub fn trusted_hash(&self) -> String {
        identity_hash(self.event, self.matcher, &self.command, HOOK_TIMEOUT_SEC)
    }
}

/// The hash Codex computes for `handler` in `group` of `event`, when this
/// crate can reproduce it exactly: a group of only `matcher` and `hooks`, and
/// a handler of only `"type": "command"`, a non-blank `command`, a positive
/// `timeout` (Codex fills in 600) and `"async": false`. Any other shape, such
/// as a status message or another handler type, gives `None`, so a caller
/// never judges trust it cannot verify.
#[must_use]
pub fn handler_hash(event: Event, group: &Value, handler: &Value) -> Option<String> {
    let group = group.as_object()?;
    let handler = handler.as_object()?;

    if group.keys().any(|key| key != "matcher" && key != "hooks") {
        return None;
    }

    let known = |key: &String| matches!(key.as_str(), "type" | "command" | "timeout" | "async");

    if !handler.keys().all(known) || handler.get("type")? != "command" {
        return None;
    }

    if handler.get("async").is_some_and(|value| value != false) {
        return None;
    }

    let matcher = match group.get("matcher") {
        Some(matcher) => Some(matcher.as_str()?),
        None => None,
    };
    let command = handler
        .get("command")?
        .as_str()
        .filter(|command| !command.trim().is_empty())?;
    let timeout = match handler.get("timeout") {
        Some(timeout) => timeout.as_u64().filter(|seconds| *seconds > 0)?,
        None => CODEX_DEFAULT_TIMEOUT_SEC,
    };

    Some(identity_hash(event, matcher, command, timeout))
}

/// Codex's `hook_hash` identity for one command handler: the event label,
/// the matcher when there is one, and the handler with its timeout filled in
/// and `async` explicit.
fn identity_hash(event: Event, matcher: Option<&str>, command: &str, timeout: u64) -> String {
    let mut handler = Map::new();
    handler.insert("type".into(), Value::from("command"));
    handler.insert("command".into(), Value::from(command));
    handler.insert("timeout".into(), Value::from(timeout));
    handler.insert("async".into(), Value::Bool(false));

    let mut identity = Map::new();
    identity.insert("event_name".into(), Value::from(event.key_label()));

    if let Some(matcher) = matcher {
        identity.insert("matcher".into(), Value::from(matcher));
    }

    identity.insert("hooks".into(), Value::Array(vec![Value::Object(handler)]));

    fingerprint(Value::Object(identity))
}

/// Codex's `version_for_toml` over a JSON value: sorted objects, compact
/// JSON, SHA-256, lowercase hex, prefixed `sha256:`.
#[must_use]
pub fn fingerprint(mut value: Value) -> String {
    value.sort_all_objects();

    let bytes = serde_json::to_vec(&value).unwrap_or_default();
    let mut hash = String::from("sha256:");

    for byte in Sha256::digest(&bytes) {
        let _ = write!(hash, "{byte:02x}");
    }

    hash
}

/// The state key Codex gives the handler at `handler` in group `group`
/// of `event` in the hooks file at `source`.
#[must_use]
pub fn hook_key(source: &str, event: Event, group: usize, handler: usize) -> String {
    format!("{source}:{}:{group}:{handler}", event.key_label())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_fingerprint_matches_codex_known_value() {
        // codex-rs/config/src/fingerprint_tests.rs at rust-v0.172.0 hashes this
        // TOML, in either key order, to the value below.
        let value = json!({
            "rows": [{ "z": 2, "a": 1 }, { "z": 4, "a": 3 }],
            "nested": { "z": "text", "a": true }
        });

        assert_eq!(
            fingerprint(value),
            "sha256:a5e4c8fbdbc75d185b0f2b5291bfb2de10e8c523d6c89248876fd78a97c83176"
        );
    }

    #[test]
    fn the_identity_holds_the_normalized_handler_and_the_matcher() {
        let handler = Handler {
            event: Event::PreToolUse,
            matcher: Some("^Bash$"),
            command: "node '/out/codex/pre-tool-use.js'".into(),
        };
        let identity = json!({
            "event_name": "pre_tool_use",
            "matcher": "^Bash$",
            "hooks": [{
                "type": "command",
                "command": "node '/out/codex/pre-tool-use.js'",
                "timeout": 10,
                "async": false
            }]
        });

        assert_eq!(handler.trusted_hash(), fingerprint(identity));
        assert_eq!(
            handler.group(),
            json!({
                "matcher": "^Bash$",
                "hooks": [{
                    "type": "command",
                    "command": "node '/out/codex/pre-tool-use.js'",
                    "timeout": 10
                }]
            })
        );
    }

    #[test]
    fn an_event_without_a_matcher_leaves_it_out() {
        let handler = Handler {
            event: Event::SessionStart,
            matcher: None,
            command: "node '/out/codex/session-start.js'".into(),
        };
        let identity = json!({
            "event_name": "session_start",
            "hooks": [{
                "type": "command",
                "command": "node '/out/codex/session-start.js'",
                "timeout": 10,
                "async": false
            }]
        });

        assert_eq!(handler.trusted_hash(), fingerprint(identity));
        assert_eq!(handler.group().get("matcher"), None);
    }

    #[test]
    fn handler_hash_fills_in_codex_default_timeout() {
        let handler = json!({ "type": "command", "command": "./lint.sh" });
        let group = json!({ "matcher": "^Write$", "hooks": [handler] });
        let identity = json!({
            "event_name": "pre_tool_use",
            "matcher": "^Write$",
            "hooks": [{
                "type": "command",
                "command": "./lint.sh",
                "timeout": 600,
                "async": false
            }]
        });

        assert_eq!(
            handler_hash(Event::PreToolUse, &group, &handler),
            Some(fingerprint(identity))
        );
    }

    #[test]
    fn handler_hash_keeps_an_explicit_timeout_and_async_false() {
        let handler = json!({
            "type": "command",
            "command": "./start.sh",
            "timeout": 30,
            "async": false
        });
        let group = json!({ "hooks": [handler] });
        let identity = json!({
            "event_name": "session_start",
            "hooks": [{
                "type": "command",
                "command": "./start.sh",
                "timeout": 30,
                "async": false
            }]
        });

        assert_eq!(
            handler_hash(Event::SessionStart, &group, &handler),
            Some(fingerprint(identity))
        );
    }

    #[test]
    fn handler_hash_refuses_a_shape_it_cannot_reproduce() {
        let plain = json!({ "type": "command", "command": "./lint.sh" });
        let group = json!({ "hooks": [plain] });

        for handler in [
            json!({ "type": "command", "command": "./lint.sh", "statusMessage": "x" }),
            json!({ "type": "command", "command": "./lint.sh", "async": true }),
            json!({ "type": "command", "command": "./lint.sh", "timeout": 0 }),
            json!({ "type": "command", "command": "  " }),
            json!({ "type": "prompt", "command": "./lint.sh" }),
            json!({ "command": "./lint.sh" }),
        ] {
            assert_eq!(
                handler_hash(Event::PreToolUse, &group, &handler),
                None,
                "{handler}"
            );
        }

        for group in [
            json!({ "hooks": [plain], "description": "x" }),
            json!({ "matcher": 1, "hooks": [plain] }),
        ] {
            assert_eq!(
                handler_hash(Event::PreToolUse, &group, &plain),
                None,
                "{group}"
            );
        }
    }

    #[test]
    fn handler_hash_agrees_with_a_generated_handler() {
        for handler in [
            Handler {
                event: Event::PreToolUse,
                matcher: Some("^Bash$"),
                command: "node '/out/codex/pre-tool-use.js'".into(),
            },
            Handler {
                event: Event::SessionStart,
                matcher: None,
                command: "node '/out/codex/session-start.js'".into(),
            },
        ] {
            let group = handler.group();
            let generated = group
                .get("hooks")
                .and_then(Value::as_array)
                .and_then(|hooks| hooks.first())
                .expect("one generated handler");

            assert_eq!(
                handler_hash(handler.event, &group, generated),
                Some(handler.trusted_hash())
            );
        }
    }

    #[test]
    fn keys_name_the_source_event_group_and_handler() {
        assert_eq!(
            hook_key("/tmp/hooks.json", Event::PreToolUse, 0, 0),
            "/tmp/hooks.json:pre_tool_use:0:0"
        );
        assert_eq!(
            hook_key("/home/.codex/hooks.json", Event::SessionStart, 2, 0),
            "/home/.codex/hooks.json:session_start:2:0"
        );
    }
}
