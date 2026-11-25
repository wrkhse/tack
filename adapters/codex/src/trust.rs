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
    fn command_object(&self, normalized: bool) -> Value {
        let mut handler = Map::new();
        handler.insert("type".into(), Value::from("command"));
        handler.insert("command".into(), Value::from(self.command.as_str()));
        handler.insert("timeout".into(), Value::from(HOOK_TIMEOUT_SEC));

        if normalized {
            handler.insert("async".into(), Value::Bool(false));
        }

        Value::Object(handler)
    }

    /// The matcher group as hooks.json holds it.
    #[must_use]
    pub fn group(&self) -> Value {
        let mut group = Map::new();

        if let Some(matcher) = self.matcher {
            group.insert("matcher".into(), Value::from(matcher));
        }

        group.insert(
            "hooks".into(),
            Value::Array(vec![self.command_object(false)]),
        );

        Value::Object(group)
    }

    /// The hash Codex computes for this handler, which its trusted hash
    /// must equal for Codex to run it.
    #[must_use]
    pub fn trusted_hash(&self) -> String {
        let mut identity = Map::new();
        identity.insert("event_name".into(), Value::from(self.event.key_label()));

        if let Some(matcher) = self.matcher {
            identity.insert("matcher".into(), Value::from(matcher));
        }

        identity.insert(
            "hooks".into(),
            Value::Array(vec![self.command_object(true)]),
        );

        fingerprint(Value::Object(identity))
    }
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
