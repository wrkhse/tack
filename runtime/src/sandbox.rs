//! One mlua VM per plugin, bounded by a memory ceiling and a per-call clock.
//!
//! The plugin is a Luau table at plugin.luau: named hook functions and a tools
//! table. A hook returns nil for allow, a deny table or a rewrite table; a
//! tool returns a table of content items. Every input crossing the boundary is
//! converted under both a depth and a table-size ceiling.

use std::collections::HashSet;
use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use mlua::{Function, Lua, Table, Value as LuaValue, VmState};
use serde_json::Value;

use tack_protocol::wire::{Content, Outcome, PluginManifest, ToolCall, ToolDef};

use crate::require;

const DEADLINE_MESSAGE: &str = "tack: script deadline exceeded";
const MAX_DEPTH: usize = 16;
const MAX_ENTRIES: usize = 1024;

#[derive(Debug)]
pub enum EngineError {
    Load(String),
    Script(String),
    Limit(String),
    UnknownHook(String),
    UnknownTool(String),
    InvalidResult(String),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::Load(message)
            | EngineError::Script(message)
            | EngineError::Limit(message)
            | EngineError::UnknownHook(message)
            | EngineError::UnknownTool(message)
            | EngineError::InvalidResult(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<mlua::Error> for EngineError {
    fn from(error: mlua::Error) -> Self {
        match &error {
            mlua::Error::MemoryError(_) => EngineError::Limit(error.to_string()),
            mlua::Error::RuntimeError(message) if message.contains(DEADLINE_MESSAGE) => {
                EngineError::Limit(error.to_string())
            }
            _ => EngineError::Script(error.to_string()),
        }
    }
}

struct Deadline {
    started: Mutex<Instant>,
    budget_us: AtomicU64,
}

impl Deadline {
    fn new() -> Self {
        Self {
            started: Mutex::new(Instant::now()),
            budget_us: AtomicU64::new(u64::MAX),
        }
    }

    fn begin(&self, ms: u64) {
        *self.started.lock().expect("deadline clock poisoned") = Instant::now();
        self.budget_us
            .store(ms.saturating_mul(1000), Ordering::Relaxed);
    }

    fn disarm(&self) {
        self.budget_us.store(u64::MAX, Ordering::Relaxed);
    }

    fn expired(&self) -> bool {
        let budget = self.budget_us.load(Ordering::Relaxed);
        if budget == u64::MAX {
            return false;
        }
        let elapsed = self
            .started
            .lock()
            .expect("deadline clock poisoned")
            .elapsed();
        elapsed.as_micros() >= u128::from(budget)
    }
}

pub struct Sandbox {
    lua: Lua,
    plugin: Table,
    deadline: Arc<Deadline>,
    default_deadline_ms: u64,
}

impl Sandbox {
    pub fn new(
        folder: &Path,
        memory_bytes: usize,
        deadline_ms: u64,
    ) -> Result<Sandbox, EngineError> {
        let lua = Lua::new();
        let state = require::RequireState::new(folder).map_err(EngineError::Load)?;
        let loader = require::install(&lua, state)?;
        lua.globals().set("require", loader.clone())?;
        lua.sandbox(true)?;
        lua.set_memory_limit(memory_bytes)?;

        let deadline = Arc::new(Deadline::new());
        let watchdog = Arc::clone(&deadline);
        lua.set_interrupt(move |_| {
            if watchdog.expired() {
                Err(mlua::Error::runtime(DEADLINE_MESSAGE))
            } else {
                Ok(VmState::Continue)
            }
        });

        let plugin = load_plugin(&loader)?;
        Ok(Self {
            lua,
            plugin,
            deadline,
            default_deadline_ms: deadline_ms,
        })
    }

    pub fn hook(
        &self,
        hook: &str,
        call: &ToolCall,
        deadline_ms: u64,
    ) -> Result<Outcome, EngineError> {
        self.deadline.begin(deadline_ms);
        let outcome = self.run_hook(hook, call);
        self.deadline.disarm();
        outcome
    }

    pub fn tool(
        &self,
        name: &str,
        input: &Value,
        deadline_ms: u64,
    ) -> Result<Vec<Content>, EngineError> {
        self.deadline.begin(deadline_ms);
        let content = self.run_tool(name, input);
        self.deadline.disarm();
        content
    }

    pub fn manifest(&self) -> Result<PluginManifest, EngineError> {
        self.deadline.begin(self.default_deadline_ms);
        let manifest = self.read_manifest();
        self.deadline.disarm();
        manifest
    }

    fn run_hook(&self, hook: &str, call: &ToolCall) -> Result<Outcome, EngineError> {
        let Some(function) = self.plugin.get::<Option<Function>>(hook)? else {
            return Ok(Outcome::Allow);
        };
        let result = function.call::<LuaValue>((self.call_table(call)?, self.ctx()?))?;
        decode_outcome(result)
    }

    fn run_tool(&self, name: &str, input: &Value) -> Result<Vec<Content>, EngineError> {
        let tools = self
            .plugin
            .get::<Option<Table>>("tools")?
            .ok_or_else(|| EngineError::UnknownTool(name.to_owned()))?;
        let definition = tools
            .get::<Option<Table>>(name)?
            .ok_or_else(|| EngineError::UnknownTool(name.to_owned()))?;
        let run = definition
            .get::<Option<Function>>("run")?
            .ok_or_else(|| EngineError::UnknownTool(name.to_owned()))?;
        let lua_input = json_to_lua(&self.lua, input, 0)?;
        let result = run.call::<LuaValue>((lua_input, self.ctx()?))?;
        decode_content(result)
    }

    fn call_table(&self, call: &ToolCall) -> Result<Table, EngineError> {
        let table = self.lua.create_table()?;
        table.set("tool", call.tool.as_str())?;
        table.set("name", call.name.as_str())?;
        table.set("input", json_to_lua(&self.lua, &call.input, 0)?)?;
        match &call.session_id {
            Some(session) => table.set("session_id", session.as_str())?,
            None => table.set("session_id", LuaValue::Nil)?,
        }
        Ok(table)
    }

    fn ctx(&self) -> Result<Table, EngineError> {
        let ctx = self.lua.create_table()?;
        ctx.set(
            "deny",
            self.lua.create_function(|lua, reason: String| {
                let result = lua.create_table()?;
                result.set("deny", reason)?;
                Ok(result)
            })?,
        )?;
        ctx.set(
            "rewrite",
            self.lua.create_function(|lua, command: String| {
                let rewritten = lua.create_table()?;
                rewritten.set("command", command)?;
                let result = lua.create_table()?;
                result.set("rewrite", rewritten)?;
                Ok(result)
            })?,
        )?;
        ctx.set(
            "allow",
            self.lua.create_function(|_, ()| Ok(LuaValue::Nil))?,
        )?;
        Ok(ctx)
    }
}

fn load_plugin(loader: &Function) -> Result<Table, EngineError> {
    let value: LuaValue = loader
        .call(("./plugin",))
        .map_err(|error| EngineError::Load(error.to_string()))?;
    match value {
        LuaValue::Table(table) => Ok(table),
        _ => Err(EngineError::Load(
            "tack: plugin.luau must return a table".into(),
        )),
    }
}

fn decode_outcome(value: LuaValue) -> Result<Outcome, EngineError> {
    let table = match value {
        LuaValue::Nil => return Ok(Outcome::Allow),
        LuaValue::Table(table) => table,
        _ => {
            return Err(EngineError::InvalidResult(
                "tack: hook must return a table or nil".into(),
            ));
        }
    };
    if let Some(reason) = table.get::<Option<String>>("deny")? {
        return Ok(Outcome::Deny { reason });
    }
    if let Some(rewrite) = table.get::<Option<Table>>("rewrite")? {
        let command = rewrite
            .get::<Option<String>>("command")?
            .ok_or_else(|| EngineError::InvalidResult("tack: rewrite needs a command".into()))?;
        return Ok(Outcome::Rewrite {
            input: serde_json::json!({ "command": command }),
        });
    }
    Err(EngineError::InvalidResult(
        "tack: hook result has no deny or rewrite".into(),
    ))
}

fn decode_content(value: LuaValue) -> Result<Vec<Content>, EngineError> {
    let table = match value {
        LuaValue::Table(table) => table,
        _ => {
            return Err(EngineError::InvalidResult(
                "tack: tool must return a table".into(),
            ));
        }
    };
    let content = table
        .get::<Option<Table>>("content")?
        .ok_or_else(|| EngineError::InvalidResult("tack: tool result needs content".into()))?;
    let mut decoded = Vec::new();
    for pair in content.pairs::<LuaValue, LuaValue>() {
        if decoded.len() >= MAX_ENTRIES {
            return Err(EngineError::Limit("tack: tool content is too large".into()));
        }
        let (_, item) = pair?;
        let item = match item {
            LuaValue::Table(table) => table,
            _ => {
                return Err(EngineError::InvalidResult(
                    "tack: content item must be a table".into(),
                ));
            }
        };
        let kind = item
            .get::<Option<String>>("kind")?
            .ok_or_else(|| EngineError::InvalidResult("tack: content needs kind".into()))?;
        let text = item
            .get::<Option<String>>("text")?
            .ok_or_else(|| EngineError::InvalidResult("tack: content needs text".into()))?;
        decoded.push(Content { kind, text });
    }
    Ok(decoded)
}

impl Sandbox {
    fn read_manifest(&self) -> Result<PluginManifest, EngineError> {
        let name = self
            .plugin
            .get::<Option<String>>("name")?
            .unwrap_or_default();
        if name.is_empty() {
            return Err(EngineError::InvalidResult(
                "tack: plugin name is empty".into(),
            ));
        }
        Ok(PluginManifest {
            name,
            needs: self.read_needs()?,
            tools: self.read_tools()?,
        })
    }

    fn read_needs(&self) -> Result<Vec<String>, EngineError> {
        let Some(value) = self.plugin.get::<Option<LuaValue>>("needs")? else {
            return Ok(Vec::new());
        };
        let table = match value {
            LuaValue::Table(table) => table,
            _ => {
                return Err(EngineError::InvalidResult(
                    "tack: needs must be an array".into(),
                ));
            }
        };
        let mut needs = Vec::new();
        for pair in table.pairs::<LuaValue, LuaValue>() {
            if needs.len() >= MAX_ENTRIES {
                return Err(EngineError::Limit("tack: too many needs".into()));
            }
            let (_, item) = pair?;
            let need = match item {
                LuaValue::String(value) => value.to_str()?.to_string(),
                _ => {
                    return Err(EngineError::InvalidResult(
                        "tack: needs must contain strings".into(),
                    ));
                }
            };
            needs.push(need);
        }
        Ok(needs)
    }

    fn read_tools(&self) -> Result<Vec<ToolDef>, EngineError> {
        let Some(tools) = self.plugin.get::<Option<Table>>("tools")? else {
            return Ok(Vec::new());
        };
        let mut definitions = Vec::new();
        let mut seen = HashSet::new();
        for pair in tools.pairs::<LuaValue, LuaValue>() {
            if definitions.len() >= MAX_ENTRIES {
                return Err(EngineError::Limit("tack: too many tools".into()));
            }
            let (key, value) = pair?;
            let key = lua_key(key)?;
            let table = match value {
                LuaValue::Table(table) => table,
                _ => {
                    return Err(EngineError::InvalidResult(
                        "tack: tool must be a table".into(),
                    ));
                }
            };
            let definition = read_tool(&table, &key)?;
            if definition.name.is_empty() {
                return Err(EngineError::InvalidResult("tack: empty tool name".into()));
            }
            if !seen.insert(definition.name.clone()) {
                return Err(EngineError::InvalidResult(format!(
                    "tack: duplicate tool name: {}",
                    definition.name
                )));
            }
            definitions.push(definition);
        }
        Ok(definitions)
    }
}

fn read_tool(table: &Table, key: &str) -> Result<ToolDef, EngineError> {
    let name = table
        .get::<Option<String>>("name")?
        .unwrap_or_else(|| key.to_owned());
    let description = table
        .get::<Option<String>>("description")?
        .unwrap_or_default();
    let input = match table.get::<Option<LuaValue>>("input")? {
        Some(value) => lua_to_json(value, 0)?,
        None => serde_json::json!({}),
    };
    Ok(ToolDef {
        name,
        description,
        input,
    })
}

fn lua_key(value: LuaValue) -> Result<String, EngineError> {
    match value {
        LuaValue::String(value) => Ok(value.to_str()?.to_string()),
        LuaValue::Integer(value) => Ok(value.to_string()),
        LuaValue::Number(value) => Ok(value.to_string()),
        _ => Err(EngineError::InvalidResult(
            "tack: tool key must be a string".into(),
        )),
    }
}

fn json_to_lua(lua: &Lua, value: &Value, depth: usize) -> Result<LuaValue, EngineError> {
    if depth > MAX_DEPTH {
        return Err(EngineError::Limit("tack: JSON nesting too deep".into()));
    }
    match value {
        Value::Null => Ok(LuaValue::Nil),
        Value::Bool(value) => Ok(LuaValue::Boolean(*value)),
        Value::Number(value) => match value.as_i64() {
            Some(number) => Ok(LuaValue::Integer(number)),
            None => value
                .as_f64()
                .map(LuaValue::Number)
                .ok_or_else(|| EngineError::InvalidResult("tack: invalid JSON number".into())),
        },
        Value::String(value) => Ok(LuaValue::String(lua.create_string(value.as_bytes())?)),
        Value::Array(values) => {
            if values.len() > MAX_ENTRIES {
                return Err(EngineError::Limit("tack: JSON array too large".into()));
            }
            let table = lua.create_table()?;
            for (index, item) in values.iter().enumerate() {
                table.set((index + 1) as i64, json_to_lua(lua, item, depth + 1)?)?;
            }
            Ok(LuaValue::Table(table))
        }
        Value::Object(values) => {
            if values.len() > MAX_ENTRIES {
                return Err(EngineError::Limit("tack: JSON object too large".into()));
            }
            let table = lua.create_table()?;
            for (key, item) in values {
                table.set(key.as_str(), json_to_lua(lua, item, depth + 1)?)?;
            }
            Ok(LuaValue::Table(table))
        }
    }
}

fn lua_to_json(value: LuaValue, depth: usize) -> Result<Value, EngineError> {
    if depth > MAX_DEPTH {
        return Err(EngineError::Limit("tack: Lua nesting too deep".into()));
    }
    match value {
        LuaValue::Nil => Ok(Value::Null),
        LuaValue::Boolean(value) => Ok(Value::Bool(value)),
        LuaValue::Integer(value) => Ok(Value::Number(value.into())),
        LuaValue::Number(value) => serde_json::Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| EngineError::InvalidResult("tack: non-finite Lua number".into())),
        LuaValue::String(value) => Ok(Value::String(value.to_str()?.to_string())),
        LuaValue::Table(table) => lua_table_to_json(&table, depth),
        _ => Err(EngineError::InvalidResult(
            "tack: unsupported Lua value".into(),
        )),
    }
}

fn lua_table_to_json(table: &Table, depth: usize) -> Result<Value, EngineError> {
    let mut object = serde_json::Map::new();
    let mut array = Vec::new();
    let mut array_mode: Option<bool> = None;

    for pair in table.pairs::<LuaValue, LuaValue>() {
        if object.len() + array.len() >= MAX_ENTRIES {
            return Err(EngineError::Limit("tack: Lua table too large".into()));
        }
        let (key, value) = pair?;
        match key {
            LuaValue::String(key) => {
                if array_mode == Some(true) {
                    return Err(EngineError::InvalidResult("tack: mixed table keys".into()));
                }
                array_mode = Some(false);
                object.insert(key.to_str()?.to_string(), lua_to_json(value, depth + 1)?);
            }
            LuaValue::Integer(index) => {
                if array_mode == Some(false) {
                    return Err(EngineError::InvalidResult("tack: mixed table keys".into()));
                }
                array_mode = Some(true);
                array.push((index, lua_to_json(value, depth + 1)?));
            }
            LuaValue::Number(index)
                if index.fract() == 0.0 && (1.0..=MAX_ENTRIES as f64).contains(&index) =>
            {
                if array_mode == Some(false) {
                    return Err(EngineError::InvalidResult("tack: mixed table keys".into()));
                }
                array_mode = Some(true);
                array.push((index as i64, lua_to_json(value, depth + 1)?));
            }
            _ => {
                return Err(EngineError::InvalidResult(
                    "tack: unsupported table key".into(),
                ));
            }
        }
    }

    if array_mode != Some(true) {
        return Ok(Value::Object(object));
    }
    array.sort_by_key(|(index, _)| *index);
    for (position, (index, _)) in array.iter().enumerate() {
        if *index != (position + 1) as i64 {
            return Err(EngineError::InvalidResult("tack: sparse Lua array".into()));
        }
    }
    Ok(Value::Array(
        array.into_iter().map(|(_, value)| value).collect(),
    ))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;
    use tack_protocol::{DEFAULT_DEADLINE_MS, DEFAULT_MEMORY_BYTES};

    use super::*;

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
            std::fs::write(self.root.join(name), contents).expect("write fixture");
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

    fn fixture(memory_bytes: usize) -> (Scratch, Sandbox) {
        let scratch = Scratch::new();
        scratch.write("plugin.luau", PLUGIN);
        scratch.write("helper.luau", HELPER);
        let sandbox =
            Sandbox::new(scratch.path(), memory_bytes, DEFAULT_DEADLINE_MS).expect("fixture loads");
        (scratch, sandbox)
    }

    fn call(tool: &str) -> ToolCall {
        ToolCall {
            tool: tool.to_owned(),
            name: tool.to_owned(),
            input: json!({ "command": "git push origin main" }),
            session_id: None,
        }
    }

    #[test]
    fn tool_before_denies_a_shell_git_push() {
        let (_scratch, sandbox) = fixture(DEFAULT_MEMORY_BYTES);
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
        let (_scratch, sandbox) = fixture(DEFAULT_MEMORY_BYTES);
        let outcome = sandbox
            .hook("permissionAsked", &call("shell"), DEFAULT_DEADLINE_MS)
            .expect("hook returns");
        assert_eq!(outcome, Outcome::Allow);
    }

    #[test]
    fn a_hook_can_rewrite_a_command() {
        let (_scratch, sandbox) = fixture(DEFAULT_MEMORY_BYTES);
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
    fn a_runaway_loop_is_limited_by_the_deadline() {
        assert_eq!(DEFAULT_DEADLINE_MS, 100);
        let (_scratch, sandbox) = fixture(DEFAULT_MEMORY_BYTES);
        let error = sandbox
            .hook("toolBefore", &call("loop"), 20)
            .expect_err("loop is interrupted");
        assert!(matches!(error, EngineError::Limit(_)), "got {error:?}");
    }

    #[test]
    fn a_memory_hog_is_limited_by_the_ceiling() {
        assert_eq!(DEFAULT_MEMORY_BYTES, 16 * 1024 * 1024);
        let (_scratch, sandbox) = fixture(1024 * 1024);
        let error = sandbox
            .hook("toolBefore", &call("hog"), 1000)
            .expect_err("allocation is refused");
        assert!(matches!(error, EngineError::Limit(_)), "got {error:?}");
    }

    #[test]
    fn scoped_require_loads_a_sibling_module() {
        let (_scratch, sandbox) = fixture(DEFAULT_MEMORY_BYTES);
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
        for (source, expected) in [
            (
                r#"local x = require("../escape") return { name = "x" }"#,
                "parent",
            ),
            (
                r#"local x = require("/etc/passwd") return { name = "x" }"#,
                "absolute",
            ),
        ] {
            let scratch = Scratch::new();
            scratch.write("plugin.luau", source);
            let error = Sandbox::new(scratch.path(), DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS)
                .err()
                .expect("require is refused");
            assert!(
                matches!(&error, EngineError::Load(message) if message.contains(expected)),
                "got {error:?}"
            );
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
        let error = Sandbox::new(scratch.path(), DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS)
            .err()
            .expect("cycle is refused");
        assert!(
            matches!(&error, EngineError::Load(message) if message.contains("cycle")),
            "got {error:?}"
        );
    }

    #[test]
    fn the_global_require_is_the_scoped_one() {
        let (_scratch, sandbox) = fixture(DEFAULT_MEMORY_BYTES);
        let content = sandbox
            .tool("require_absolute", &json!({}), DEFAULT_DEADLINE_MS)
            .expect("tool returns");
        assert_eq!(
            content,
            vec![Content {
                kind: "text".into(),
                text: "false".into()
            }]
        );
    }

    #[test]
    fn a_tool_returns_text_content() {
        let (_scratch, sandbox) = fixture(DEFAULT_MEMORY_BYTES);
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
    fn manifest_reads_the_fixture() {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/safe-push");
        let sandbox = Sandbox::new(&folder, DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS)
            .expect("fixture loads");
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
            Sandbox::new(scratch.path(), DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS).expect("loads");
        let error = sandbox.manifest().expect_err("duplicate is refused");
        assert!(
            matches!(&error, EngineError::InvalidResult(message) if message.contains("duplicate")),
            "got {error:?}"
        );
    }
}
