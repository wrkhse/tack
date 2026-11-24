//! One mlua VM per plugin, bounded by a memory ceiling and a per-call clock.
//!
//! The plugin is a Luau table at plugin.luau: named hook functions and a tools
//! table. A hook returns nil for allow, a deny table or a rewrite table; a
//! runnable returns a JSON-compatible value. Every input crossing the boundary is
//! converted under both a depth and a table-size ceiling.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use mlua::{Function, Lua, Table, Value as LuaValue, VmState};
use serde_json::{Value, json};

use crate::api::{Invocation, Outcome};
use crate::require;

mod call;
mod capabilities;
mod deadline;
mod errors;
mod loading;
mod outcome;
#[cfg(test)]
mod tests;
mod values;

pub use capabilities::Capabilities;
pub use errors::{EngineError, LimitCause, LoadCause};

use deadline::Deadline;
use errors::MAX_ENTRIES;
use loading::load_plugin;
use outcome::decode_outcome;
use values::{json_to_lua, lua_key, lua_to_json, read_tool};

// The supported floor for the VM, its sandbox globals, and plugin startup.
const MIN_MEMORY_BYTES: usize = 16 * 1024 * 1024;

/// The host's bounds for a single sandbox.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    memory_bytes: usize,
    call_deadline_ms: u64,
}

impl Limits {
    /// Set the Luau allocator ceiling and the budget in milliseconds for
    /// startup, manifest reads, and each call.
    ///
    /// # Errors
    ///
    /// Returns a memory limit error for ceilings below the 16 MiB VM baseline.
    pub const fn new(memory_bytes: usize, call_deadline_ms: u64) -> Result<Self, EngineError> {
        if memory_bytes < MIN_MEMORY_BYTES {
            return Err(EngineError::Limit(LimitCause::Memory));
        }

        Ok(Self {
            memory_bytes,
            call_deadline_ms,
        })
    }
}

/// A single plugin VM with its own limits and capabilities.
#[derive(Debug)]
pub struct Sandbox {
    lua: Lua,
    plugin: Table,
    deadline: Arc<Deadline>,
    call_lock: Mutex<()>,
    call_deadline_ms: u64,
    capabilities: Capabilities,
}

impl Sandbox {
    /// Build a sandbox rooted at `folder` under the given bounds.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::Load`] when the folder or entry module cannot be
    /// loaded, [`EngineError::Limit`] when startup exhausts a bound, and
    /// [`EngineError::InvalidResult`] when a capability uses a reserved name.
    pub fn new(
        folder: &Path,
        limits: Limits,
        capabilities: Capabilities,
    ) -> Result<Self, EngineError> {
        capabilities.validate()?;
        let lua = Lua::new();
        lua.set_memory_limit(limits.memory_bytes)?;
        let state = require::RequireState::new(folder)
            .map_err(|message| EngineError::Load(LoadCause::Message(message)))?;
        let loader = require::install(&lua, state)?;
        require::confine_global_require(&lua)?;
        lua.sandbox(true)?;

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
        deadline.begin(limits.call_deadline_ms);
        let plugin = load_plugin(&loader);
        deadline.disarm();

        Ok(Self {
            lua,
            plugin: plugin?,
            deadline,
            call_lock: Mutex::new(()),
            call_deadline_ms: limits.call_deadline_ms,
            capabilities,
        })
    }

    /// Take the call lock, refusing to run after a caller panicked holding it.
    fn lock_call(&self) -> Result<MutexGuard<'_, ()>, EngineError> {
        self.call_lock.lock().map_err(|_| EngineError::Poisoned)
    }

    /// Run a named hook and decode its verdict within the smaller of the two deadlines.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::Limit`] when the call exceeds its deadline or
    /// memory ceiling, [`EngineError::InvalidResult`] when the hook returns
    /// a malformed result, [`EngineError::Capability`] when a callback error
    /// reaches the host, and [`EngineError::Poisoned`] after a call panics.
    pub fn hook(&self, invocation: &Invocation, deadline_ms: u64) -> Result<Outcome, EngineError> {
        let _guard = self.lock_call()?;
        self.deadline.begin(deadline_ms.min(self.call_deadline_ms));
        let outcome = self.run_hook(invocation);
        self.deadline.disarm();
        outcome
    }

    /// Run a named runnable and convert its result to JSON within the smaller deadline.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::UnknownTool`] when no such tool exists,
    /// [`EngineError::Limit`] when the call is bounded,
    /// [`EngineError::InvalidResult`] when the tool returns malformed content,
    /// [`EngineError::Capability`] when a callback error reaches the host,
    /// and [`EngineError::Poisoned`] after a call panics.
    pub fn run(&self, name: &str, input: &Value, deadline_ms: u64) -> Result<Value, EngineError> {
        let _guard = self.lock_call()?;
        self.deadline.begin(deadline_ms.min(self.call_deadline_ms));
        let result = self.run_runnable(name, input);
        self.deadline.disarm();
        result
    }

    /// Read the plugin's name, needs, and array of tool metadata as JSON.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::InvalidResult`] when the manifest is malformed
    /// or repeats a tool name, [`EngineError::Limit`] when reading is bounded,
    /// and [`EngineError::Poisoned`] when a previous call panicked while
    /// holding the call lock.
    pub fn manifest(&self) -> Result<Value, EngineError> {
        let _guard = self.lock_call()?;
        self.deadline.begin(self.call_deadline_ms);
        let manifest = self.read_manifest();
        self.deadline.disarm();
        manifest
    }

    fn run_hook(&self, invocation: &Invocation) -> Result<Outcome, EngineError> {
        let Some(function) = self
            .plugin
            .get::<Option<Function>>(invocation.hook.as_str())?
        else {
            return Ok(Outcome::Allow);
        };

        let payload = json_to_lua(&self.lua, &invocation.payload, 0)?;
        let result = function.call::<LuaValue>((payload, self.ctx(&invocation.context)?))?;

        decode_outcome(result)
    }

    fn run_runnable(&self, name: &str, input: &Value) -> Result<Value, EngineError> {
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
        let result = run.call::<LuaValue>((lua_input, self.ctx(&Value::Null)?))?;

        lua_to_json(result, 0)
    }
}

impl Sandbox {
    fn read_manifest(&self) -> Result<Value, EngineError> {
        let name = self
            .plugin
            .get::<Option<String>>("name")?
            .unwrap_or_default();
        if name.is_empty() {
            return Err(EngineError::InvalidResult("plugin name is empty".into()));
        }

        Ok(json!({
            "name": name,
            "needs": self.read_needs()?,
            "tools": self.read_tools()?,
        }))
    }

    fn read_needs(&self) -> Result<Vec<String>, EngineError> {
        let Some(value) = self.plugin.get::<Option<LuaValue>>("needs")? else {
            return Ok(Vec::new());
        };
        let LuaValue::Table(table) = value else {
            return Err(EngineError::InvalidResult("needs must be an array".into()));
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
                        "needs must contain strings".into(),
                    ));
                }
            };
            needs.push(need);
        }
        Ok(needs)
    }

    fn read_tools(&self) -> Result<Vec<Value>, EngineError> {
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
            let LuaValue::Table(table) = value else {
                return Err(EngineError::InvalidResult("tool must be a table".into()));
            };
            let (name, definition) = read_tool(&table, &key)?;
            if name.is_empty() {
                return Err(EngineError::InvalidResult("empty tool name".into()));
            }
            if seen.contains(&name) {
                return Err(EngineError::InvalidResult(format!(
                    "duplicate tool name: {name}"
                )));
            }
            seen.insert(name);
            definitions.push(definition);
        }
        Ok(definitions)
    }
}
