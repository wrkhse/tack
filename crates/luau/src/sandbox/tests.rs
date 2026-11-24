use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::require::{REQUIRE_CONFINED, RequireCause};

use super::*;

use super::errors::MAX_DEPTH;

const DEFAULT_DEADLINE_MS: u64 = 100;

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
toolBefore = function(call, ctx)
    if call.tool == "shell" and string.find(call.input.command, "^git push") then
        return ctx.deny("push blocked")
    end
    if call.tool == "rewrite-me" then
        return ctx.rewrite("git push --dry-run")
    end
    if call.tool == "help" then
        return ctx.deny(helper.reason)
    end
    if call.tool == "loop" then
        while true do end
    end
    if call.tool == "hog" then
        local items = {}
        while true do
            items[#items + 1] = string.rep("x", 4096)
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

fn fixture(limits: Limits) -> (Scratch, Sandbox) {
    let scratch = Scratch::new();
    scratch.write("plugin.luau", PLUGIN);
    scratch.write("helper.luau", HELPER);
    let sandbox =
        Sandbox::new(scratch.path(), limits, Capabilities::default()).expect("fixture loads");
    (scratch, sandbox)
}

fn call(tool: &str) -> Call {
    Call {
        tool: tool.to_owned(),
        name: tool.to_owned(),
        input: json!({ "command": "git push origin main" }),
        session_id: None,
    }
}

#[test]
fn tool_before_denies_a_shell_git_push() {
    let (_scratch, sandbox) = fixture(Limits::default());
    let outcome = sandbox
        .hook("toolBefore", &call("shell"), DEFAULT_DEADLINE_MS)
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
    let (_scratch, sandbox) = fixture(Limits::default());
    let outcome = sandbox
        .hook("permissionAsked", &call("shell"), DEFAULT_DEADLINE_MS)
        .expect("hook returns");
    assert_eq!(outcome, Outcome::Allow);
}

#[test]
fn a_hook_can_rewrite_a_command() {
    let (_scratch, sandbox) = fixture(Limits::default());
    let outcome = sandbox
        .hook("toolBefore", &call("rewrite-me"), DEFAULT_DEADLINE_MS)
        .expect("hook returns");
    assert_eq!(
        outcome,
        Outcome::Rewrite {
            input: json!({ "command": "git push --dry-run" })
        }
    );
}

#[test]
fn a_rewrite_keeps_the_other_input_fields() {
    let (_scratch, sandbox) = fixture(Limits::default());
    let mut input = call("rewrite-me");
    input.input = json!({ "command": "git push origin main", "cwd": "/repo", "dry": false });
    let outcome = sandbox
        .hook("toolBefore", &input, DEFAULT_DEADLINE_MS)
        .expect("hook returns");
    assert_eq!(
        outcome,
        Outcome::Rewrite {
            input: json!({ "command": "git push --dry-run", "cwd": "/repo", "dry": false })
        }
    );
}

#[test]
fn a_runaway_loop_is_limited_by_the_deadline() {
    let (_scratch, sandbox) = fixture(Limits::default());
    let error = sandbox
        .hook("toolBefore", &call("loop"), 20)
        .expect_err("loop is interrupted");
    assert_eq!(error, EngineError::Limit(LimitCause::Deadline));
}

#[test]
fn a_memory_hog_is_limited_by_the_ceiling() {
    let (_scratch, sandbox) = fixture(Limits {
        memory_bytes: 1024 * 1024,
        call_deadline_ms: 1000,
    });
    let error = sandbox
        .hook("toolBefore", &call("hog"), 1000)
        .expect_err("allocation is refused");
    assert_eq!(error, EngineError::Limit(LimitCause::Memory));
}

const TWO_HOSTS: &str = r#"
return {
    name = "two-hosts",
    spin = function() while true do end end,
    allocate = function(call, ctx)
        return ctx.deny(tostring(#string.rep("x", call.input.bytes)))
    end,
    lookup = function(call, ctx)
        if ctx.lookup == nil then return ctx.deny("unavailable") end
        return ctx.deny(ctx.lookup(call.input).text)
    end,
}
"#;

#[test]
fn a_second_host_with_different_limits_works() {
    let scratch = Scratch::new();
    scratch.write("plugin.luau", TWO_HOSTS);
    let smaller = Limits {
        memory_bytes: 1024 * 1024,
        call_deadline_ms: 50,
    };
    let larger = Limits {
        memory_bytes: 16 * 1024 * 1024,
        call_deadline_ms: 1000,
    };
    let mut capabilities = Capabilities::default();
    capabilities.insert("lookup", |input| match input["id"].as_str() {
        Some("record") => Ok(json!({ "text": "only in the second host" })),
        _ => Err("record not found".into()),
    });

    let first = Sandbox::new(scratch.path(), smaller, Capabilities::default()).expect("first host");
    let second = Sandbox::new(scratch.path(), larger, capabilities).expect("second host");
    let call_for = |input| Call {
        tool: "test".into(),
        name: "test".into(),
        input,
        session_id: None,
    };

    let allocation = call_for(json!({ "bytes": 2 * 1024 * 1024 }));
    assert_eq!(
        first.hook("allocate", &allocation, 5000),
        Err(EngineError::Limit(LimitCause::Memory))
    );
    assert_eq!(
        second.hook("allocate", &allocation, 5000),
        Ok(Outcome::Deny {
            reason: "2097152".into()
        })
    );
    assert_eq!(
        second.hook(
            "allocate",
            &call_for(json!({ "bytes": 32 * 1024 * 1024 })),
            5000
        ),
        Err(EngineError::Limit(LimitCause::Memory))
    );

    let lookup = call_for(json!({ "id": "record" }));
    assert_eq!(
        first.hook("lookup", &lookup, 5000),
        Ok(Outcome::Deny {
            reason: "unavailable".into()
        })
    );
    assert_eq!(
        second.hook("lookup", &lookup, 5000),
        Ok(Outcome::Deny {
            reason: "only in the second host".into()
        })
    );
    assert_eq!(
        second.hook("lookup", &call_for(json!({ "id": "missing" })), 5000),
        Err(EngineError::Capability {
            name: "lookup".into(),
            reason: "record not found".into()
        })
    );

    let spin = call_for(Value::Null);
    assert_deadline_between(
        &first,
        &spin,
        smaller.call_deadline_ms,
        larger.call_deadline_ms,
    );
    assert_deadline_between(&second, &spin, larger.call_deadline_ms, 4000);
}

fn assert_deadline_between(sandbox: &Sandbox, spin: &Call, lower_ms: u64, upper_ms: u64) {
    let started = Instant::now();
    assert_eq!(
        sandbox.hook("spin", spin, 5000),
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
    let (_scratch, sandbox) = fixture(Limits::default());
    let mut input = json!(1);
    for _ in 0..=MAX_DEPTH + 1 {
        input = json!([input]);
    }
    let error = sandbox
        .tool("guard_status", &input, DEFAULT_DEADLINE_MS)
        .expect_err("deep input is refused");
    assert_eq!(
        error,
        EngineError::Limit(LimitCause::TooDeep { limit: MAX_DEPTH })
    );
}

#[test]
fn a_too_wide_input_is_limited_by_entry_count() {
    let (_scratch, sandbox) = fixture(Limits::default());
    let mut object = serde_json::Map::new();
    for index in 0..=MAX_ENTRIES {
        object.insert(format!("k{index}"), json!(index));
    }
    let error = sandbox
        .tool("guard_status", &Value::Object(object), DEFAULT_DEADLINE_MS)
        .expect_err("wide input is refused");
    assert_eq!(
        error,
        EngineError::Limit(LimitCause::TooManyEntries { limit: MAX_ENTRIES })
    );
}

#[test]
fn a_runaway_call_does_not_disarm_another_calls_deadline() {
    let (_scratch, sandbox) = fixture(Limits::default());
    std::thread::scope(|scope| {
        let looping = scope.spawn(|| sandbox.hook("toolBefore", &call("loop"), 20));
        let normal =
            scope.spawn(|| sandbox.hook("toolBefore", &call("shell"), DEFAULT_DEADLINE_MS));

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
        Limits {
            call_deadline_ms: 20,
            ..Limits::default()
        },
        Capabilities::default(),
    )
    .expect_err("top-level loop is interrupted");
    assert_eq!(error, EngineError::Limit(LimitCause::Deadline));
}

#[test]
fn scoped_require_loads_a_sibling_module() {
    let (_scratch, sandbox) = fixture(Limits::default());
    let outcome = sandbox
        .hook("toolBefore", &call("help"), DEFAULT_DEADLINE_MS)
        .expect("hook returns");
    assert_eq!(
        outcome,
        Outcome::Deny {
            reason: "helper says no".into()
        }
    );
    let content = sandbox
        .tool("require_helper", &json!({}), DEFAULT_DEADLINE_MS)
        .expect("tool returns");
    assert_eq!(
        content,
        vec![Content {
            kind: "text".into(),
            text: "helper says no".into()
        }]
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
        let error = Sandbox::new(scratch.path(), Limits::default(), Capabilities::default())
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
    let error = Sandbox::new(scratch.path(), Limits::default(), Capabilities::default())
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
    let error = Sandbox::new(scratch.path(), Limits::default(), Capabilities::default())
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
    let error = Sandbox::new(scratch.path(), Limits::default(), Capabilities::default())
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

    let sandbox = Sandbox::new(scratch.path(), Limits::default(), Capabilities::default())
        .expect("fixture loads");

    // The child's "./helper" is sub/helper.luau, not the root helper:
    // one returns a "sub" field and the other a "root" field.
    let resolved = sandbox
        .tool("resolved", &json!({}), DEFAULT_DEADLINE_MS)
        .expect("tool returns");
    assert_eq!(
        resolved,
        vec![
            Content {
                kind: "text".into(),
                text: "from sub".into()
            },
            Content {
                kind: "text".into(),
                text: "from root".into()
            },
        ]
    );

    let refused = sandbox
        .tool("refused", &json!({}), DEFAULT_DEADLINE_MS)
        .expect("tool returns");
    assert_eq!(
        refused,
        vec![Content {
            kind: "text".into(),
            text: "false".into()
        }]
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
toolBefore = function(call, ctx)
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

    let sandbox = Sandbox::new(scratch.path(), Limits::default(), Capabilities::default())
        .expect("fixture loads");

    // The deferred call runs after child.luau finished loading; its
    // require still resolves against sub/, not the plugin root.
    let outcome = sandbox
        .hook("toolBefore", &call("shell"), DEFAULT_DEADLINE_MS)
        .expect("hook returns");
    assert_eq!(
        outcome,
        Outcome::Deny {
            reason: "from sub".into()
        }
    );
    let content = sandbox
        .tool("deferred", &json!({}), DEFAULT_DEADLINE_MS)
        .expect("tool returns");
    assert_eq!(
        content,
        vec![Content {
            kind: "text".into(),
            text: "from sub".into()
        }]
    );
}

#[test]
fn a_tool_returns_text_content() {
    let (_scratch, sandbox) = fixture(Limits::default());
    let content = sandbox
        .tool("guard_status", &json!({}), DEFAULT_DEADLINE_MS)
        .expect("tool returns");
    assert_eq!(
        content,
        vec![Content {
            kind: "text".into(),
            text: "guard_status: daemon ok".into()
        }]
    );
}

#[test]
fn global_require_is_a_refuser_through_getfenv() {
    let (_scratch, sandbox) = fixture(Limits::default());
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
    let (_scratch, sandbox) = fixture(Limits::default());
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
    let sandbox = Sandbox::new(scratch.path(), Limits::default(), Capabilities::default())
        .expect("fixture loads");

    let content = sandbox
        .tool("probe", &json!({}), DEFAULT_DEADLINE_MS)
        .expect("tool returns");
    assert_eq!(
        content,
        vec![Content {
            kind: "text".into(),
            text: format!("false|{REQUIRE_CONFINED}"),
        }]
    );
}

#[test]
fn manifest_reads_the_fixture() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/safe-push");
    let sandbox =
        Sandbox::new(&folder, Limits::default(), Capabilities::default()).expect("fixture loads");
    let manifest = sandbox.manifest().expect("manifest reads");
    assert_eq!(manifest.name, "safe-push");
    assert_eq!(manifest.tools.len(), 1);
    assert_eq!(manifest.tools[0].name, "guard_status");
    assert_eq!(manifest.tools[0].input, json!({}));
}

#[test]
fn manifest_refuses_a_duplicate_tool_name() {
    let scratch = Scratch::new();
    scratch.write("plugin.luau", DUPLICATE);
    let sandbox =
        Sandbox::new(scratch.path(), Limits::default(), Capabilities::default()).expect("loads");
    let error = sandbox.manifest().expect_err("duplicate is refused");
    assert_eq!(
        error,
        EngineError::InvalidResult("tack: duplicate tool name: repeated".into())
    );
}

#[test]
fn a_poisoned_call_lock_fails_closed() {
    let (_scratch, sandbox) = fixture(Limits::default());
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = sandbox.call_lock.lock().expect("acquire the call lock");
        panic!("poison the call lock");
    }));
    assert!(panicked.is_err());

    assert_eq!(
        sandbox.hook("toolBefore", &call("shell"), DEFAULT_DEADLINE_MS),
        Err(EngineError::Poisoned)
    );
    assert_eq!(
        sandbox.tool("guard_status", &json!({}), DEFAULT_DEADLINE_MS),
        Err(EngineError::Poisoned)
    );
    assert_eq!(sandbox.manifest(), Err(EngineError::Poisoned));
}
