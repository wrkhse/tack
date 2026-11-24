use mlua::Value as LuaValue;

use crate::api::Outcome;

use super::errors::EngineError;
use super::values::lua_to_json;

pub(super) fn decode_outcome(value: LuaValue) -> Result<Outcome, EngineError> {
    if matches!(value, LuaValue::Nil) {
        return Ok(Outcome::Allow);
    }

    let LuaValue::Table(table) = value else {
        return Err(EngineError::InvalidResult(
            "hook must return a table or nil".into(),
        ));
    };
    if let Some(reason) = table.get::<Option<String>>("deny")? {
        return Ok(Outcome::Deny { reason });
    }

    let rewrite = table.get::<LuaValue>("rewrite")?;
    if !matches!(rewrite, LuaValue::Nil) {
        return Ok(Outcome::Rewrite {
            payload: lua_to_json(rewrite, 0)?,
        });
    }

    Err(EngineError::InvalidResult(
        "hook result has no deny or rewrite".into(),
    ))
}
