//! In-process proofs of the Claude Code mod: the exact files for a fixture
//! manifest, and the load rules Claude Code 2.1.328 holds a hooks module to.
//! No Claude Code or Node process runs here.

#![cfg(test)]

use serde_json::json;
use tack_adapter_claude::{
    BUDGET_MS, HOOKS_JSON, ModConfig, ModError, ModFile, PLUGIN_JSON, REGISTER_JS, render,
};
use tack_protocol::wire::{DenyReason, PluginManifest, ToolDef};

const GOLDEN: &str = include_str!("../golden/register.js");

const REASONS: [&str; 12] = [
    "socket_missing",
    "timeout",
    "socket_closed",
    "malformed_reply",
    "protocol_version",
    "limit",
    "script",
    "unknown_tool",
    "daemon_error",
    "aborted",
    "unsupported_hook",
    "socket_untrusted",
];

fn manifest() -> PluginManifest {
    PluginManifest {
        name: "safe-push".into(),
        needs: vec![],
        tools: vec![ToolDef {
            name: "guard_status".into(),
            description: "Reports whether the tack daemon is running".into(),
            input: json!({}),
        }],
    }
}

const fn config(manifest: &PluginManifest) -> ModConfig<'_> {
    ModConfig {
        manifest,
        hook_bin: "tack-hook",
        plugin_dir: "/plugins/safe-push",
        protocol_version: 1,
        deny_reasons: &REASONS,
        version: "0.1.0",
    }
}

fn rendered() -> [ModFile; 3] {
    render(&config(&manifest())).expect("render")
}

fn register_js() -> String {
    let [_, _, register] = rendered();
    register.contents
}

// tack build passes every protocol deny reason in this order, so the golden
// holds the list a real build emits.
#[test]
fn the_fixture_reasons_are_the_protocol_deny_reasons() {
    assert_eq!(REASONS, DenyReason::ALL.map(DenyReason::as_str));
}

#[test]
fn render_emits_the_exact_plugin_folder() {
    let [plugin, hooks, register] = rendered();

    assert_eq!(
        plugin,
        ModFile {
            path: ".claude-plugin/plugin.json",
            contents: "{\n  \"name\": \"tack\",\n  \"version\": \"0.1.0\"\n}\n".into(),
        }
    );
    assert_eq!(
        hooks,
        ModFile {
            path: "hooks/hooks.json",
            contents: "{\n  \"modules\": [\n    \"./register.js\"\n  ]\n}\n".into(),
        }
    );
    assert_eq!(register.path, "hooks/register.js");
    assert_eq!(register.contents, GOLDEN);
    assert_eq!(
        [PLUGIN_JSON, HOOKS_JSON, REGISTER_JS],
        [plugin.path, hooks.path, register.path]
    );
}

#[test]
fn register_is_a_top_level_export_const() {
    let script = register_js();
    let exports: Vec<&str> = script
        .lines()
        .filter(|line| line.trim_start().starts_with("export"))
        .collect();

    assert_eq!(exports, ["export const register = (on, options) => {"]);
}

#[test]
fn the_module_loads_nothing() {
    let script = register_js();

    for banned in ["node:", "import", "require", "from \""] {
        assert_eq!(script.find(banned), None, "the module holds {banned:?}");
    }
}

#[test]
fn dollar_appears_only_at_call_sites() {
    let script = register_js();

    for (index, _) in script.match_indices('$') {
        let after = script.get(index..).and_then(|rest| rest.chars().nth(1));
        let bound = script.get(..index).map(|head| head.ends_with("= "));

        assert!(
            matches!(after, Some('.' | ',' | ')')),
            "$ at byte {index} is followed by {after:?}"
        );
        assert_eq!(bound, Some(false), "$ at byte {index} is bound to a name");
    }
}

#[test]
fn every_timer_global_runs_on_the_mod_clock() {
    let script = register_js();
    let lines: Vec<&str> = script.lines().map(str::trim).collect();

    for expected in [
        "globalThis.setTimeout = (fn, ms, ...args) =>",
        "$.clock.after(delay(ms, 0), () => fn(...args));",
        "globalThis.clearTimeout = cancel;",
        "globalThis.setInterval = (fn, ms, ...args) =>",
        "$.clock.every(delay(ms, 1), () => fn(...args));",
        "globalThis.clearInterval = cancel;",
        "globalThis.queueMicrotask = (fn) => {",
        "$.clock.after(0, fn);",
    ] {
        assert_eq!(
            lines.iter().filter(|line| **line == expected).count(),
            1,
            "{expected}"
        );
    }
}

#[test]
fn every_gating_registration_carries_a_catch() {
    let script = register_js();
    let gating: Vec<&str> = script
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("on(\"tool.call\""))
        .collect();

    assert_eq!(
        gating,
        [
            "on(\"tool.call\", { tool: \"Bash\" }, guardBash).catch(refuseFailed);",
            "on(\"tool.call\", { tool: TOOL_PREFIX + spec.name }, serveTool).catch(refuseFailed);",
        ]
    );
}

// Claude Code refuses the whole module when an `on(...)` hook is not a
// function declared at the top of the file, so every hook and every `.catch`
// handler names one.
#[test]
fn every_hook_and_handler_is_a_top_level_function() {
    let script = register_js();
    let calls: Vec<&str> = script
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("on("))
        .collect();

    assert_eq!(calls.len(), 3);

    for call in calls {
        let (registration, catch) = call.split_once(").catch(").expect("a .catch");
        let hook = registration.rsplit(", ").next().expect("a hook");
        let handler = catch.strip_suffix(");").expect("a closed .catch");

        for name in [hook, handler] {
            let plain = format!("function {name}(");
            let awaited = format!("async function {name}(");
            let declared = script
                .lines()
                .any(|line| line.starts_with(&plain) || line.starts_with(&awaited));

            assert!(declared, "{name} in {call} is no top-level function");
        }
    }
}

#[test]
fn tack_hook_runs_by_its_plain_name_within_the_budget() {
    let script = register_js();
    let lines: Vec<&str> = script.lines().map(str::trim).collect();

    assert_eq!(BUDGET_MS, 9000);
    for expected in [
        "const HOOK_BIN = \"tack-hook\";",
        "const PLUGIN_DIR = \"/plugins/safe-push\";",
        "const BUDGET_MS = 9000;",
        "done = await $.process.run([HOOK_BIN, \"--plugin\", PLUGIN_DIR], {",
        "timeoutMs: BUDGET_MS,",
    ] {
        assert!(lines.contains(&expected), "{expected}");
    }
}

#[test]
fn tools_register_from_session_start_under_the_mod_prefix() {
    let script = register_js();
    let lines: Vec<&str> = script.lines().map(str::trim).collect();

    for expected in [
        "const TOOLS = [{\"description\":\"Reports whether the tack daemon is running\",\
         \"inputSchema\":{\"type\":\"object\"},\"isDeferred\":false,\"name\":\"guard_status\"}];",
        "const TOOL_PREFIX = \"mcp__tack__\";",
        "on(\"session.start\", registerTools).catch(logStartFailed);",
        "await $.tool.register(spec);",
    ] {
        assert!(lines.contains(&expected), "{expected}");
    }
}

#[test]
fn render_refuses_unsafe_values_and_bad_tools() {
    let manifest = manifest();

    let mut newline = config(&manifest);
    newline.hook_bin = "tack-hook\nother";
    assert_eq!(render(&newline), Err(ModError::UnsafeValue("hook_bin")));

    let mut token = config(&manifest);
    token.plugin_dir = "__TACK_PLUGIN_DIR__";
    assert_eq!(render(&token), Err(ModError::UnsafeValue("plugin_dir")));

    let mut version = config(&manifest);
    version.version = "1\r";
    assert_eq!(render(&version), Err(ModError::UnsafeValue("version")));

    let reasons = ["timeout\n"];
    let mut reason = config(&manifest);
    reason.deny_reasons = &reasons;
    assert_eq!(render(&reason), Err(ModError::UnsafeValue("deny_reasons")));

    let mut described = manifest.clone();
    described.tools[0].description = "__TACK_TOOLS__".into();
    assert_eq!(
        render(&config(&described)),
        Err(ModError::UnsafeValue("tools"))
    );

    let mut named = manifest.clone();
    named.tools[0].name = "guard status".into();
    assert_eq!(
        render(&config(&named)),
        Err(ModError::ToolName("guard status".into()))
    );
}
