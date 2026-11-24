//! In-process proofs of `tack build --target claude`. No daemon, Claude Code,
//! Node or child process runs; only the library API and a temporary folder.

#![cfg(test)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tack_cli::{HOOK_BIN, build_claude};
use tack_protocol::wire::DenyReason;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock is after the epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "tack-build-claude-{}-{}-{}",
            std::process::id(),
            unique,
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("scratch folder");
        Self { root }
    }

    fn path(&self) -> &Path {
        &self.root
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/safe-push")
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).expect("emitted file is readable")
}

fn constant<'a>(script: &'a str, name: &str) -> &'a str {
    let prefix = format!("const {name} = ");
    let line = script
        .lines()
        .find(|line| line.starts_with(&prefix))
        .expect("emitted constant");
    let value = line.strip_prefix(&prefix).expect("prefix");
    value.strip_suffix(';').expect("semicolon")
}

#[test]
fn build_claude_emits_the_plugin_folder() {
    let scratch = Scratch::new();
    let out = scratch.path().join("dist");
    let messy = fixture().join("..").join("safe-push");

    let written = build_claude(&messy, &out).expect("fixture builds");

    let root = out.join("claude");
    assert_eq!(
        written,
        [
            root.join(".claude-plugin/plugin.json"),
            root.join("hooks/hooks.json"),
            root.join("hooks/register.js"),
        ]
    );
    assert_eq!(
        read(&root.join(".claude-plugin/plugin.json")),
        format!(
            "{{\n  \"name\": \"tack\",\n  \"version\": \"{}\"\n}}\n",
            env!("CARGO_PKG_VERSION")
        )
    );
    assert_eq!(
        read(&root.join("hooks/hooks.json")),
        "{\n  \"modules\": [\n    \"./register.js\"\n  ]\n}\n"
    );
}

#[test]
fn the_mod_carries_the_manifest_and_a_canonical_plugin_dir() {
    let scratch = Scratch::new();
    let out = scratch.path().join("dist");

    build_claude(&fixture(), &out).expect("fixture builds");
    let script = read(&out.join("claude/hooks/register.js"));

    let canonical = std::fs::canonicalize(fixture()).expect("canonical fixture");
    let reasons: Vec<&str> = DenyReason::ALL
        .iter()
        .map(|reason| reason.as_str())
        .collect();

    assert_eq!(HOOK_BIN, "tack-hook");
    assert_eq!(constant(&script, "HOOK_BIN"), "\"tack-hook\"");
    assert_eq!(
        constant(&script, "PLUGIN_DIR"),
        format!("\"{}\"", canonical.display())
    );
    assert_eq!(
        constant(&script, "TOOLS"),
        "[{\"description\":\"Reports whether the tack daemon is running\",\
         \"inputSchema\":{\"type\":\"object\"},\"isDeferred\":false,\"name\":\"guard_status\"}]"
    );
    assert_eq!(constant(&script, "PROTOCOL_VERSION"), "1");
    assert_eq!(constant(&script, "BUDGET_MS"), "9000");
    assert_eq!(constant(&script, "TOOL_PREFIX"), "\"mcp__tack__\"");
    assert_eq!(
        constant(&script, "DENY_REASONS"),
        serde_json::to_string(&reasons).expect("reasons JSON")
    );
    assert_eq!(script.find("__TACK_"), None);
    assert_eq!(script.find("git push"), None);
    assert_eq!(script.find("push blocked"), None);
}

#[test]
fn an_unknown_need_fails_by_name_for_claude() {
    let scratch = Scratch::new();
    std::fs::write(
        scratch.path().join("plugin.luau"),
        r#"return { name = "barn-plugin", needs = { "barn" }, tools = {} }"#,
    )
    .expect("fixture file");
    let out = scratch.path().join("dist");

    let error = build_claude(scratch.path(), &out).expect_err("unknown need is refused");

    assert_eq!(error.to_string(), "need_missing:barn");
    assert!(!out.join("claude").exists());
}
