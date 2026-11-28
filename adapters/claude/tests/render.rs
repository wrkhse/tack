//! In-process proofs of the Claude Code mod: the exact files for a fixture
//! manifest, and the load rules Claude Code 2.1.328 holds a hooks module to.
//! No Claude Code or Node process runs here.

#![cfg(test)]

use serde_json::Value;
use tack_adapter_claude::{
    BUDGET_MS, HOOKS_JSON, ModConfig, ModError, ModFile, PLUGIN_JSON, REGISTER_JS, render,
};
use tack_protocol::wire::{DenyReason, PluginManifest, ToolDef};

const TEMPLATE: &str = include_str!("../register.js");
const FIXTURE_VALUES: &str = include_str!("../fixture-values.json");

struct Fixture<'a> {
    manifest: PluginManifest,
    hook_bin: &'a str,
    plugin_dir: &'a str,
    protocol_version: u32,
    deny_reasons: Vec<&'a str>,
}

impl<'a> Fixture<'a> {
    fn from_values(values: &'a Value) -> Self {
        let tools = values["TOOLS"]
            .as_array()
            .expect("fixture tools")
            .iter()
            .map(|tool| ToolDef {
                name: tool["name"].as_str().expect("fixture tool name").into(),
                description: tool["description"]
                    .as_str()
                    .expect("fixture tool description")
                    .into(),
                input: tool["inputSchema"].clone(),
            })
            .collect();
        let manifest = PluginManifest {
            name: "safe-push".into(),
            needs: vec![],
            grants: Vec::new(),
            tools,
        };

        Self {
            manifest,
            hook_bin: values["HOOK_BIN"].as_str().expect("fixture hook binary"),
            plugin_dir: values["PLUGIN_DIR"]
                .as_str()
                .expect("fixture plugin directory"),
            protocol_version: serde_json::from_value(values["PROTOCOL_VERSION"].clone())
                .expect("fixture protocol version"),
            deny_reasons: values["DENY_REASONS"]
                .as_array()
                .expect("fixture deny reasons")
                .iter()
                .map(|reason| reason.as_str().expect("fixture deny reason"))
                .collect(),
        }
    }

    fn config(&self) -> ModConfig<'_> {
        ModConfig {
            manifest: &self.manifest,
            hook_bin: self.hook_bin,
            plugin_dir: self.plugin_dir,
            protocol_version: self.protocol_version,
            deny_reasons: &self.deny_reasons,
            version: "0.1.0",
        }
    }
}

fn fixture_values() -> Value {
    serde_json::from_str(FIXTURE_VALUES).expect("fixture values")
}

fn rendered() -> [ModFile; 3] {
    let values = fixture_values();
    render(&Fixture::from_values(&values).config()).expect("render")
}

fn register_js() -> String {
    let [_, _, register] = rendered();
    register.contents
}

/// Each `on(...)` registration as one statement, its lines joined as they
/// read on one line: a formatter's line breaks, and the trailing comma it adds
/// before a broken `)`, change nothing.
fn registrations(script: &str) -> Vec<String> {
    let mut calls = Vec::new();
    let mut lines = script.lines().map(str::trim);

    while let Some(line) = lines.next() {
        if !line.starts_with("on(") {
            continue;
        }

        let mut call = line.to_owned();

        while !balanced(&call) || !call.ends_with(';') {
            let next = lines.next().expect("a closed on(...) statement");
            let opened = call.ends_with(['(', '[']);
            let closing = next.starts_with([')', ']', '.']);

            if !opened && !closing {
                call.push(' ');
            }

            call.push_str(next);
        }

        calls.push(call.replace(",)", ")"));
    }

    calls
}

/// Whether the statement closes every parenthesis it opens, outside
/// double-quoted strings.
fn balanced(statement: &str) -> bool {
    let code = unquoted(statement);

    code.matches('(').count() == code.matches(')').count()
}

/// The text with each double-quoted string's contents left out.
fn unquoted(text: &str) -> String {
    let mut code = String::new();
    let mut quoted = false;
    let mut escaped = false;

    for c in text.chars() {
        if escaped {
            escaped = false;
        } else if quoted && c == '\\' {
            escaped = true;
        } else if c == '"' {
            quoted = !quoted;
        } else if !quoted {
            code.push(c);
        }
    }

    code
}

// tack build passes every protocol deny reason in this order, so the fixture
// holds the list a real build emits.
#[test]
fn the_fixture_reasons_are_the_protocol_deny_reasons() {
    let values = fixture_values();
    let fixture = Fixture::from_values(&values);

    assert_eq!(
        fixture.deny_reasons,
        DenyReason::ALL.map(DenyReason::as_str)
    );
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
    assert_eq!(
        [PLUGIN_JSON, HOOKS_JSON, REGISTER_JS],
        [plugin.path, hooks.path, register.path]
    );
}

#[test]
fn register_render_only_fills_the_fixture_slots() {
    let data = fixture_values();
    let fixture = Fixture::from_values(&data);
    let values = [
        ("__TACK_TOOLS__", data["TOOLS"].to_string()),
        ("__TACK_HOOK_BIN__", r#""tack-hook""#.to_owned()),
        ("__TACK_PLUGIN_DIR__", r#""/plugins/safe-push""#.to_owned()),
        ("__TACK_DENY_REASONS__", data["DENY_REASONS"].to_string()),
        ("__TACK_PROTOCOL_VERSION__", "1".to_owned()),
        ("__TACK_BUDGET_MS__", data["BUDGET_MS"].to_string()),
        ("__TACK_TOOL_PREFIX__", data["TOOL_PREFIX"].to_string()),
    ];

    let [_, _, register] = render(&fixture.config()).expect("render");
    let script = register.contents;
    let template_lines = TEMPLATE.split_inclusive('\n');
    let rendered_lines = script.split_inclusive('\n');
    assert_eq!(
        template_lines.clone().count(),
        rendered_lines.clone().count()
    );

    let mut expected = String::new();

    for (template, rendered) in template_lines.zip(rendered_lines) {
        let mut line = template.to_owned();

        for (token, value) in &values {
            if template.contains(token) {
                line = line.replace(token, value);
            }
        }

        assert_eq!(rendered, line, "from template line {template:?}");
        expected.push_str(&line);
    }

    assert_eq!(script, expected);
    assert_eq!(script.find("__TACK_"), None);
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
    let gating: Vec<String> = registrations(&script)
        .into_iter()
        .filter(|call| call.starts_with("on(\"tool.call\""))
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
    let calls = registrations(&script);

    assert_eq!(calls.len(), 3);

    for call in &calls {
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
    let values = fixture_values();
    let fixture = Fixture::from_values(&values);

    let mut newline = fixture.config();
    newline.hook_bin = "tack-hook\nother";
    assert_eq!(render(&newline), Err(ModError::UnsafeValue("hook_bin")));

    let mut token = fixture.config();
    token.plugin_dir = "__TACK_PLUGIN_DIR__";
    assert_eq!(render(&token), Err(ModError::UnsafeValue("plugin_dir")));

    let mut version = fixture.config();
    version.version = "1\r";
    assert_eq!(render(&version), Err(ModError::UnsafeValue("version")));

    let reasons = ["timeout\n"];
    let mut reason = fixture.config();
    reason.deny_reasons = &reasons;
    assert_eq!(render(&reason), Err(ModError::UnsafeValue("deny_reasons")));

    let mut described = fixture.manifest.clone();
    described.tools[0].description = "__TACK_TOOLS__".into();
    assert_eq!(
        render(&ModConfig {
            manifest: &described,
            ..fixture.config()
        }),
        Err(ModError::UnsafeValue("tools"))
    );

    let mut named = fixture.manifest.clone();
    named.tools[0].name = "guard status".into();
    assert_eq!(
        render(&ModConfig {
            manifest: &named,
            ..fixture.config()
        }),
        Err(ModError::ToolName("guard status".into()))
    );
}
