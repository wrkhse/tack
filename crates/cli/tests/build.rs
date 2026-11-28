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

/// A minimal plugin that opts in to the SDK module.
fn sdk_plugin(scratch: &Scratch) -> PathBuf {
    let plugin = scratch.path().join("plugin");
    std::fs::create_dir_all(&plugin).expect("plugin folder");
    std::fs::write(
        plugin.join("plugin.luau"),
        r#"return { name = "sdk-plugin", needs = { "sdk" } }"#,
    )
    .expect("plugin manifest");
    plugin
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
fn sdk_declarations_are_absent_when_unlisted() {
    let scratch = Scratch::new();
    let out = scratch.path().join("dist");

    build(&fixture(), &out, BuildOptions::default()).expect("fixture builds");

    assert!(!out.join("sdk").join("tack.d.luau").exists());
}

#[test]
fn sdk_declarations_are_emitted_when_listed() {
    let scratch = Scratch::new();
    let plugin = scratch.path().join("plugin");
    std::fs::create_dir_all(&plugin).expect("plugin folder");
    std::fs::write(
        plugin.join("plugin.luau"),
        r#"return { name = "sdk-plugin", needs = { "sdk" } }"#,
    )
    .expect("plugin manifest");
    let out = scratch.path().join("dist");

    build(&plugin, &out, BuildOptions::default()).expect("plugin builds");

    let declarations = std::fs::read_to_string(out.join("sdk").join("tack.d.luau"))
        .expect("SDK declarations are readable");
    assert_eq!(declarations, TACK_D_LUAU);
    assert!(declarations.starts_with("--!strict"));
    assert!(declarations.contains("export type Plugin"));
}

#[test]
fn an_unknown_need_still_fails() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"return { name = "unknown-plugin", needs = { "not-a-module" } }"#,
    );
    let out = scratch.path().join("dist");

    let result = build(scratch.path(), &out, BuildOptions::default());

    assert!(matches!(
        result,
        Err(tack_cli::BuildError::NeedMissing(name)) if name == "not-a-module"
    ));
}

#[test]
fn an_unlisted_build_removes_stale_sdk_output() {
    let scratch = Scratch::new();
    let plugin = sdk_plugin(&scratch);
    let out = scratch.path().join("dist");
    let declarations = out.join("sdk").join("tack.d.luau");

    build(&plugin, &out, BuildOptions::default()).expect("sdk plugin builds");
    assert!(declarations.exists());

    build(&fixture(), &out, BuildOptions::default()).expect("fixture builds");
    assert!(!declarations.exists());
}

#[test]
fn build_claude_removes_stale_sdk_output_when_unlisted() {
    let scratch = Scratch::new();
    let plugin = sdk_plugin(&scratch);
    let out = scratch.path().join("dist");
    let declarations = out.join("sdk").join("tack.d.luau");

    build_claude(&plugin, &out).expect("sdk plugin builds");
    assert!(declarations.exists());

    build_claude(&fixture(), &out).expect("fixture builds");
    assert!(!declarations.exists());
}

#[test]
fn build_pi_removes_stale_sdk_output_when_unlisted() {
    let scratch = Scratch::new();
    let plugin = sdk_plugin(&scratch);
    let out = scratch.path().join("dist");
    let declarations = out.join("sdk").join("tack.d.luau");

    build_pi(&plugin, &out).expect("sdk plugin builds");
    assert!(declarations.exists());

    build_pi(&fixture(), &out).expect("fixture builds");
    assert!(!declarations.exists());
}

#[test]
fn build_codex_removes_stale_sdk_output_when_unlisted() {
    let scratch = Scratch::new();
    let plugin = sdk_plugin(&scratch);
    let out = scratch.path().join("dist");
    let home = scratch.path().join("home");
    std::fs::create_dir_all(&home).expect("codex home folder");
    let declarations = out.join("sdk").join("tack.d.luau");

    build_codex(&plugin, &out, &home).expect("sdk plugin builds");
    assert!(declarations.exists());

    build_codex(&fixture(), &out, &home).expect("fixture builds");
    assert!(!declarations.exists());
}

#[test]
fn build_claude_emits_sdk_declarations() {
    let scratch = Scratch::new();
    let plugin = sdk_plugin(&scratch);
    let out = scratch.path().join("dist");
    let declarations = out.join("sdk").join("tack.d.luau");

    let written = build_claude(&plugin, &out).expect("plugin builds");

    let contents = std::fs::read_to_string(&declarations).expect("SDK declarations are readable");
    assert_eq!(contents, TACK_D_LUAU);
    assert!(written.contains(&declarations));
}

#[test]
fn build_pi_emits_sdk_declarations() {
    let scratch = Scratch::new();
    let plugin = sdk_plugin(&scratch);
    let out = scratch.path().join("dist");
    let declarations = out.join("sdk").join("tack.d.luau");

    build_pi(&plugin, &out).expect("plugin builds");

    let contents = std::fs::read_to_string(&declarations).expect("SDK declarations are readable");
    assert_eq!(contents, TACK_D_LUAU);
}

#[test]
fn build_codex_emits_sdk_declarations() {
    let scratch = Scratch::new();
    let plugin = sdk_plugin(&scratch);
    let out = scratch.path().join("dist");
    let home = scratch.path().join("home");
    std::fs::create_dir_all(&home).expect("codex home folder");
    let declarations = out.join("sdk").join("tack.d.luau");

    let written = build_codex(&plugin, &out, &home).expect("plugin builds");

    let contents = std::fs::read_to_string(&declarations).expect("SDK declarations are readable");
    assert_eq!(contents, TACK_D_LUAU);
    assert!(written.contains(&declarations));
}

#[cfg(unix)]
#[test]
fn a_symlinked_sdk_folder_is_refused() {
    use std::os::unix::fs::symlink;

    let scratch = Scratch::new();
    let plugin = sdk_plugin(&scratch);
    let out = scratch.path().join("out");
    std::fs::create_dir_all(&out).expect("out folder");
    let elsewhere = scratch.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).expect("elsewhere folder");
    symlink(&elsewhere, out.join("sdk")).expect("sdk symlink");

    let result = build(&plugin, &out, BuildOptions::default());

    assert!(matches!(result, Err(tack_cli::BuildError::Io(_))));
    assert!(!elsewhere.join("tack.d.luau").exists());
}

#[cfg(unix)]
#[test]
fn a_symlinked_sdk_declaration_is_replaced_not_followed() {
    use std::os::unix::fs::symlink;

    let scratch = Scratch::new();
    let plugin = sdk_plugin(&scratch);
    let out = scratch.path().join("out");
    let sdk = out.join("sdk");
    std::fs::create_dir_all(&sdk).expect("sdk folder");
    let target = scratch.path().join("target");
    std::fs::write(&target, "sentinel").expect("target file");
    symlink(&target, sdk.join("tack.d.luau")).expect("declaration symlink");

    build(&plugin, &out, BuildOptions::default()).expect("plugin builds");

    let declarations = sdk.join("tack.d.luau");
    let meta = std::fs::symlink_metadata(&declarations).expect("declaration metadata");
    assert!(meta.file_type().is_file());
    assert_eq!(
        std::fs::read_to_string(&declarations).expect("declarations are readable"),
        TACK_D_LUAU
    );
    assert_eq!(
        std::fs::read_to_string(&target).expect("target is readable"),
        "sentinel"
    );
}
