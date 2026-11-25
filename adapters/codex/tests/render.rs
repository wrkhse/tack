//! In-process proofs of the rendered Codex adapter: each script is its
//! template with only the placeholders filled, from the shared fixture values.

#![cfg(test)]

use std::path::Path;

use serde_json::{Map, Value, json};
use tack_adapter_codex::{
    Adapter, CodexError, Config, Event, HOOK_TIMEOUT_SEC, MCP_PROTOCOL_VERSION, render,
};
use tack_protocol::wire::{DenyReason, MAX_FRAME_BYTES, PROTOCOL_VERSION};

const CLIENT: &str = include_str!("../client.js");
const PRE_TOOL_USE: &str = include_str!("../pre-tool-use.js");
const SESSION_START: &str = include_str!("../session-start.js");
const MCP: &str = include_str!("../mcp.js");
const RUN_HOOK: &str = include_str!("../run-hook.sh");

const CODEX_DIR: &str = "/out/codex";

fn fixture() -> Map<String, Value> {
    serde_json::from_str(include_str!("../fixture-values.json")).expect("fixture values")
}

fn rendered(plugin_dir: &str) -> Adapter {
    let fixture = fixture();
    let version = fixture["VERSION"].as_str().expect("version");

    render(&Config {
        plugin_dir: Path::new(plugin_dir),
        codex_dir: Path::new(CODEX_DIR),
        version,
    })
    .expect("render")
}

fn file<'a>(adapter: &'a Adapter, name: &str) -> &'a str {
    adapter
        .files
        .iter()
        .find(|file| file.name == name)
        .map(|file| file.contents.as_str())
        .expect("emitted file")
}

/// The template with every fixture value in its slot, and only those lines
/// changed.
fn filled(template: &str, plugin_dir_literal: &str) -> String {
    let mut expected = template.replace("__TACK_PLUGIN_DIR__", plugin_dir_literal);

    for (name, value) in fixture() {
        if name != "PLUGIN_DIR" {
            expected = expected.replace(&format!("__TACK_{name}__"), &value.to_string());
        }
    }

    expected
}

/// A script's template as the build emits it: the shared client, one blank
/// line, then the script's own body.
fn on_client(body: &str) -> String {
    format!("{CLIENT}\n{body}")
}

fn assert_only_slots_differ(template: &str, script: &str, plugin_dir_literal: &str) {
    let before = template.split_inclusive('\n');
    let after = script.split_inclusive('\n');

    assert_eq!(before.clone().count(), after.clone().count());

    for (line, out) in before.zip(after) {
        if !line.contains("__TACK_") {
            assert_eq!(line, out);
        }
    }

    assert_eq!(script, filled(template, plugin_dir_literal));
    assert_eq!(script.find("__TACK_"), None);
}

#[test]
fn every_script_is_its_template_with_the_fixture_values() {
    let fixture = fixture();
    let plugin_dir = fixture["PLUGIN_DIR"].as_str().expect("plugin dir");
    let adapter = rendered(plugin_dir);
    let literal = json!(plugin_dir).to_string();

    assert_only_slots_differ(
        &on_client(PRE_TOOL_USE),
        file(&adapter, "pre-tool-use.js"),
        &literal,
    );
    assert_only_slots_differ(&on_client(MCP), file(&adapter, "mcp.js"), &literal);
    assert_only_slots_differ(SESSION_START, file(&adapter, "session-start.js"), &literal);
    assert_eq!(file(&adapter, "run-hook.sh"), RUN_HOOK);
}

#[test]
fn the_adapter_emits_six_files_in_order() {
    let adapter = rendered("/plugins/safe-push");

    assert_eq!(
        adapter.files.each_ref().map(|file| file.name),
        [
            "hooks.json",
            "pre-tool-use.js",
            "session-start.js",
            "mcp.js",
            "config.toml",
            "run-hook.sh",
        ]
    );
}

#[test]
fn the_wrapper_names_a_missing_node_apart_from_a_failing_one() {
    let lines: Vec<&str> = RUN_HOOK
        .lines()
        .filter(|line| !line.trim_start().starts_with('#') && !line.trim().is_empty())
        .collect();

    assert_eq!(
        lines,
        [
            "script=$1",
            "if ! command -v node >/dev/null 2>&1; then",
            "  echo 'tack: node_missing' >&2",
            "  exit 2",
            "fi",
            concat!(
                r#"output=$(sh -c 'node "$1" 2>/dev/null; s=$?; "#,
                r#"if [ "$s" -gt 128 ]; then exit 1; fi; exit "$s"' sh "$script" 2>/dev/null)"#,
            ),
            "status=$?",
            r#"if [ "$status" -ne 0 ]; then"#,
            "  echo 'tack: node_failed' >&2",
            "  exit 2",
            "fi",
            r#"if [ -n "$output" ]; then"#,
            r#"  printf '%s\n' "$output""#,
            "fi",
            "exit 0",
        ]
    );
}

#[test]
fn the_fixture_values_are_the_built_values() {
    let fixture = fixture();

    assert_eq!(fixture["PROTOCOL_VERSION"], json!(PROTOCOL_VERSION));
    assert_eq!(fixture["BUDGET_MS"], json!(8000));
    assert_eq!(fixture["MAX_FRAME_BYTES"], json!(MAX_FRAME_BYTES));
    assert_eq!(
        fixture["DENY_REASONS"],
        json!(DenyReason::ALL.map(DenyReason::as_str))
    );
    assert_eq!(fixture["MCP_PROTOCOL_VERSION"], json!(MCP_PROTOCOL_VERSION));
    assert_eq!(MCP_PROTOCOL_VERSION, "2025-06-18");
}

#[test]
fn hooks_json_registers_the_guard_and_the_load_marker_with_a_ten_second_timeout() {
    let adapter = rendered("/plugins/safe-push");
    let hooks: Value = serde_json::from_str(file(&adapter, "hooks.json")).expect("JSON");

    assert_eq!(HOOK_TIMEOUT_SEC, 10);
    assert_eq!(
        hooks,
        json!({
            "hooks": {
                "PreToolUse": [{
                    "matcher": "^Bash$",
                    "hooks": [{
                        "type": "command",
                        "command": "sh '/out/codex/run-hook.sh' '/out/codex/pre-tool-use.js'",
                        "timeout": 10
                    }]
                }],
                "SessionStart": [{
                    "hooks": [{
                        "type": "command",
                        "command": "sh '/out/codex/run-hook.sh' '/out/codex/session-start.js'",
                        "timeout": 10
                    }]
                }]
            }
        })
    );
    assert_eq!(
        adapter.handlers.map(|handler| handler.event),
        [Event::PreToolUse, Event::SessionStart]
    );
}

#[test]
fn the_config_fragment_registers_a_required_mcp_server_with_env_and_timeouts() {
    let adapter = rendered("/plugins/safe-push");

    assert_eq!(
        file(&adapter, "config.toml"),
        "# Generated by tack build. Codex settings for the tack MCP server; add them\n\
         # to Codex's config.toml before any table there.\n\
         check_for_update_on_startup = false\n\
         \n\
         [analytics]\n\
         enabled = false\n\
         \n\
         [mcp_servers.tack]\n\
         command = \"node\"\n\
         args = [\"/out/codex/mcp.js\"]\n\
         env_vars = [\"TACK_RECORDER\", \"TACK_STATE_DIR\", \"TACK_DAEMON_BIN\"]\n\
         required = true\n\
         startup_timeout_sec = 10.0\n\
         tool_timeout_sec = 10.0\n"
    );
}

#[test]
fn a_quote_in_the_output_path_stays_one_shell_word() {
    let adapter = render(&Config {
        plugin_dir: Path::new("/plugins/safe-push"),
        codex_dir: Path::new("/it's/codex"),
        version: "1",
    })
    .expect("render");

    assert_eq!(
        adapter.handlers[0].command,
        r"sh '/it'\''s/codex/run-hook.sh' '/it'\''s/codex/pre-tool-use.js'"
    );
}

#[test]
fn a_path_with_javascript_punctuation_is_only_a_json_string() {
    let path = r#"/plugins/"; spawn("other"); // \\safe"#;
    let adapter = rendered(path);
    let literal = json!(path).to_string();

    assert_only_slots_differ(
        &on_client(PRE_TOOL_USE),
        file(&adapter, "pre-tool-use.js"),
        &literal,
    );
}

#[test]
fn render_refuses_unsafe_values() {
    for (plugin_dir, codex_dir, version, name) in [
        ("relative", CODEX_DIR, "1", "plugin_dir"),
        ("/plugins/__TACK_BUDGET_MS__", CODEX_DIR, "1", "plugin_dir"),
        ("/plugins/new\nline", CODEX_DIR, "1", "plugin_dir"),
        ("/plugins/safe-push", "out/codex", "1", "codex_dir"),
        ("/plugins/safe-push", "/out/\rcodex", "1", "codex_dir"),
        (
            "/plugins/safe-push",
            CODEX_DIR,
            "__TACK_VERSION__",
            "version",
        ),
    ] {
        let config = Config {
            plugin_dir: Path::new(plugin_dir),
            codex_dir: Path::new(codex_dir),
            version,
        };

        assert_eq!(render(&config), Err(CodexError::Unsafe(name)));
    }
}

#[test]
fn errors_display_their_machine_readable_messages() {
    for (error, expected) in [
        (CodexError::Unsafe("plugin_dir"), "unsafe_value:plugin_dir"),
        (
            CodexError::MissingToken("__TACK_X__"),
            "missing_token:__TACK_X__",
        ),
        (CodexError::UnreplacedToken, "unreplaced_token"),
        (CodexError::Home("x".into()), "codex_home:x"),
        (CodexError::Hooks("x".into()), "codex_hooks:x"),
        (CodexError::Config("x".into()), "codex_config:x"),
        (CodexError::Io("x".into()), "io:x"),
    ] {
        assert_eq!(error.to_string(), expected);
    }
}
