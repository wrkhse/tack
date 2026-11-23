//! One mlua VM per plugin, bounded by a memory ceiling and a per-call clock.
//!
//! The plugin is a Luau table at plugin.luau: named hook functions and a tools
//! table. A hook returns nil for allow, a deny table or a rewrite table; a
//! tool returns a table of content items. Every input crossing the boundary is
//! converted under both a depth and a table-size ceiling.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use mlua::{Function, Lua, Table, Value as LuaValue, VmState};
use serde_json::Value;

use tack_protocol::wire::{Content, Outcome, PluginManifest, ToolCall, ToolDef};

use crate::require;

pub use crate::require::RequireCause;

mod deadline;
mod errors;
mod loading;
mod outcome;
#[cfg(test)]
mod tests;
mod tools;
mod values;

pub use errors::{EngineError, LimitCause, LoadCause};

use deadline::Deadline;
use errors::MAX_ENTRIES;
use loading::load_plugin;
use outcome::{decode_content, decode_outcome};
use values::{json_to_lua, lua_key, read_tool};

pub struct Sandbox {
    lua: Lua,
    plugin: Table,
    deadline: Arc<Deadline>,
    call_lock: Mutex<()>,
    default_deadline_ms: u64,
}

impl Sandbox {
    pub fn new(
        folder: &Path,
        memory_bytes: usize,
        deadline_ms: u64,
    ) -> Result<Sandbox, EngineError> {
        let lua = Lua::new();
        let state = require::RequireState::new(folder)
            .map_err(|message| EngineError::Load(LoadCause::Message(message)))?;
        let loader = require::install(&lua, state)?;
        require::confine_global_require(&lua)?;
        lua.sandbox(true)?;
        lua.set_memory_limit(memory_bytes)?;

        let deadline = Arc::new(Deadline::new());
        let watchdog = Arc::clone(&deadline);
        lua.set_interrupt(move |_| {
            if watchdog.expired() {
                Err(mlua::Error::external(LimitCause::Deadline))
            } else {
                Ok(VmState::Continue)
            }
        });

        // A top-level loop must not hang startup either. The deadline is
        // armed around the entry chunk, then disarmed before the VM is shared.
        deadline.begin(deadline_ms);
        let plugin = load_plugin(&loader);
        deadline.disarm();

        Ok(Self {
            lua,
            plugin: plugin?,
            deadline,
            call_lock: Mutex::new(()),
            default_deadline_ms: deadline_ms,
        })
    }

    pub fn hook(
        &self,
        hook: &str,
        call: &ToolCall,
        deadline_ms: u64,
    ) -> Result<Outcome, EngineError> {
        let _guard = self.call_lock.lock().unwrap_or_else(|e| e.into_inner());
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
        let _guard = self.call_lock.lock().unwrap_or_else(|e| e.into_inner());
        self.deadline.begin(deadline_ms);
        let content = self.run_tool(name, input);
        self.deadline.disarm();
        content
    }

    pub fn manifest(&self) -> Result<PluginManifest, EngineError> {
        let _guard = self.call_lock.lock().unwrap_or_else(|e| e.into_inner());
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
        decode_outcome(result, &call.input)
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
                return Err(EngineError::Limit(LimitCause::TooManyEntries {
                    limit: MAX_ENTRIES,
                }));
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
                return Err(EngineError::Limit(LimitCause::TooManyEntries {
                    limit: MAX_ENTRIES,
                }));
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
