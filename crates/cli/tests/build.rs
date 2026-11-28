//! In-process proofs of the build pipeline. No daemon, `OpenCode` or child
//! process runs; only the library APIs and a temporary folder are used.

#![cfg(test)]

use std::collections::HashMap;
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

/// Splits emitted declarations into their `export type` bodies, keyed by name.
fn declared_types(text: &str) -> HashMap<String, String> {
    let mut types = HashMap::new();
    let mut current: Option<(String, String)> = None;

    for line in text.lines() {
        if let Some(definition) = line.strip_prefix("export type ") {
            if let Some((name, body)) = current.take() {
                types.insert(name, body);
            }
            let (name, _) = definition
                .split_once(" =")
                .expect("type name and definition");
            current = Some((name.to_owned(), format!("{line}\n")));
        } else if let Some((_, body)) = &mut current {
            body.push_str(line);
            body.push('\n');
        }
    }
    if let Some((name, body)) = current {
        types.insert(name, body);
    }
    types
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

#[cfg(unix)]
#[test]
fn a_directory_at_the_sdk_declaration_path_is_a_named_error() {
    let scratch = Scratch::new();
    let out = scratch.path().join("out");
    let declarations = out.join("sdk").join("tack.d.luau");
    std::fs::create_dir_all(&declarations).expect("declaration directory");

    let error = build(&fixture(), &out, BuildOptions::default()).expect_err("directory is refused");

    assert!(matches!(error, tack_cli::BuildError::Io(_)));
    assert!(error.to_string().contains("Is a directory"));
}

#[test]
fn sdk_declarations_pin_hook_table_types() {
    let scratch = Scratch::new();
    let plugin = sdk_plugin(&scratch);
    let out = scratch.path().join("dist");

    build(&plugin, &out, BuildOptions::default()).expect("sdk plugin builds");

    let declarations = std::fs::read_to_string(out.join("sdk").join("tack.d.luau"))
        .expect("SDK declarations are readable");
    assert_eq!(declarations, TACK_D_LUAU);

    for name in [
        "export type HookHandler",
        "export type HookTable",
        "export type OnError = \"deliver\" | \"deny\"",
        "export type AnnotateResult",
        "export type DropResult",
        "export type AllowResult",
        "export type HookResult",
        "eventBefore:",
        "annotate: (fields:",
        "drop: () ->",
        "export type Control",
        "control: Control?",
    ] {
        assert!(declarations.contains(name), "missing declaration: {name}");
    }
}

#[test]
fn a_table_valued_hook_fixture_still_builds() {
    let scratch = Scratch::new();
    let plugin = scratch.path().join("plugin");
    std::fs::create_dir_all(&plugin).expect("plugin folder");
    std::fs::write(
        plugin.join("plugin.luau"),
        r#"return {
    name = "hook-table-plugin",
    needs = { "sdk" },
    toolBefore = {
        {
            priority = 10,
            budgetMs = 3000,
            onError = "deliver",
            run = function(payload, ctx) return ctx.allow() end,
        },
    },
}"#,
    )
    .expect("plugin manifest");
    let out = scratch.path().join("dist");

    build(&plugin, &out, BuildOptions::default()).expect("table-valued hook fixture builds");

    let declarations = out.join("sdk").join("tack.d.luau");
    assert!(declarations.exists());
    let emitted = std::fs::read_to_string(&declarations).expect("SDK declarations are readable");
    assert_eq!(emitted, TACK_D_LUAU);

    let types = declared_types(&emitted);
    for name in [
        "HookHandler",
        "HookTable",
        "ToolBeforeHandler",
        "ToolBeforeHookTable",
        "HookResult",
        "OnError",
        "AnnotateResult",
        "DropResult",
        "AllowResult",
        "HookCtx",
        "Plugin",
    ] {
        assert!(types.contains_key(name), "missing type: {name}");
    }

    assert!(types["HookTable"].contains("HookHandler"));
    assert!(types["ToolBeforeHookTable"].contains("ToolBeforeHandler"));
    assert!(types["ToolBeforeHandler"].contains("ctx: ToolBeforeCtx"));
    assert!(types["Plugin"].contains("toolBefore: (ToolBeforeFn | ToolBeforeHookTable)?"));
    assert!(types["Plugin"].contains("eventBefore: (EventBeforeFn | HookTable)?"));

    for field in [
        "priority",
        "budgetMs",
        "onError",
        "run: (payload: any, ctx: HookCtx) -> HookResult?",
    ] {
        assert!(
            types["HookHandler"].contains(field),
            "HookHandler missing: {field}"
        );
    }
}

#[test]
fn a_control_call_missing_from_needs_fails_the_build() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"return {
    name = "control-plugin",
    needs = { "sdk" },
    eventBefore = function(payload, ctx)
        ctx.control.call("navigate", payload)
        return ctx.allow()
    end,
}"#,
    );
    let out = scratch.path().join("dist");

    let error = build(scratch.path(), &out, BuildOptions::default())
        .expect_err("an undeclared control call is refused");

    assert!(matches!(
        &error,
        tack_cli::BuildError::UngrantedCapability(name) if name.as_str() == "navigate"
    ));
    assert_eq!(error.to_string(), "ungranted_capability:navigate");
}

#[test]
fn a_declared_control_call_builds() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"return {
    name = "control-plugin",
    needs = { "sdk", "control.call.navigate" },
    eventBefore = function(payload, ctx)
        ctx.control.call("navigate", payload)
        return ctx.allow()
    end,
}"#,
    );
    let out = scratch.path().join("dist");

    build(scratch.path(), &out, BuildOptions::default()).expect("a declared control call builds");
}

#[test]
fn a_plugin_cannot_require_a_runtime_client_module() {
    for spec in ["@tack/control", "tack/control"] {
        let scratch = Scratch::new();
        scratch.write(
            "plugin.luau",
            &format!(
                r#"local client = require("{spec}")

return {{ name = "client-plugin", needs = {{ "sdk" }}, tools = {{ client = client }} }}"#
            ),
        );
        let out = scratch.path().join("dist");

        let error = build(scratch.path(), &out, BuildOptions::default())
            .expect_err("a runtime client module is not importable");

        let tack_cli::BuildError::Sandbox(tack_luau::EngineError::Load(
            tack_luau::LoadCause::Require(cause),
        )) = &error
        else {
            panic!("expected a require error for {spec}, got {error:?}");
        };
        assert_eq!(cause, &tack_luau::RequireCause::Missing(spec.to_owned()));
        assert_eq!(
            cause.to_string(),
            format!("require module not found: {spec}")
        );
    }
}

#[cfg(test)]
mod audit_tests {
    use super::*;

    // No --!strict analysis test: this build path has no Luau analyzer.

    /// A plugin whose only hook holds the call under test.
    fn source(needs: &str, body: &str) -> String {
        format!(
            r#"return {{
    name = "audit-plugin",
    needs = {{ "sdk", {needs} }},
    eventBefore = function(payload, ctx)
        {body}
        return ctx.allow()
    end,
}}"#
        )
    }

    fn refused(scratch: &Scratch, source: &str) -> tack_cli::BuildError {
        scratch.write("plugin.luau", source);
        let out = scratch.path().join("dist");

        build(scratch.path(), &out, BuildOptions::default())
            .expect_err("the capability audit refuses the plugin")
    }

    fn assert_dynamic(error: &tack_cli::BuildError) {
        assert!(
            matches!(error, tack_cli::BuildError::DynamicCapability),
            "expected a dynamic capability, got {error:?}"
        );
    }

    fn dynamic(source: &str) {
        let scratch = Scratch::new();
        assert_dynamic(&refused(&scratch, source));
    }

    #[test]
    fn single_quoted_capability_names_are_dynamic() {
        dynamic(&source("", "ctx.control.call('navigate', payload)"));
    }

    #[test]
    fn long_bracket_capability_names_are_dynamic() {
        dynamic(&source("", "ctx.control.call([[navigate]], payload)"));
    }

    #[test]
    fn whitespace_before_the_call_parenthesis_is_dynamic() {
        dynamic(&source("", "ctx.control.call (\"navigate\", payload)"));
    }

    #[test]
    fn a_whitespace_separated_capability_call_is_refused() {
        dynamic(&source("", "ctx . control . call(\"navigate\", p)"));
    }

    #[test]
    fn a_colon_method_call_is_dynamic() {
        dynamic(&source("", "control:call(\"navigate\", payload)"));
    }

    #[test]
    fn a_bracket_indexed_control_is_dynamic() {
        dynamic(&source("", "ctx[\"control\"].call(\"navigate\", payload)"));
    }

    #[test]
    fn an_aliased_control_is_dynamic() {
        dynamic(&source(
            "",
            "local c = ctx.control\n        c.call(\"navigate\", payload)",
        ));
    }

    #[test]
    fn a_non_literal_capability_name_is_dynamic() {
        dynamic(&source("", "ctx.control.call(name, payload)"));
    }

    #[test]
    fn an_empty_capability_name_is_dynamic() {
        dynamic(&source("", "control.call(\"\", payload)"));
    }

    #[test]
    fn an_undeclared_literal_names_the_capability() {
        let scratch = Scratch::new();
        let error = refused(
            &scratch,
            &source("", "ctx.control.call(\"navigate\", payload)"),
        );

        assert_eq!(error.to_string(), "ungranted_capability:navigate");
    }

    #[test]
    fn an_undeclared_literal_is_refused_beside_a_declared_one() {
        let scratch = Scratch::new();
        let error = refused(
            &scratch,
            &source(
                "\"control.call.navigate\"",
                "ctx.control.call(\"navigate\", payload)\n        ctx.control.call(\"other\", payload)",
            ),
        );

        assert!(
            matches!(
                &error,
                tack_cli::BuildError::UngrantedCapability(name) if name == "other"
            ),
            "expected the undeclared name, got {error:?}"
        );
    }

    #[test]
    fn a_declared_literal_in_a_second_source_file_builds() {
        let scratch = Scratch::new();
        scratch.write(
            "plugin.luau",
            &source(
                "\"control.call.navigate\"",
                "ctx.control.call(\"navigate\", payload)",
            ),
        );
        scratch.write(
            "helpers.luau",
            r#"return {
    run = function(ctx)
        ctx.control.call("navigate", {})
        return true
    end,
}"#,
        );
        let out = scratch.path().join("dist");

        build(scratch.path(), &out, BuildOptions::default()).expect("declared calls build");
    }

    #[test]
    fn invalid_need_entries_are_refused_by_name() {
        let long = format!("control.call.{}", "a".repeat(200));
        for entry in ["control.call.bad-name", "control.call.", long.as_str()] {
            let scratch = Scratch::new();
            let error = refused(&scratch, &source(&format!("\"{entry}\""), ""));

            assert!(
                matches!(
                    &error,
                    tack_cli::BuildError::InvalidCapabilityEntry(value) if value == entry
                ),
                "expected an invalid entry for {entry}, got {error:?}"
            );
        }
    }

    #[test]
    fn more_than_128_needs_are_refused() {
        let needs = (0..129)
            .map(|i| format!("\"control.call.cap{i}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let scratch = Scratch::new();
        let error = refused(&scratch, &source(&needs, ""));

        assert!(
            matches!(&error, tack_cli::BuildError::CapabilityCount),
            "expected CapabilityCount, got {error:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_luau_source_is_an_audit_limit() {
        use std::os::unix::fs::symlink;

        let scratch = Scratch::new();
        let plugin = scratch.path().join("plugin");
        std::fs::create_dir_all(&plugin).expect("plugin folder");
        std::fs::write(plugin.join("plugin.luau"), source("", "")).expect("plugin manifest");
        std::fs::write(plugin.join("real.luau"), "return true").expect("linked file");
        symlink(plugin.join("real.luau"), plugin.join("linked.luau")).expect("source symlink");
        let out = scratch.path().join("dist");

        let error = build(&plugin, &out, BuildOptions::default())
            .expect_err("a symlinked source is refused");

        assert!(
            matches!(&error, tack_cli::BuildError::AuditLimit),
            "expected AuditLimit, got {error:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_luau_source_outside_the_plugin_root_is_an_audit_limit() {
        use std::os::unix::fs::symlink;

        let scratch = Scratch::new();
        let plugin = scratch.path().join("plugin");
        std::fs::create_dir_all(&plugin).expect("plugin folder");
        std::fs::write(plugin.join("plugin.luau"), source("", "")).expect("plugin manifest");
        let outside = scratch.path().join("outside.luau");
        std::fs::write(&outside, "return true").expect("outside file");
        symlink(&outside, plugin.join("outside.luau")).expect("source symlink");
        let out = scratch.path().join("dist");

        let error = build(&plugin, &out, BuildOptions::default())
            .expect_err("a source outside the plugin folder is refused");

        assert!(
            matches!(&error, tack_cli::BuildError::AuditLimit),
            "expected AuditLimit, got {error:?}"
        );
    }

    #[test]
    fn a_multibyte_character_after_a_granted_call_does_not_hide_a_later_call() {
        let scratch = Scratch::new();
        // The audit is a text scan: this comment holds a granted call whose
        // closing quote is immediately followed by a multibyte character.
        let error = refused(
            &scratch,
            &source(
                "\"control.call.first\"",
                "-- ctx.control.call(\"first\"é ctx.control.call(\"navigate\", payload)",
            ),
        );

        assert!(
            matches!(
                &error,
                tack_cli::BuildError::UngrantedCapability(name) if name == "navigate"
            ),
            "expected the call after the multibyte character, got {error:?}"
        );
    }

    #[test]
    fn the_129th_capability_call_is_an_audit_limit() {
        for (count, ok) in [(128usize, true), (129usize, false)] {
            let body = vec![r#"ctx.control.call("cap", payload)"#; count].join("\n");
            let text = source("\"control.call.cap\"", &body);
            let scratch = Scratch::new();
            scratch.write("plugin.luau", &text);
            let out = scratch.path().join("dist");

            if ok {
                build(scratch.path(), &out, BuildOptions::default())
                    .expect("128 declared calls build");
                continue;
            }

            let error = build(scratch.path(), &out, BuildOptions::default())
                .expect_err("the 129th call exceeds the audit limit");
            assert!(
                matches!(&error, tack_cli::BuildError::AuditLimit),
                "expected AuditLimit, got {error:?}"
            );
        }
    }

    #[test]
    fn an_oversized_luau_source_is_an_audit_limit() {
        let exact = "x".repeat(1024 * 1024);
        let oversized = "x".repeat(1024 * 1024 + 1);

        for (bytes, ok) in [(exact.as_str(), true), (oversized.as_str(), false)] {
            let scratch = Scratch::new();
            scratch.write("plugin.luau", &source("", ""));
            scratch.write("large.luau", bytes);
            let out = scratch.path().join("dist");

            if ok {
                build(scratch.path(), &out, BuildOptions::default())
                    .expect("a 1 MiB source builds");
                continue;
            }

            let error = build(scratch.path(), &out, BuildOptions::default())
                .expect_err("an oversized source is refused");
            assert!(
                matches!(&error, tack_cli::BuildError::AuditLimit),
                "expected AuditLimit, got {error:?}"
            );
        }
    }

    #[test]
    fn a_128_needs_build() {
        let modules = ["sandbox", "daemon", "opencode", "sdk"];

        for (count, ok) in [(128usize, true), (129usize, false)] {
            let needs = (0..count)
                .map(|i| format!("\"{}\"", modules[i % modules.len()]))
                .collect::<Vec<_>>()
                .join(", ");
            let scratch = Scratch::new();
            scratch.write("plugin.luau", &source(&needs, ""));
            let out = scratch.path().join("dist");

            if ok {
                build(scratch.path(), &out, BuildOptions::default())
                    .expect("128 valid needs build");
                continue;
            }

            let error = build(scratch.path(), &out, BuildOptions::default())
                .expect_err("the 129th need is refused");
            assert!(
                matches!(&error, tack_cli::BuildError::CapabilityCount),
                "expected CapabilityCount, got {error:?}"
            );
        }
    }

    #[test]
    fn a_128_byte_capability_ident_builds() {
        for (length, ok) in [(128usize, true), (129usize, false)] {
            let ident = "a".repeat(length);
            let entry = format!("control.call.{ident}");
            let needs = format!("\"{entry}\"");
            let body = format!("ctx.control.call(\"{ident}\", payload)");
            let scratch = Scratch::new();
            scratch.write("plugin.luau", &source(&needs, &body));
            let out = scratch.path().join("dist");

            if ok {
                build(scratch.path(), &out, BuildOptions::default())
                    .expect("a 128 byte identifier builds");
                continue;
            }

            let error = build(scratch.path(), &out, BuildOptions::default())
                .expect_err("a 129 byte identifier is refused");
            assert!(
                matches!(
                    &error,
                    tack_cli::BuildError::InvalidCapabilityEntry(value) if value == &entry
                ),
                "expected InvalidCapabilityEntry for {entry}, got {error:?}"
            );
        }
    }

    #[test]
    fn a_64_luau_files_build() {
        for (extra, ok) in [(63usize, true), (64usize, false)] {
            let scratch = Scratch::new();
            scratch.write("plugin.luau", &source("", ""));

            for i in 0..extra {
                scratch.write(&format!("extra{i}.luau"), "return true");
            }

            let out = scratch.path().join("dist");

            if ok {
                build(scratch.path(), &out, BuildOptions::default())
                    .expect("64 Luau sources build");
                continue;
            }

            let error = build(scratch.path(), &out, BuildOptions::default())
                .expect_err("the 65th Luau source is refused");
            assert!(
                matches!(&error, tack_cli::BuildError::AuditLimit),
                "expected AuditLimit, got {error:?}"
            );
        }
    }

    #[test]
    fn more_than_256_plugin_entries_are_an_audit_limit() {
        for (count, ok) in [(256usize, true), (257usize, false)] {
            let scratch = Scratch::new();
            scratch.write("plugin.luau", &source("", ""));

            for i in 0..count - 1 {
                scratch.write(&format!("entry{i}.txt"), "x");
            }

            let out = scratch.path().join("dist");

            if ok {
                build(scratch.path(), &out, BuildOptions::default())
                    .expect("256 plugin entries build");
                continue;
            }

            let error = build(scratch.path(), &out, BuildOptions::default())
                .expect_err("the 257th plugin entry is refused");
            assert!(
                matches!(&error, tack_cli::BuildError::AuditLimit),
                "expected AuditLimit, got {error:?}"
            );
        }
    }

    #[test]
    fn a_non_ctx_qualifier_is_refused_by_name() {
        let scratch = Scratch::new();
        let error = refused(
            &scratch,
            &source(
                "\"control.call.navigate\"",
                "myctx.control.call(\"navigate\", payload)",
            ),
        );

        assert!(
            matches!(&error, tack_cli::BuildError::ControlCallForm),
            "expected ControlCallForm, got {error:?}"
        );
        let message = error.to_string();
        assert!(message.contains("control_call_form"), "{message}");
        assert!(message.contains("ctx.control.call"), "{message}");
    }

    #[test]
    fn a_bracket_indexed_control_call_is_refused() {
        let scratch = Scratch::new();
        let error = refused(
            &scratch,
            &source(
                "\"control.call.navigate\"",
                "ctx['control'].call(\"navigate\", payload)",
            ),
        );

        assert!(
            matches!(&error, tack_cli::BuildError::DynamicCapability),
            "expected DynamicCapability, got {error:?}"
        );
    }

    #[test]
    fn a_deep_plugin_tree_is_an_audit_limit() {
        let scratch = Scratch::new();
        scratch.write("plugin.luau", &source("", ""));
        let mut nested = scratch.path().to_path_buf();

        for i in 0..9 {
            nested.push(format!("d{i}"));
        }

        std::fs::create_dir_all(&nested).expect("deep folder");
        std::fs::write(nested.join("deep.luau"), "return true").expect("deep source");
        let out = scratch.path().join("dist");

        let error = build(scratch.path(), &out, BuildOptions::default())
            .expect_err("a source deeper than eight folders is refused");

        assert!(
            matches!(&error, tack_cli::BuildError::AuditLimit),
            "expected AuditLimit, got {error:?}"
        );
    }

    #[test]
    fn build_output_and_vendor_folders_are_skipped() {
        let scratch = Scratch::new();
        scratch.write("plugin.luau", &source("", ""));

        for folder in ["dist", "node_modules"] {
            let dir = scratch.path().join(folder);
            std::fs::create_dir_all(&dir).expect("vendor folder");
            std::fs::write(
                dir.join("evil.luau"),
                "-- ctx.control.call(\"navigate\", payload)",
            )
            .expect("vendor source");
        }

        let out = scratch.path().join("dist");

        build(scratch.path(), &out, BuildOptions::default()).expect("vendor folders are ignored");
    }
}
