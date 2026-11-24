//! In-process proofs of the exact extension and the pinned Pi load shape.

#![cfg(test)]

use std::path::Path;

use serde_json::json;
use tack_adapter_pi::{ExtensionError, render};
use tack_protocol::wire::{DenyReason, MAX_FRAME_BYTES, PROTOCOL_VERSION};

const GOLDEN: &str = include_str!("../golden/register.js");

fn constant<'a>(script: &'a str, name: &str) -> &'a str {
    let prefix = format!("const {name} = ");

    script
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .and_then(|line| line.strip_suffix(';'))
        .expect("emitted constant")
}

#[test]
fn render_matches_the_checked_in_golden() {
    let script = render(Path::new("/plugins/safe-push")).expect("render");

    assert_eq!(script, GOLDEN);
    assert_eq!(script.find("__TACK_"), None);
    assert_eq!(constant(&script, "HOOK_BIN"), r#""tack-hook""#);
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
    let imports: Vec<_> = GOLDEN
        .lines()
        .filter(|line| line.trim_start().starts_with("import "))
        .collect();
    let exports: Vec<_> = GOLDEN
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
    assert_eq!(GOLDEN.find("import("), None);
    assert_eq!(GOLDEN.find(".catch("), None);
}

#[test]
fn a_path_with_javascript_punctuation_is_only_a_json_string() {
    let path = r#"/plugins/"; spawn("other"); // \\safe"#;
    let script = render(Path::new(path)).expect("render");
    let literal = json!(path).to_string();

    assert_eq!(constant(&script, "PLUGIN_DIR"), literal);
    assert_eq!(script, GOLDEN.replace(r#""/plugins/safe-push""#, &literal));
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
