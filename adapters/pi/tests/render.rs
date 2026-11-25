//! In-process proofs of the exact extension and the pinned Pi load shape.

#![cfg(test)]

use std::path::Path;

use serde_json::json;
use tack_adapter_pi::{ExtensionError, render};
use tack_protocol::wire::{DenyReason, MAX_FRAME_BYTES, PROTOCOL_VERSION};

const TEMPLATE: &str = include_str!("../register.js");
const FIXTURE_PLUGIN_DIR: &str = "/plugins/safe-push";

fn constant<'a>(script: &'a str, name: &str) -> &'a str {
    let prefix = format!("const {name} = ");

    script
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .and_then(|line| line.strip_suffix(';'))
        .expect("emitted constant")
}

fn assert_template_substitutions(script: &str, plugin_dir_literal: &str) {
    let template_lines = TEMPLATE.split_inclusive('\n');
    let script_lines = script.split_inclusive('\n');

    assert_eq!(template_lines.clone().count(), script_lines.clone().count());

    for (before, after) in template_lines.zip(script_lines) {
        if !before.contains("__TACK_") {
            assert_eq!(before, after);
        }
    }

    let expected = TEMPLATE
        .replace("__TACK_PLUGIN_DIR__", plugin_dir_literal)
        .replace("__TACK_PROTOCOL_VERSION__", "1")
        .replace("__TACK_BUDGET_MS__", "8500")
        .replace("__TACK_MAX_FRAME_BYTES__", "1048576")
        .replace(
            "__TACK_DENY_REASONS__",
            concat!(
                r#"["socket_missing","timeout","socket_closed","malformed_reply","#,
                r#""protocol_version","limit","script","unknown_tool","daemon_error","#,
                r#""aborted","unsupported_hook","socket_untrusted","hook_missing"]"#,
            ),
        );

    assert_eq!(script, expected);
    assert_eq!(script.find("__TACK_"), None);
}

#[test]
fn render_fills_only_template_placeholders() {
    let script = render(Path::new(FIXTURE_PLUGIN_DIR)).expect("render");
    let plugin_dir_literal = json!(FIXTURE_PLUGIN_DIR).to_string();

    assert_template_substitutions(&script, &plugin_dir_literal);
    assert_eq!(constant(&script, "HOOK_BIN"), r#""tack-hook""#);
    assert_eq!(constant(&script, "PLUGIN_DIR"), plugin_dir_literal);
    assert_eq!(constant(&script, "BUDGET_MS"), "8500");
    assert_eq!(
        constant(&script, "PROTOCOL_VERSION"),
        PROTOCOL_VERSION.to_string()
    );
    assert_eq!(
        constant(&script, "MAX_FRAME_BYTES"),
        MAX_FRAME_BYTES.to_string()
    );
    assert_eq!(
        constant(&script, "DENY_REASONS"),
        json!(DenyReason::ALL.map(DenyReason::as_str)).to_string()
    );
}

#[test]
fn pi_loads_one_default_factory_with_only_node_imports() {
    let script = render(Path::new(FIXTURE_PLUGIN_DIR)).expect("render");
    let imports: Vec<_> = script
        .lines()
        .filter(|line| line.trim_start().starts_with("import "))
        .collect();
    let exports: Vec<_> = script
        .lines()
        .filter(|line| line.trim_start().starts_with("export "))
        .collect();

    assert_eq!(exports, ["export default function register(pi) {"]);
    assert_eq!(
        imports,
        [
            r#"import { spawn } from "node:child_process";"#,
            r#"import { appendFileSync } from "node:fs";"#,
        ]
    );
    assert_eq!(script.find("import("), None);
    assert_eq!(script.find(".catch("), None);
}

#[test]
fn a_path_with_javascript_punctuation_is_only_a_json_string() {
    let path = r#"/plugins/"; spawn("other"); // \\safe"#;
    let script = render(Path::new(path)).expect("render");
    let literal = json!(path).to_string();

    assert_eq!(constant(&script, "PLUGIN_DIR"), literal);
    assert_template_substitutions(&script, &literal);
}

#[test]
fn render_refuses_unsafe_paths() {
    for path in [
        "relative/safe-push",
        "/plugins/__TACK_BUDGET_MS__",
        "/plugins/new\nline",
        "/plugins/carriage\rreturn",
        "/plugins/nul\0byte",
    ] {
        assert_eq!(
            render(Path::new(path)),
            Err(ExtensionError::UnsafePluginDir)
        );
    }
}

#[test]
fn extension_errors_display_their_machine_readable_messages() {
    for (error, expected) in [
        (ExtensionError::UnsafePluginDir, "unsafe_value:plugin_dir"),
        (
            ExtensionError::MissingToken("__TACK_PLUGIN_DIR__"),
            "missing_token:__TACK_PLUGIN_DIR__",
        ),
    ] {
        assert_eq!(error.to_string(), expected);
    }
}

#[cfg(unix)]
#[test]
fn render_refuses_a_path_that_cannot_round_trip_through_utf8() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let path = OsStr::from_bytes(b"/plugins/\xff");

    assert_eq!(
        render(Path::new(path)),
        Err(ExtensionError::UnsafePluginDir)
    );
}
