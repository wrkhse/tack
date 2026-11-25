//! In-process proofs of the exact extension and the pinned Pi load shape.

#![cfg(test)]

use std::path::Path;

use serde_json::{Map, Value, json};
use tack_adapter_pi::{ExtensionError, render};
use tack_protocol::wire::{DenyReason, MAX_FRAME_BYTES, PROTOCOL_VERSION};

const TEMPLATE: &str = include_str!("../register.js");

fn fixture_values() -> Map<String, Value> {
    serde_json::from_str(include_str!("../fixture-values.json")).expect("fixture values")
}

fn constant<'a>(script: &'a str, name: &str) -> &'a str {
    let prefix = format!("const {name} = ");

    script
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .and_then(|line| line.strip_suffix(';'))
        .expect("emitted constant")
}

fn assert_template_substitutions(
    script: &str,
    plugin_dir_literal: &str,
    fixture: &Map<String, Value>,
) {
    let template_lines = TEMPLATE.split_inclusive('\n');
    let script_lines = script.split_inclusive('\n');

    assert_eq!(template_lines.clone().count(), script_lines.clone().count());

    for (before, after) in template_lines.zip(script_lines) {
        if !before.contains("__TACK_") {
            assert_eq!(before, after);
        }
    }

    let mut expected = TEMPLATE.replace("__TACK_PLUGIN_DIR__", plugin_dir_literal);

    for (name, value) in fixture {
        if name != "PLUGIN_DIR" {
            expected = expected.replace(&format!("__TACK_{name}__"), &value.to_string());
        }
    }

    assert_eq!(script, expected);
    assert_eq!(script.find("__TACK_"), None);
}

#[test]
fn render_fills_only_template_placeholders() {
    let fixture = fixture_values();
    let plugin_dir = fixture["PLUGIN_DIR"]
        .as_str()
        .expect("fixture plugin directory");
    let script = render(Path::new(plugin_dir)).expect("render");

    assert_template_substitutions(&script, r#""/plugins/safe-push""#, &fixture);
    assert_eq!(constant(&script, "HOOK_BIN"), r#""tack-hook""#);
    assert_eq!(constant(&script, "PLUGIN_DIR"), r#""/plugins/safe-push""#);
    assert_eq!(
        constant(&script, "BUDGET_MS"),
        fixture["BUDGET_MS"].to_string()
    );
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
        fixture["DENY_REASONS"].to_string()
    );
    assert_eq!(
        fixture["DENY_REASONS"],
        json!(DenyReason::ALL.map(DenyReason::as_str))
    );
}

#[test]
fn pi_loads_one_default_factory_with_only_node_imports() {
    let fixture = fixture_values();
    let plugin_dir = fixture["PLUGIN_DIR"]
        .as_str()
        .expect("fixture plugin directory");
    let script = render(Path::new(plugin_dir)).expect("render");
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
    assert_template_substitutions(&script, &literal, &fixture_values());
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
