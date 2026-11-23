use mlua::{Lua, Table, Value as LuaValue};
use serde_json::Value;
use tack_protocol::wire::ToolDef;

use super::errors::{EngineError, LimitCause, MAX_DEPTH, MAX_ENTRIES};

pub(super) fn read_tool(table: &Table, key: &str) -> Result<ToolDef, EngineError> {
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

pub(super) fn lua_key(value: LuaValue) -> Result<String, EngineError> {
    match value {
        LuaValue::String(value) => Ok(value.to_str()?.to_string()),
        LuaValue::Integer(value) => Ok(value.to_string()),
        LuaValue::Number(value) => Ok(value.to_string()),
        _ => Err(EngineError::InvalidResult(
            "tack: tool key must be a string".into(),
        )),
    }
}

/// Translate a table position into the one-based integer keys Lua expects.
fn lua_index(index: usize) -> Result<i64, EngineError> {
    i64::try_from(index)
        .map_err(|_| EngineError::InvalidResult("tack: table index out of range".into()))
}

/// Accept a whole Lua float inside the entry ceiling as an array key.
///
/// Decimal text avoids an unchecked float-to-integer cast; the bounded parse
/// keeps the conversion exact for the small range this loader permits.
fn float_position(index: f64) -> Result<usize, EngineError> {
    if index.is_finite()
        && index.fract() == 0.0
        && let Ok(position) = index.to_string().parse::<usize>()
        && (1..=MAX_ENTRIES).contains(&position)
    {
        return Ok(position);
    }
    Err(EngineError::InvalidResult(
        "tack: unsupported table key".into(),
    ))
}

/// Accept only positive integers inside the entry ceiling as array keys.
fn array_position(index: impl TryInto<usize>) -> Result<usize, EngineError> {
    let position = index
        .try_into()
        .map_err(|_| EngineError::InvalidResult("tack: unsupported table key".into()))?;
    if (1..=MAX_ENTRIES).contains(&position) {
        Ok(position)
    } else {
        Err(EngineError::InvalidResult(
            "tack: unsupported table key".into(),
        ))
    }
}

pub(super) fn json_to_lua(lua: &Lua, value: &Value, depth: usize) -> Result<LuaValue, EngineError> {
    if depth > MAX_DEPTH {
        return Err(EngineError::Limit(LimitCause::TooDeep { limit: MAX_DEPTH }));
    }
    match value {
        Value::Null => Ok(LuaValue::Nil),
        Value::Bool(value) => Ok(LuaValue::Boolean(*value)),
        Value::Number(value) => value.as_i64().map_or_else(
            || {
                value
                    .as_f64()
                    .map(LuaValue::Number)
                    .ok_or_else(|| EngineError::InvalidResult("tack: invalid JSON number".into()))
            },
            |number| Ok(LuaValue::Integer(number)),
        ),
        Value::String(value) => Ok(LuaValue::String(lua.create_string(value.as_bytes())?)),
        Value::Array(values) => {
            if values.len() > MAX_ENTRIES {
                return Err(EngineError::Limit(LimitCause::TooManyEntries {
                    limit: MAX_ENTRIES,
                }));
            }
            let table = lua.create_table()?;
            for (index, item) in values.iter().enumerate() {
                let key = lua_index(index.saturating_add(1))?;
                let converted = json_to_lua(lua, item, depth.saturating_add(1))?;
                table.set(key, converted)?;
            }
            Ok(LuaValue::Table(table))
        }
        Value::Object(values) => {
            if values.len() > MAX_ENTRIES {
                return Err(EngineError::Limit(LimitCause::TooManyEntries {
                    limit: MAX_ENTRIES,
                }));
            }
            let table = lua.create_table()?;
            for (key, item) in values {
                let converted = json_to_lua(lua, item, depth.saturating_add(1))?;
                table.set(key.as_str(), converted)?;
            }
            Ok(LuaValue::Table(table))
        }
    }
}

fn lua_to_json(value: LuaValue, depth: usize) -> Result<Value, EngineError> {
    if depth > MAX_DEPTH {
        return Err(EngineError::Limit(LimitCause::TooDeep { limit: MAX_DEPTH }));
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
        if object.len().saturating_add(array.len()) >= MAX_ENTRIES {
            return Err(EngineError::Limit(LimitCause::TooManyEntries {
                limit: MAX_ENTRIES,
            }));
        }
        let (key, value) = pair?;
        match key {
            LuaValue::String(key) => {
                if array_mode == Some(true) {
                    return Err(EngineError::InvalidResult("tack: mixed table keys".into()));
                }
                array_mode = Some(false);
                let converted = lua_to_json(value, depth.saturating_add(1))?;
                object.insert(key.to_str()?.to_string(), converted);
            }
            LuaValue::Integer(index) => {
                let position = array_position(index)?;
                if array_mode == Some(false) {
                    return Err(EngineError::InvalidResult("tack: mixed table keys".into()));
                }
                array_mode = Some(true);
                let converted = lua_to_json(value, depth.saturating_add(1))?;
                array.push((position, converted));
            }
            LuaValue::Number(index) => {
                let position = float_position(index)?;
                if array_mode == Some(false) {
                    return Err(EngineError::InvalidResult("tack: mixed table keys".into()));
                }
                array_mode = Some(true);
                let converted = lua_to_json(value, depth.saturating_add(1))?;
                array.push((position, converted));
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
        if *index != position.saturating_add(1) {
            return Err(EngineError::InvalidResult("tack: sparse Lua array".into()));
        }
    }
    Ok(Value::Array(
        array.into_iter().map(|(_, value)| value).collect(),
    ))
}
