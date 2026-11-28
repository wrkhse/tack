//! In-process proofs of the build pipeline. No daemon, `OpenCode` or child
//! process runs; only the library APIs and a temporary folder are used.

#![cfg(test)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tack_adapter_opencode::{WrapperConfig, WrapperError};
use tack_cli::{BuildOptions, DAEMON_BIN, build, build_claude, build_codex, build_pi};
use tack_protocol::wire::{DenyReason, PROTOCOL_VERSION, PluginManifest, ToolDef};
use tack_sdk::TACK_D_LUAU;

const TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../adapters/opencode/opencode.js"
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
    PluginManifest {
        name: "safe-push".into(),
        needs: vec![],
        tools: vec![ToolDef {
            name: "guard_status".into(),
            description: "Reports whether the tack daemon is running".into(),
            input: serde_json::json!({}),
        }],
    }
}

fn sdk_plugin(scratch: &Scratch, listed: bool) {
    let needs = if listed { "\"sdk\"" } else { "" };
    scratch.write(
        "plugin.luau",
        &format!("return {{ name = \"sdk-tool\", needs = {{ {needs} }}, tools = {{}} }}"),
    );
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
fn render_fills_only_the_template_placeholders() {
    let manifest = manifest();
    let reasons = reasons();
    let config = config(&manifest, "/plugins/tack", 2000, 3000, &reasons);

    let rendered = tack_adapter_opencode::render(&config).expect("render");

    assert_eq!(rendered.find("__TACK_"), None);

    let template_lines = TEMPLATE.split_inclusive('\n');
    let rendered_lines = rendered.split_inclusive('\n');
    assert_eq!(
        template_lines.clone().count(),
        rendered_lines.clone().count()
    );

    for (template_line, rendered_line) in template_lines.zip(rendered_lines) {
        if !template_line.contains("__TACK_") {
            assert_eq!(rendered_line, template_line);
        }
    }

    let values = [
        (
            "MANIFEST",
            concat!(
                r#"{"name":"safe-push","needs":[],"tools":[{"name":"guard_status","#,
                r#""description":"Reports whether the tack daemon is running","input":{}}]}"#,
            ),
        ),
        ("DAEMON_BIN", r#""tack-daemon""#),
        ("PLUGIN_DIR", r#""/plugins/tack""#),
        (
            "DENY_REASONS",
            concat!(
                r#"["socket_missing","timeout","socket_closed","malformed_reply","#,
                r#""protocol_version","limit","script","unknown_tool","daemon_error","#,
                r#""aborted","unsupported_hook","socket_untrusted","hook_missing","busy"]"#,
            ),
        ),
        ("CALL_TIMEOUT_MS", "2000"),
        ("START_TIMEOUT_MS", "3000"),
        ("PROTOCOL_VERSION", "1"),
    ];
    let mut expected = TEMPLATE.to_owned();

    for (name, value) in values {
        assert_eq!(constant(&rendered, name), value, "{name}");
        expected = expected.replace(&format!("__TACK_{name}__"), value);
    }

    assert_eq!(rendered, expected);
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
    let emitted: PluginManifest = serde_json::from_slice(&bytes).expect("manifest parses");

    assert_eq!(emitted, manifest());
}

#[test]
fn a_listing_plugin_emits_the_strict_sdk_declarations() {
    let scratch = Scratch::new();
    sdk_plugin(&scratch, true);
    let out = scratch.path().join("dist");

    build(scratch.path(), &out, BuildOptions::default()).expect("listed plugin builds");

    let declaration = out.join("sdk/tack.d.luau");
    let emitted = std::fs::read_to_string(&declaration).expect("SDK declaration is readable");

    assert_eq!(emitted, TACK_D_LUAU);
    assert!(emitted.starts_with("--!strict\n"));
    assert_eq!(std::fs::read_dir(out.join("sdk")).unwrap().count(), 1);
}

#[test]
fn an_unlisted_plugin_emits_no_sdk_declarations() {
    let scratch = Scratch::new();
    sdk_plugin(&scratch, false);
    let out = scratch.path().join("dist");

    build(scratch.path(), &out, BuildOptions::default()).expect("unlisted plugin builds");

    assert!(!out.join("sdk").exists());
    assert!(out.join("opencode/index.js").exists());
}

#[test]
fn a_later_unlisted_build_removes_stale_sdk_declarations() {
    let scratch = Scratch::new();
    sdk_plugin(&scratch, true);
    let out = scratch.path().join("dist");
    let declaration = out.join("sdk/tack.d.luau");

    build(scratch.path(), &out, BuildOptions::default()).expect("listed plugin builds");
    assert!(declaration.exists());

    sdk_plugin(&scratch, false);
    build(scratch.path(), &out, BuildOptions::default()).expect("unlisted plugin builds");

    assert!(!declaration.exists());
    assert!(out.join("opencode/index.js").exists());
}

#[test]
fn an_sdk_output_path_that_is_a_file_fails() {
    let scratch = Scratch::new();
    let out = scratch.path().join("dist");
    std::fs::create_dir_all(&out).expect("output folder");
    std::fs::write(out.join("sdk"), "not a folder").expect("file at the SDK path");
    sdk_plugin(&scratch, true);

    let result = build(scratch.path(), &out, BuildOptions::default());

    let Err(tack_cli::BuildError::Io(_)) = result else {
        panic!("an I/O error is reported");
    };
    assert!(!out.join("opencode").exists());
}

#[test]
fn a_directory_at_the_declaration_path_fails_the_listed_build() {
    let scratch = Scratch::new();
    let out = scratch.path().join("dist");
    std::fs::create_dir_all(out.join("sdk/tack.d.luau"))
        .expect("directory at the declaration path");
    sdk_plugin(&scratch, true);

    let result = build(scratch.path(), &out, BuildOptions::default());

    let Err(tack_cli::BuildError::Io(_)) = result else {
        panic!("an I/O error is reported");
    };
    assert!(!out.join("opencode").exists());
}

#[test]
fn a_directory_at_the_declaration_path_fails_the_unlisted_build() {
    let scratch = Scratch::new();
    let out = scratch.path().join("dist");
    std::fs::create_dir_all(out.join("sdk/tack.d.luau"))
        .expect("directory at the declaration path");
    sdk_plugin(&scratch, false);

    let result = build(scratch.path(), &out, BuildOptions::default());

    let Err(tack_cli::BuildError::Io(_)) = result else {
        panic!("an I/O error is reported");
    };
    assert!(!out.join("opencode").exists());
}

#[test]
fn every_build_target_emits_the_sdk_declarations() {
    let scratch = Scratch::new();
    sdk_plugin(&scratch, true);

    let opencode = scratch.path().join("out-opencode");
    build(scratch.path(), &opencode, BuildOptions::default()).expect("OpenCode build");

    let claude = scratch.path().join("out-claude");
    build_claude(scratch.path(), &claude).expect("Claude build");

    let pi = scratch.path().join("out-pi");
    build_pi(scratch.path(), &pi).expect("Pi build");

    let codex = scratch.path().join("out-codex");
    build_codex(scratch.path(), &codex, scratch.path()).expect("Codex build");

    for out in [&opencode, &claude, &pi, &codex] {
        assert_eq!(
            std::fs::read_to_string(out.join("sdk/tack.d.luau")).unwrap(),
            TACK_D_LUAU
        );
    }
}
