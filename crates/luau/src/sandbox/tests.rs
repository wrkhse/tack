use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::require::{REQUIRE_CONFINED, RequireCause};

use super::*;

use super::errors::MAX_DEPTH;

const DEFAULT_DEADLINE_MS: u64 = 100;
const DEFAULT_MEMORY_BYTES: usize = 16 * 1024 * 1024;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "tack-sandbox-{}-{}-{}",
            std::process::id(),
            unique,
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("create scratch folder");
        Self { root }
    }

    fn write(&self, name: &str, contents: &str) {
        let path = self.root.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create fixture parent");
        }
        std::fs::write(path, contents).expect("write fixture");
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

const HELPER: &str = r#"return { reason = "helper says no" }"#;

const PLUGIN: &str = r#"
local helper = require("./helper")

return {
name = "safe-push",
needs = {},
toolBefore = function(payload, ctx)
    if ctx.tool == "shell" and string.find(payload.command, "^git push") then
        return ctx.deny("push blocked")
    end
    if ctx.tool == "rewrite-me" then
        return ctx.rewrite({ command = "git push --dry-run" })
    end
    if ctx.tool == "help" then
        return ctx.deny(helper.reason)
    end
    if ctx.tool == "loop" then
        while true do end
    end
    if ctx.tool == "hog" then
        local items = {}
        while true do
            -- Luau interns equal strings, so make each one a new allocation.
            items[#items + 1] = string.rep("x", 4096) .. #items
        end
    end
    return nil
end,
tools = {
    guard_status = {
        name = "guard_status",
        description = "daemon status",
        input = {},
        run = function(input, ctx)
            return { content = { { kind = "text", text = "guard_status: daemon ok" } } }
        end,
    },
    require_helper = {
        name = "require_helper",
        run = function(input, ctx)
            local module = require("./helper")
            return { content = { { kind = "text", text = module.reason } } }
        end,
    },
    require_absolute = {
        name = "require_absolute",
        run = function(input, ctx)
            local ok = pcall(function() return require("/etc/passwd") end)
            return { content = { { kind = "text", text = tostring(ok) } } }
        end,
    },
},
}
"#;

const DUPLICATE: &str = r#"
return {
name = "dup",
tools = {
    first = { name = "repeated" },
    second = { name = "repeated" },
},
}
"#;

fn default_limits() -> Limits {
    Limits::new(DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS).expect("valid limits")
}

fn fixture(limits: Limits) -> (Scratch, Sandbox) {
    let scratch = Scratch::new();
    scratch.write("plugin.luau", PLUGIN);
    scratch.write("helper.luau", HELPER);
    let sandbox =
        Sandbox::new(scratch.path(), limits, Capabilities::default()).expect("fixture loads");
    (scratch, sandbox)
}

fn invocation(hook: &str, tool: &str) -> Invocation {
    Invocation {
        hook: hook.into(),
        payload: json!({ "command": "git push origin main" }),
        context: json!({ "tool": tool }),
    }
}

#[test]
fn tool_before_denies_a_shell_git_push() {
    let (_scratch, sandbox) = fixture(default_limits());
    let outcome = sandbox
        .hook(&invocation("toolBefore", "shell"), DEFAULT_DEADLINE_MS)
        .expect("hook returns");
    assert_eq!(
        outcome,
        Outcome::Deny {
            reason: "push blocked".into()
        }
    );
}

#[test]
fn an_absent_hook_allows() {
    let (_scratch, sandbox) = fixture(default_limits());
    let outcome = sandbox
        .hook(&invocation("permissionAsked", "shell"), DEFAULT_DEADLINE_MS)
        .expect("hook returns");
    assert_eq!(outcome, Outcome::Allow);
}

#[test]
fn a_hook_can_rewrite_a_command() {
    let (_scratch, sandbox) = fixture(default_limits());
    let outcome = sandbox
        .hook(&invocation("toolBefore", "rewrite-me"), DEFAULT_DEADLINE_MS)
        .expect("hook returns");
    assert_eq!(
        outcome,
        Outcome::Rewrite {
            payload: json!({ "command": "git push --dry-run" })
        }
    );
}

#[test]
fn a_hook_can_replace_a_payload_with_scalar_or_null_host_context() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"
        return {
            name = "replace",
            replace = function(payload, ctx)
                return ctx.rewrite(ctx.host)
            end,
        }
        "#,
    );
    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    for context in [json!(false), Value::Null] {
        let invocation = Invocation {
            hook: "replace".into(),
            payload: json!({ "preserve": "nothing" }),
            context: context.clone(),
        };

        assert_eq!(
            sandbox.hook(&invocation, DEFAULT_DEADLINE_MS),
            Ok(Outcome::Rewrite { payload: context })
        );
    }
}

#[test]
fn a_non_object_host_context_is_only_exposed_as_ctx_host() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"
        return {
            name = "host",
            inspect = function(payload, ctx)
                return ctx.rewrite({ host = ctx.host, leaked = ctx[1] })
            end,
        }
        "#,
    );
    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    for context in [json!("text"), json!(7), json!(["first", "second"])] {
        let invocation = Invocation {
            hook: "inspect".into(),
            payload: Value::Null,
            context: context.clone(),
        };

        assert_eq!(
            sandbox.hook(&invocation, DEFAULT_DEADLINE_MS),
            Ok(Outcome::Rewrite {
                payload: json!({ "host": context })
            })
        );
    }
}

#[test]
fn host_context_fields_cannot_override_helpers_or_capabilities() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"
        return {
            name = "context",
            inspect = function(payload, ctx)
                assert(ctx.allow() == nil)
                assert(type(ctx.deny) == "function")
                return ctx.rewrite(ctx.lookup(ctx.label))
            end,
        }
        "#,
    );
    let mut capabilities = Capabilities::default();
    capabilities.insert("lookup", Ok);
    let sandbox =
        Sandbox::new(scratch.path(), default_limits(), capabilities).expect("fixture loads");
    let invocation = Invocation {
        hook: "inspect".into(),
        payload: Value::Null,
        context: json!({
            "allow": "shadow",
            "deny": "shadow",
            "rewrite": "shadow",
            "lookup": "shadow",
            "label": "from the host",
        }),
    };

    assert_eq!(
        sandbox.hook(&invocation, DEFAULT_DEADLINE_MS),
        Ok(Outcome::Rewrite {
            payload: json!("from the host")
        })
    );
}

#[test]
fn a_runaway_loop_is_limited_by_the_deadline() {
    let (_scratch, sandbox) = fixture(default_limits());
    let error = sandbox
        .hook(&invocation("toolBefore", "loop"), 20)
        .expect_err("loop is interrupted");
    assert_eq!(error, EngineError::Limit(LimitCause::Deadline));
}

#[test]
fn a_memory_hog_is_limited_by_the_ceiling() {
    let (_scratch, sandbox) =
        fixture(Limits::new(DEFAULT_MEMORY_BYTES, 1000).expect("valid limits"));
    let error = sandbox
        .hook(&invocation("toolBefore", "hog"), 1000)
        .expect_err("allocation is refused");
    assert_eq!(error, EngineError::Limit(LimitCause::Memory));
}

#[test]
fn a_top_level_allocation_is_limited_by_the_ceiling_during_load() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"local hog = string.rep("x", 32 * 1024 * 1024)
return { name = "startup-hog", size = #hog }"#,
    );

    let error = Sandbox::new(
        scratch.path(),
        Limits::new(DEFAULT_MEMORY_BYTES, 1000).expect("valid limits"),
        Capabilities::default(),
    )
    .expect_err("top-level allocation is refused");

    assert_eq!(error, EngineError::Limit(LimitCause::Memory));
}

#[test]
fn limits_refuse_ceilings_below_the_vm_baseline() {
    for bytes in [0, DEFAULT_MEMORY_BYTES - 1] {
        assert_eq!(
            Limits::new(bytes, DEFAULT_DEADLINE_MS).expect_err("ceiling is too small"),
            EngineError::Limit(LimitCause::Memory)
        );
    }

    let limits =
        Limits::new(DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS).expect("baseline is allowed");
    let (_scratch, _sandbox) = fixture(limits);
}

const TWO_HOSTS: &str = r#"
return {
    name = "two-hosts",
    spin = function() while true do end end,
    allocate = function(payload, ctx)
        return ctx.deny(tostring(#string.rep("x", payload.bytes)))
    end,
    lookup = function(payload, ctx)
        if ctx.lookup == nil then return ctx.deny("unavailable") end
        return ctx.deny(ctx.lookup(payload).text)
    end,
}
"#;

#[test]
fn sandbox_rejects_a_reserved_capability_name() {
    let scratch = Scratch::new();
    scratch.write("plugin.luau", r#"return { name = "test" }"#);
    let mut capabilities = Capabilities::default();
    capabilities.insert("allow", Ok);

    let error = Sandbox::new(scratch.path(), default_limits(), capabilities)
        .expect_err("reserved capability is refused");
    assert_eq!(
        error,
        EngineError::InvalidResult("reserved capability name: allow".into())
    );
}

#[test]
fn a_second_host_with_different_limits_works() {
    let scratch = Scratch::new();
    scratch.write("plugin.luau", TWO_HOSTS);
    let smaller = Limits::new(DEFAULT_MEMORY_BYTES, 50).expect("valid limits");
    let larger = Limits::new(4 * DEFAULT_MEMORY_BYTES, 1000).expect("valid limits");
    let mut capabilities = Capabilities::default();
    capabilities.insert("lookup", |input| match input["id"].as_str() {
        Some("record") => Ok(json!({ "text": "only in the second host" })),
        _ => Err("record not found".into()),
    });

    let first = Sandbox::new(scratch.path(), smaller, Capabilities::default()).expect("first host");
    let second = Sandbox::new(scratch.path(), larger, capabilities).expect("second host");
    let call_for = |hook: &str, payload| Invocation {
        hook: hook.into(),
        payload,
        context: Value::Null,
    };

    let allocation = call_for("allocate", json!({ "bytes": 2 * DEFAULT_MEMORY_BYTES }));
    assert_eq!(
        first.hook(&allocation, 5000),
        Err(EngineError::Limit(LimitCause::Memory))
    );
    assert_eq!(
        second.hook(&allocation, 5000),
        Ok(Outcome::Deny {
            reason: "33554432".into()
        })
    );
    assert_eq!(
        second.hook(
            &call_for("allocate", json!({ "bytes": 8 * DEFAULT_MEMORY_BYTES })),
            5000
        ),
        Err(EngineError::Limit(LimitCause::Memory))
    );

    let lookup = call_for("lookup", json!({ "id": "record" }));
    assert_eq!(
        first.hook(&lookup, 5000),
        Ok(Outcome::Deny {
            reason: "unavailable".into()
        })
    );
    assert_eq!(
        second.hook(&lookup, 5000),
        Ok(Outcome::Deny {
            reason: "only in the second host".into()
        })
    );
    assert_eq!(
        second.hook(&call_for("lookup", json!({ "id": "missing" })), 5000),
        Err(EngineError::Capability {
            name: "lookup".into(),
            reason: "record not found".into()
        })
    );

    let spin = call_for("spin", Value::Null);
    assert_deadline_between(
        &first,
        &spin,
        smaller.call_deadline_ms,
        larger.call_deadline_ms,
    );
    assert_deadline_between(&second, &spin, larger.call_deadline_ms, 4000);
}

fn assert_deadline_between(sandbox: &Sandbox, spin: &Invocation, lower_ms: u64, upper_ms: u64) {
    let started = Instant::now();
    assert_eq!(
        sandbox.hook(spin, 5000),
        Err(EngineError::Limit(LimitCause::Deadline))
    );
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(lower_ms),
        "expired after {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_millis(upper_ms),
        "expired after {elapsed:?}"
    );
}

#[test]
fn a_too_deep_input_is_limited_by_depth() {
    let (_scratch, sandbox) = fixture(default_limits());
    let mut input = json!(1);
    for _ in 0..=MAX_DEPTH + 1 {
        input = json!([input]);
    }
    let error = sandbox
        .run("guard_status", &input, DEFAULT_DEADLINE_MS)
        .expect_err("deep input is refused");
    assert_eq!(
        error,
        EngineError::Limit(LimitCause::TooDeep { limit: MAX_DEPTH })
    );
}

#[test]
fn a_too_wide_input_is_limited_by_entry_count() {
    let (_scratch, sandbox) = fixture(default_limits());
    let mut object = serde_json::Map::new();
    for index in 0..=MAX_ENTRIES {
        object.insert(format!("k{index}"), json!(index));
    }
    let error = sandbox
        .run("guard_status", &Value::Object(object), DEFAULT_DEADLINE_MS)
        .expect_err("wide input is refused");
    assert_eq!(
        error,
        EngineError::Limit(LimitCause::TooManyEntries { limit: MAX_ENTRIES })
    );
}

#[test]
fn a_runaway_call_does_not_disarm_another_calls_deadline() {
    let (_scratch, sandbox) = fixture(default_limits());
    std::thread::scope(|scope| {
        let looping = scope.spawn(|| sandbox.hook(&invocation("toolBefore", "loop"), 20));
        let normal =
            scope.spawn(|| sandbox.hook(&invocation("toolBefore", "shell"), DEFAULT_DEADLINE_MS));

        assert_eq!(
            looping.join().expect("loop thread joins"),
            Err(EngineError::Limit(LimitCause::Deadline))
        );
        assert_eq!(
            normal.join().expect("normal thread joins"),
            Ok(Outcome::Deny {
                reason: "push blocked".into()
            })
        );
    });
}

#[test]
fn a_top_level_loop_is_limited_during_load() {
    let scratch = Scratch::new();
    scratch.write("plugin.luau", "while true do end");
    let error = Sandbox::new(
        scratch.path(),
        Limits::new(DEFAULT_MEMORY_BYTES, 20).expect("valid limits"),
        Capabilities::default(),
    )
    .expect_err("top-level loop is interrupted");
    assert_eq!(error, EngineError::Limit(LimitCause::Deadline));
}

#[test]
fn scoped_require_loads_a_sibling_module() {
    let (_scratch, sandbox) = fixture(default_limits());
    let outcome = sandbox
        .hook(&invocation("toolBefore", "help"), DEFAULT_DEADLINE_MS)
        .expect("hook returns");
    assert_eq!(
        outcome,
        Outcome::Deny {
            reason: "helper says no".into()
        }
    );
    let content = sandbox
        .run("require_helper", &json!({}), DEFAULT_DEADLINE_MS)
        .expect("tool returns");
    assert_eq!(
        content,
        json!({ "content": [{ "kind": "text", "text": "helper says no" }] })
    );
}

#[test]
fn require_refuses_parent_and_absolute_paths() {
    for (spec, expected) in [
        ("../escape", RequireCause::Parent("../escape".into())),
        ("/etc/passwd", RequireCause::Absolute("/etc/passwd".into())),
    ] {
        let scratch = Scratch::new();
        scratch.write(
            "plugin.luau",
            &format!(r#"local x = require("{spec}") return {{ name = "x" }}"#),
        );
        let error = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
            .expect_err("require is refused");
        assert_eq!(error, EngineError::Load(LoadCause::Require(expected)));
    }
}

#[test]
fn require_refuses_a_cycle() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"local x = require("./a") return { name = "x" }"#,
    );
    scratch.write(
        "a.luau",
        r#"local x = require("./plugin") return { name = "a" }"#,
    );
    let error = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect_err("cycle is refused");
    assert_eq!(
        error,
        EngineError::Load(LoadCause::Require(RequireCause::Cycle("./plugin".into())))
    );
}

#[test]
fn require_refuses_a_missing_module() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"local x = require("./nope") return { name = "x" }"#,
    );
    let error = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect_err("missing module is refused");
    assert_eq!(
        error,
        EngineError::Load(LoadCause::Require(RequireCause::Missing("./nope".into())))
    );
}

#[test]
fn require_refuses_a_symlink_that_escapes_the_folder() {
    let scratch = Scratch::new();
    let outside = Scratch::new();
    outside.write("secret.luau", r#"return { reason = "secret" }"#);
    std::os::unix::fs::symlink(
        outside.path().join("secret.luau"),
        scratch.path().join("linked.luau"),
    )
    .expect("create symlink");
    scratch.write(
        "plugin.luau",
        r#"local x = require("./linked") return { name = "x" }"#,
    );
    let error = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect_err("escaping symlink is refused");
    assert_eq!(
        error,
        EngineError::Load(LoadCause::Require(RequireCause::Escape("./linked".into())))
    );
}

#[test]
fn a_module_requires_relative_to_its_own_folder() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"
local child = require("./sub/child")
local root = require("./helper")
return {
name = "scoped",
tools = {
    resolved = {
        name = "resolved",
        run = function(input, ctx)
            return { content = {
                { kind = "text", text = child.value },
                { kind = "text", text = root.root },
            } }
        end,
    },
    refused = {
        name = "refused",
        run = function(input, ctx)
            local ok = pcall(function() return require("/etc/passwd") end)
            return { content = { { kind = "text", text = tostring(ok) } } }
        end,
    },
},
}
"#,
    );
    scratch.write("helper.luau", r#"return { root = "from root" }"#);
    scratch.write("sub/helper.luau", r#"return { sub = "from sub" }"#);
    scratch.write(
        "sub/child.luau",
        r#"local helper = require("./helper") return { value = helper.sub }"#,
    );

    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    // The child's "./helper" is sub/helper.luau, not the root helper:
    // one returns a "sub" field and the other a "root" field.
    let resolved = sandbox
        .run("resolved", &json!({}), DEFAULT_DEADLINE_MS)
        .expect("tool returns");
    assert_eq!(
        resolved,
        json!({
            "content": [
                { "kind": "text", "text": "from sub" },
                { "kind": "text", "text": "from root" },
            ]
        })
    );

    let refused = sandbox
        .run("refused", &json!({}), DEFAULT_DEADLINE_MS)
        .expect("tool returns");
    assert_eq!(
        refused,
        json!({ "content": [{ "kind": "text", "text": "false" }] })
    );
}

#[test]
fn a_deferred_require_uses_the_defining_modules_folder() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"
local child = require("./sub/child")
return {
name = "scoped",
toolBefore = function(payload, ctx)
    return ctx.deny(child.later())
end,
tools = {
    deferred = {
        name = "deferred",
        run = function(input, ctx)
            return { content = { { kind = "text", text = child.later() } } }
        end,
    },
},
}
"#,
    );
    scratch.write("helper.luau", r#"return { root = "from root" }"#);
    scratch.write("sub/helper.luau", r#"return { sub = "from sub" }"#);
    scratch.write(
        "sub/child.luau",
        r#"
local function later()
local helper = require("./helper")
return helper.sub
end
return { later = later }
"#,
    );

    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    // The deferred call runs after child.luau finished loading; its
    // require still resolves against sub/, not the plugin root.
    let outcome = sandbox
        .hook(&invocation("toolBefore", "shell"), DEFAULT_DEADLINE_MS)
        .expect("hook returns");
    assert_eq!(
        outcome,
        Outcome::Deny {
            reason: "from sub".into()
        }
    );
    let content = sandbox
        .run("deferred", &json!({}), DEFAULT_DEADLINE_MS)
        .expect("tool returns");
    assert_eq!(
        content,
        json!({ "content": [{ "kind": "text", "text": "from sub" }] })
    );
}

#[test]
fn a_tool_returns_text_content() {
    let (_scratch, sandbox) = fixture(default_limits());
    let content = sandbox
        .run("guard_status", &json!({}), DEFAULT_DEADLINE_MS)
        .expect("tool returns");
    assert_eq!(
        content,
        json!({ "content": [{ "kind": "text", "text": "guard_status: daemon ok" }] })
    );
}

#[test]
fn a_runnable_returns_json_without_a_content_envelope() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"
        return {
            name = "runnables",
            tools = {
                double = { run = function(input) return input * 2 end },
            },
        }
        "#,
    );
    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    assert_eq!(
        sandbox.run("double", &json!(21), DEFAULT_DEADLINE_MS),
        Ok(json!(42))
    );
}

#[test]
fn global_require_is_a_refuser_through_getfenv() {
    let (_scratch, sandbox) = fixture(default_limits());
    let lua = &sandbox.lua;

    let has_getfenv: bool = lua
        .load("return type(getfenv) == 'function'")
        .eval()
        .expect("query getfenv");
    assert!(has_getfenv, "Luau sandbox keeps getfenv available");

    let (loaded, message): (bool, String) = lua
        .load(
            r#"
            local globals = getfenv(0)
            return pcall(globals.require, "/etc/passwd")
            "#,
        )
        .eval()
        .expect("call the global require");

    assert!(!loaded);
    assert_eq!(message, REQUIRE_CONFINED);
}

#[test]
fn raw_global_require_is_never_a_working_loader() {
    let (_scratch, sandbox) = fixture(default_limits());
    let lua = &sandbox.lua;

    let kind: String = lua
        .load("return type(rawget(_G, 'require'))")
        .eval()
        .expect("inspect the raw global require");
    assert_eq!(kind, "function");

    let (loaded, message): (bool, String) = lua
        .load("return pcall(rawget(_G, 'require'), '/etc/passwd')")
        .eval()
        .expect("call the raw global require");
    assert!(!loaded);
    assert_eq!(message, REQUIRE_CONFINED);
}

#[test]
fn a_function_with_globals_env_cannot_require_outside_the_folder() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"
local escape = function()
return require("/etc/passwd")
end
return {
name = "escape",
tools = {
    probe = {
        name = "probe",
        run = function(input, ctx)
            local globals = getfenv(0)
            setfenv(escape, globals)
            local loaded, err = pcall(escape)
            local text = tostring(loaded) .. "|" .. tostring(err)
            return { content = { { kind = "text", text = text } } }
        end,
    },
},
}
"#,
    );
    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    let content = sandbox
        .run("probe", &json!({}), DEFAULT_DEADLINE_MS)
        .expect("tool returns");
    assert_eq!(
        content,
        json!({ "content": [{ "kind": "text", "text": format!("false|{REQUIRE_CONFINED}") }] })
    );
}

#[test]
fn manifest_reads_the_fixture() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"
        return {
            name = "safe-push",
            needs = { "lookup" },
            tools = {
                guard_status = {
                    description = "daemon status",
                    input = {},
                    cacheable = true,
                    run = function() return nil end,
                },
            },
        }
        "#,
    );
    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    assert_eq!(
        sandbox.manifest(),
        Ok(json!({
            "name": "safe-push",
            "needs": ["lookup"],
            "modules": [],
            "tools": [{
                "name": "guard_status",
                "description": "daemon status",
                "input": {},
                "cacheable": true,
            }],
        }))
    );
}

#[test]
fn manifest_reads_the_listed_module() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"return { name = "safe-push", modules = { sdk = {} } }"#,
    );
    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    assert_eq!(
        sandbox.manifest(),
        Ok(json!({
            "name": "safe-push",
            "needs": [],
            "modules": ["sdk"],
            "tools": [],
        }))
    );
}

#[test]
fn manifest_reads_every_listed_module_in_name_order() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"return { name = "safe-push", modules = { zeta = {}, alpha = {}, mu = {}, beta = {}, omega = {} } }"#,
    );
    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    assert_eq!(
        sandbox.manifest(),
        Ok(json!({
            "name": "safe-push",
            "needs": [],
            "modules": ["alpha", "beta", "mu", "omega", "zeta"],
            "tools": [],
        }))
    );
}

#[test]
fn manifest_refuses_modules_that_are_not_a_table() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"return { name = "safe-push", modules = "sdk" }"#,
    );
    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    assert_eq!(
        sandbox.manifest(),
        Err(EngineError::InvalidResult("modules must be a table".into()))
    );
}

#[test]
fn manifest_refuses_module_options_that_are_not_a_table() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"return { name = "safe-push", modules = { sdk = true } }"#,
    );
    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    assert_eq!(
        sandbox.manifest(),
        Err(EngineError::InvalidResult(
            "module options must be a table".into()
        ))
    );
}

#[test]
fn manifest_refuses_a_module_that_is_not_named() {
    let scratch = Scratch::new();
    scratch.write(
        "plugin.luau",
        r#"return { name = "safe-push", modules = { "sdk" } }"#,
    );
    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    assert_eq!(
        sandbox.manifest(),
        Err(EngineError::InvalidResult(
            "modules must be keyed by name".into()
        ))
    );
}

#[test]
fn manifest_limits_the_number_of_modules() {
    let scratch = Scratch::new();
    let entries: String = (0..=MAX_ENTRIES)
        .map(|index| format!("m{index} = {{}},\n"))
        .collect();
    scratch.write(
        "plugin.luau",
        &format!("return {{\n    name = \"safe-push\",\n    modules = {{\n{entries}    }},\n}}\n"),
    );
    let sandbox = Sandbox::new(scratch.path(), default_limits(), Capabilities::default())
        .expect("fixture loads");

    assert_eq!(
        sandbox.manifest(),
        Err(EngineError::Limit(LimitCause::TooManyEntries {
            limit: MAX_ENTRIES
        }))
    );
}

#[test]
fn manifest_refuses_a_duplicate_tool_name() {
    let scratch = Scratch::new();
    scratch.write("plugin.luau", DUPLICATE);
    let sandbox =
        Sandbox::new(scratch.path(), default_limits(), Capabilities::default()).expect("loads");
    let error = sandbox.manifest().expect_err("duplicate is refused");
    assert_eq!(
        error,
        EngineError::InvalidResult("duplicate tool name: repeated".into())
    );
}

#[test]
fn a_poisoned_call_lock_fails_closed() {
    let (_scratch, sandbox) = fixture(default_limits());
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = sandbox.call_lock.lock().expect("acquire the call lock");
        panic!("poison the call lock");
    }));
    assert!(panicked.is_err());

    assert_eq!(
        sandbox.hook(&invocation("toolBefore", "shell"), DEFAULT_DEADLINE_MS),
        Err(EngineError::Poisoned)
    );
    assert_eq!(
        sandbox.run("guard_status", &json!({}), DEFAULT_DEADLINE_MS),
        Err(EngineError::Poisoned)
    );
    assert_eq!(sandbox.manifest(), Err(EngineError::Poisoned));
}
