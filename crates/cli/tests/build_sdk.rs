//! Build-time proofs of the opt-in SDK declaration. No daemon, agent, Node or
//! child process runs; only the library APIs and fresh scratch folders.

#![cfg(test)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tack_cli::{BuildError, BuildOptions, build, build_claude, build_codex, build_pi};
use tack_sdk::TACK_D_LUAU;

const TARGETS: [&str; 4] = ["opencode", "claude", "pi", "codex"];
const SDK_PLUGIN: &str =
    r#"return { name = "sdk-plugin", needs = {}, modules = { sdk = {} }, tools = {} }"#;
const NO_MODULES: &str = r#"return { name = "sdk-plugin", needs = {}, tools = {} }"#;
const EMPTY_MODULES: &str =
    r#"return { name = "sdk-plugin", needs = {}, modules = {}, tools = {} }"#;
const UNKNOWN_MODULE: &str =
    r#"return { name = "sdk-plugin", needs = {}, modules = { barn = {} }, tools = {} }"#;
const NONEMPTY_CONFIG: &str = r#"return { name = "sdk-plugin", needs = {}, modules = { sdk = { extra = true } }, tools = {} }"#;
const WRONG_CONFIG: &str =
    r#"return { name = "sdk-plugin", needs = {}, modules = { sdk = "yes" }, tools = {} }"#;
const MODULES_NOT_A_TABLE: &str =
    r#"return { name = "sdk-plugin", needs = {}, modules = "sdk", tools = {} }"#;

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
        let created = std::env::temp_dir().join(format!(
            "tack-build-sdk-{}-{}-{}",
            std::process::id(),
            unique,
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&created).expect("scratch folder");
        let root = std::fs::canonicalize(&created).expect("canonical scratch folder");
        Self { root }
    }

    fn plugin(&self, label: &str, source: &str) -> PathBuf {
        let folder = self.root.join(format!("plugin-{label}"));
        std::fs::create_dir_all(&folder).expect("plugin folder");
        std::fs::write(folder.join("plugin.luau"), source).expect("plugin file");
        folder
    }

    fn out(&self, label: &str) -> PathBuf {
        self.root.join(format!("dist-{label}"))
    }

    fn home(&self, label: &str) -> PathBuf {
        let home = self.root.join(format!("home-{label}"));
        std::fs::create_dir_all(&home).expect("codex home");
        home
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn base_outputs(target: &str, out: &Path, home: &Path) -> Vec<PathBuf> {
    match target {
        "opencode" => vec![
            out.join("opencode/index.js"),
            out.join("opencode/manifest.json"),
        ],
        "claude" => vec![
            out.join("claude/.claude-plugin/plugin.json"),
            out.join("claude/hooks/hooks.json"),
            out.join("claude/hooks/register.js"),
        ],
        "pi" => vec![out.join("pi/extension.js")],
        "codex" => vec![
            out.join("codex/hooks.json"),
            out.join("codex/pre-tool-use.js"),
            out.join("codex/session-start.js"),
            out.join("codex/mcp.js"),
            out.join("codex/config.toml"),
            out.join("codex/run-hook.sh"),
            home.join("hooks.json"),
            home.join("config.toml"),
            home.join("tack-hashes"),
        ],
        _ => panic!("unknown test target"),
    }
}

fn build_target(
    target: &str,
    plugin: &Path,
    out: &Path,
    home: &Path,
) -> Result<Vec<PathBuf>, BuildError> {
    match target {
        "opencode" => build(plugin, out, BuildOptions::default()),
        "claude" => build_claude(plugin, out),
        "pi" => build_pi(plugin, out),
        "codex" => build_codex(plugin, out, home),
        _ => panic!("unknown test target"),
    }
}

fn assert_nothing_written(out: &Path, home: &Path) {
    assert!(!out.exists(), "no output folder");
    assert_eq!(
        std::fs::read_dir(home).expect("codex home").count(),
        0,
        "the codex home stays empty"
    );
}

#[test]
fn sdk_opt_in_emits_the_existing_declaration_for_every_target() {
    let scratch = Scratch::new();

    for target in TARGETS {
        let plugin = scratch.plugin(target, SDK_PLUGIN);
        let out = scratch.out(target);
        let home = scratch.home(target);

        let mut written = build_target(target, &plugin, &out, &home).expect("opt-in builds");
        let sdk = written.pop().expect("the SDK path is reported");

        assert_eq!(written, base_outputs(target, &out, &home), "{target}");
        assert_eq!(sdk, out.join("sdk/tack.d.luau"), "{target}");
        assert_eq!(
            std::fs::read(&sdk).expect("declaration is readable"),
            TACK_D_LUAU.as_bytes(),
            "{target}"
        );

        if target == "opencode" {
            let descriptor = std::fs::read_to_string(out.join("opencode/manifest.json"))
                .expect("wire descriptor");
            assert!(
                !descriptor.contains("modules"),
                "metadata stays off the wire"
            );
        }
    }
}

#[test]
fn an_omitted_or_empty_modules_table_emits_no_sdk_artifact() {
    let scratch = Scratch::new();

    for (label, source) in [("omitted", NO_MODULES), ("empty", EMPTY_MODULES)] {
        for target in TARGETS {
            let tag = format!("{label}-{target}");
            let plugin = scratch.plugin(&tag, source);
            let out = scratch.out(&tag);
            let home = scratch.home(&tag);

            let written = build_target(target, &plugin, &out, &home).expect("build succeeds");

            assert_eq!(written, base_outputs(target, &out, &home), "{tag}");
            assert!(!out.join("sdk").exists(), "{tag} has no SDK folder");
            for path in &written {
                assert!(path.is_file(), "{tag} emitted {path:?}");
            }
        }
    }
}

#[test]
fn an_unknown_module_fails_by_name_before_writing_outputs() {
    let scratch = Scratch::new();

    for target in TARGETS {
        let plugin = scratch.plugin(target, UNKNOWN_MODULE);
        let out = scratch.out(target);
        let home = scratch.home(target);

        let error =
            build_target(target, &plugin, &out, &home).expect_err("an unknown module is refused");

        assert_eq!(error.to_string(), "unknown_module:barn", "{target}");
        assert_nothing_written(&out, &home);
    }
}

#[test]
fn a_malformed_sdk_config_fails_by_name_before_writing_outputs() {
    let scratch = Scratch::new();

    for (label, source) in [("nonempty", NONEMPTY_CONFIG), ("wrong_shape", WRONG_CONFIG)] {
        for target in TARGETS {
            let tag = format!("{label}-{target}");
            let plugin = scratch.plugin(&tag, source);
            let out = scratch.out(&tag);
            let home = scratch.home(&tag);

            let error = build_target(target, &plugin, &out, &home)
                .expect_err("a malformed SDK config is refused");

            assert_eq!(error.to_string(), "invalid_module_config:sdk", "{tag}");
            assert_nothing_written(&out, &home);
        }
    }
}

#[test]
fn a_modules_value_that_is_not_a_table_fails_by_name_before_writing_outputs() {
    let scratch = Scratch::new();
    let plugin = scratch.plugin("not-a-table", MODULES_NOT_A_TABLE);
    let out = scratch.out("not-a-table");
    let home = scratch.home("not-a-table");

    let error = build_target("claude", &plugin, &out, &home)
        .expect_err("a non-table modules value is refused");

    assert_eq!(error.to_string(), "modules:modules must be a table");
    assert_nothing_written(&out, &home);
}
