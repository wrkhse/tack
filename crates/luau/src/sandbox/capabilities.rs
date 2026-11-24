use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use mlua::{Lua, Table, Value as LuaValue};
use serde_json::Value;

use super::deadline::Deadline;
use super::errors::{EngineError, LimitCause};
use super::values::{json_to_lua, lua_to_json};

type Callback = dyn Fn(Value) -> Result<Value, String> + Send + Sync;

/// Host callbacks made available in a plugin's per-call context.
#[derive(Default)]
pub struct Capabilities {
    callbacks: HashMap<String, Arc<Callback>>,
}

impl Capabilities {
    /// Register or replace a callback invoked as `ctx.name(argument)`.
    ///
    /// The names `allow`, `deny`, and `rewrite` are reserved. Callbacks run
    /// synchronously; they must bound their own work and must not re-enter the
    /// same sandbox.
    pub fn insert(
        &mut self,
        name: impl Into<String>,
        callback: impl Fn(Value) -> Result<Value, String> + Send + Sync + 'static,
    ) {
        self.callbacks.insert(name.into(), Arc::new(callback));
    }

    pub(super) fn validate(&self) -> Result<(), EngineError> {
        for name in ["allow", "deny", "rewrite"] {
            if self.callbacks.contains_key(name) {
                return Err(EngineError::InvalidResult(format!(
                    "reserved capability name: {name}"
                )));
            }
        }

        Ok(())
    }

    pub(super) fn populate(
        &self,
        lua: &Lua,
        ctx: &Table,
        deadline: &Arc<Deadline>,
    ) -> Result<(), EngineError> {
        for (name, callback) in &self.callbacks {
            let capability = name.clone();
            let callback = Arc::clone(callback);
            let deadline = Arc::clone(deadline);

            let function = lua.create_function(move |lua, input: LuaValue| {
                let input = lua_to_json(input, 0).map_err(mlua::Error::external)?;
                check_deadline(&deadline)?;

                let result = callback(input);
                check_deadline(&deadline)?;

                let output = result.map_err(|reason| {
                    mlua::Error::external(EngineError::Capability {
                        name: capability.clone(),
                        reason,
                    })
                })?;

                json_to_lua(lua, &output, 0).map_err(mlua::Error::external)
            })?;
            ctx.raw_set(name.as_str(), function)?;
        }

        Ok(())
    }
}

impl fmt::Debug for Capabilities {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Capabilities")
            .field("count", &self.callbacks.len())
            .finish_non_exhaustive()
    }
}

fn check_deadline(deadline: &Deadline) -> mlua::Result<()> {
    if deadline.expired() {
        return Err(mlua::Error::external(LimitCause::Deadline));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_reports_only_the_callback_count() {
        let mut capabilities = Capabilities::default();
        capabilities.insert("lookup", Ok);

        assert_eq!(format!("{capabilities:?}"), "Capabilities { count: 1, .. }");
    }

    #[test]
    fn a_capability_refuses_an_expired_deadline() {
        let lua = Lua::new();
        let ctx = lua.create_table().expect("create context");
        let deadline = Arc::new(Deadline::new());
        let mut capabilities = Capabilities::default();
        capabilities.insert("lookup", |_| Ok(Value::Bool(true)));
        capabilities
            .populate(&lua, &ctx, &deadline)
            .expect("populate context");
        let lookup: mlua::Function = ctx.get("lookup").expect("registered callback");

        // Call the host function directly so a VM interrupt cannot provide the error.
        deadline.begin(0);
        assert_eq!(
            lookup.call::<bool>(()).map_err(EngineError::from),
            Err(EngineError::Limit(LimitCause::Deadline))
        );
    }
}
