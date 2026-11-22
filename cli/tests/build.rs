//! In-process proofs of the build pipeline. No daemon, OpenCode or child
//! process runs; only the library APIs and a temporary folder are used.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tack_protocol::wire::{DenyReason, PROTOCOL_VERSION, PluginManifest};
use tack_wrapper::WrapperConfig;

#[allow(dead_code)]
#[path = "../src/main.rs"]
mod cli;

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
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/safe-push")
}

fn expected_script(folder: &Path, manifest: &PluginManifest) -> String {
    let reasons: Vec<&str> = DenyReason::ALL
        .iter()
        .map(|reason| reason.as_str())
        .collect();
    let bin = cli::daemon_bin().expect("daemon path");
    let plugin = folder.to_string_lossy();
    let config = WrapperConfig {
        manifest,
        daemon_bin: &bin,
        plugin_dir: &plugin,
        protocol_version: PROTOCOL_VERSION,
        deny_reasons: &reasons,
        call_timeout_ms: 2000,
        start_timeout_ms: 3000,
    };
    tack_wrapper::render(&config).expect("render")
}

#[test]
fn build_emits_the_rendered_wrapper_without_rule_logic() {
    let fixture = fixture();
    let scratch = Scratch::new();
    let out = scratch.path().join("dist");

    let (index, _) = cli::build(&fixture, &out).expect("fixture builds");
    let written = std::fs::read_to_string(&index).expect("wrapper is readable");

    let sandbox = tack_runtime::Sandbox::new(
        &fixture,
        tack_protocol::DEFAULT_MEMORY_BYTES,
        tack_protocol::DEFAULT_DEADLINE_MS,
    )
    .expect("fixture loads");
    let manifest = sandbox.manifest().expect("manifest reads");

    assert_eq!(written, expected_script(&fixture, &manifest));
    assert!(!written.contains("git push"));
    assert!(!written.contains("push blocked"));
}

#[test]
fn an_unknown_need_fails_by_name() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"return { name = "barn-plugin", needs = { "barn" }, tools = {} }"#,
    );
    let out = scratch.path().join("dist");

    let error = cli::build(scratch.path(), &out).expect_err("unknown need is refused");
    assert_eq!(error.to_string(), "need_missing:barn");
}

#[test]
fn the_manifest_json_has_the_plugin_contract() {
    let fixture = fixture();
    let scratch = Scratch::new();
    let out = scratch.path().join("dist");

    let (_, descriptor) = cli::build(&fixture, &out).expect("fixture builds");
    let bytes = std::fs::read(&descriptor).expect("manifest is readable");
    let manifest: PluginManifest = serde_json::from_slice(&bytes).expect("manifest parses");

    assert_eq!(manifest.name, "safe-push");
    assert_eq!(manifest.tools.len(), 1);
    assert_eq!(manifest.tools[0].name, "guard_status");
}
