use mlua::{Table, Value as LuaValue};
use tack_protocol::wire::ToolCall;

use super::errors::EngineError;
use super::values::json_to_lua;

impl super::Sandbox {
    pub(super) fn call_table(&self, call: &ToolCall) -> Result<Table, EngineError> {
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

    pub(super) fn ctx(&self) -> Result<Table, EngineError> {
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
