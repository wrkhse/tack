use mlua::{Table, Value as LuaValue};

use serde_json::Value;

use super::errors::EngineError;
use super::values::json_to_lua;

impl super::Sandbox {
    pub(super) fn ctx(&self, context: &Value) -> Result<Table, EngineError> {
        let ctx = match json_to_lua(&self.lua, context, 0)? {
            LuaValue::Table(table) if context.is_object() => table,
            host => {
                let table = self.lua.create_table()?;
                table.raw_set("host", host)?;
                table
            }
        };

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
            self.lua.create_function(|lua, payload: LuaValue| {
                // Lua removes a field assigned nil; retain an explicit null rewrite.
                let replacement = if matches!(payload, LuaValue::Nil) {
                    LuaValue::NULL
                } else {
                    payload
                };

                let result = lua.create_table()?;
                result.raw_set("rewrite", replacement)?;
                Ok(result)
            })?,
        )?;
        ctx.set(
            "allow",
            self.lua.create_function(|_, ()| Ok(LuaValue::Nil))?,
        )?;
        self.capabilities
            .populate(&self.lua, &ctx, &self.deadline)?;

        Ok(ctx)
    }
}
