//! In-process proofs of the build pipeline. No daemon, `OpenCode` or child
//! process runs; only the library APIs and a temporary folder are used.

#![cfg(test)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tack_adapter_opencode::{WrapperConfig, WrapperError};
use tack_cli::{BuildOptions, DAEMON_BIN, build};
use tack_luau::{Capabilities, Limits, Sandbox, api};
use tack_protocol::wire::{DenyReason, PROTOCOL_VERSION, PluginManifest, ToolDef};
use tack_protocol::{DEFAULT_DEADLINE_MS, DEFAULT_MEMORY_BYTES};

const GOLDEN: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../adapters/opencode/golden/opencode.js"
));

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
            "tack-build-{}-{}-{}",
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

    fn write(&self, name: &str, contents: &str) {
        std::fs::write(self.root.join(name), contents).expect("fixture file");
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

fn manifest() -> PluginManifest {
    let limits = Limits {
        memory_bytes: DEFAULT_MEMORY_BYTES,
        call_deadline_ms: DEFAULT_DEADLINE_MS,
    };
    let sandbox = Sandbox::new(&fixture(), limits, Capabilities::default()).expect("fixture loads");
    let api::Manifest { name, needs, tools } = sandbox.manifest().expect("manifest reads");

    PluginManifest {
        name,
        needs,
        tools: tools
            .into_iter()
            .map(|tool| ToolDef {
                name: tool.name,
                description: tool.description,
                input: tool.input,
            })
            .collect(),
    }
}

fn reasons() -> Vec<&'static str> {
    DenyReason::ALL
        .iter()
        .map(|reason| reason.as_str())
        .collect()
}

const fn config<'a>(
    manifest: &'a PluginManifest,
    plugin_dir: &'a str,
    call_timeout_ms: u64,
    start_timeout_ms: u64,
    deny_reasons: &'a [&'a str],
) -> WrapperConfig<'a> {
    WrapperConfig {
        manifest,
        daemon_bin: DAEMON_BIN,
        plugin_dir,
        protocol_version: PROTOCOL_VERSION,
        deny_reasons,
        call_timeout_ms,
        start_timeout_ms,
    }
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
fn render_matches_the_checked_in_golden() {
    let manifest = manifest();
    let reasons = reasons();
    let config = config(&manifest, "/plugins/tack", 2000, 3000, &reasons);

    let rendered = tack_adapter_opencode::render(&config).expect("render");

    assert_eq!(rendered, GOLDEN);
}

#[test]
fn build_emits_exact_constants_and_a_canonical_plugin_dir() {
    let scratch = Scratch::new();
    let out = scratch.path().join("dist");
    let messy = fixture().join("..").join("safe-push");
    let options = BuildOptions {
        call_timeout_ms: 150,
        start_timeout_ms: 300,
    };

    let (index, _) = build(&messy, &out, options).expect("fixture builds");
    let script = std::fs::read_to_string(&index).expect("wrapper is readable");

    let canonical = std::fs::canonicalize(fixture()).expect("canonical fixture");
    assert_eq!(
        constant(&script, "MANIFEST"),
        serde_json::to_string(&manifest()).expect("manifest JSON")
    );
    assert_eq!(
        constant(&script, "PLUGIN_DIR"),
        format!("\"{}\"", canonical.display())
    );
    assert_eq!(constant(&script, "DAEMON_BIN"), format!("\"{DAEMON_BIN}\""));
    assert_eq!(constant(&script, "CALL_TIMEOUT_MS"), "150");
    assert_eq!(constant(&script, "START_TIMEOUT_MS"), "300");
    assert_eq!(constant(&script, "PROTOCOL_VERSION"), "1");
    assert_eq!(
        constant(&script, "DENY_REASONS"),
        serde_json::to_string(&reasons()).expect("reasons JSON")
    );
    assert!(!script.contains("__TACK_"));
    assert!(!script.contains("git push"));
    assert!(!script.contains("push blocked"));
}

#[test]
fn an_unknown_need_fails_by_name() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"return { name = "barn-plugin", needs = { "barn" }, tools = {} }"#,
    );
    let out = scratch.path().join("dist");

    let error =
        build(scratch.path(), &out, BuildOptions::default()).expect_err("unknown need is refused");

    assert_eq!(error.to_string(), "need_missing:barn");
}

#[test]
fn an_unsafe_token_value_is_refused() {
    let manifest = manifest();
    let reasons = reasons();
    let mut config = config(&manifest, "/plugins/tack", 2000, 3000, &reasons);
    config.daemon_bin = "tack-daemon\nspawn other";

    let error = tack_adapter_opencode::render(&config).expect_err("unsafe value is refused");

    assert_eq!(error, WrapperError::UnsafeValue("daemon_bin"));
}

#[test]
fn the_manifest_json_has_the_plugin_contract() {
    let scratch = Scratch::new();
    let out = scratch.path().join("dist");

    let (_, descriptor) = build(&fixture(), &out, BuildOptions::default()).expect("fixture builds");
    let bytes = std::fs::read(&descriptor).expect("manifest is readable");
    let manifest: PluginManifest = serde_json::from_slice(&bytes).expect("manifest parses");

    assert_eq!(manifest.name, "safe-push");
    assert_eq!(manifest.tools.len(), 1);
    assert_eq!(manifest.tools[0].name, "guard_status");
}
