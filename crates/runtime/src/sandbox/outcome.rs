use mlua::{Table, Value as LuaValue};
use serde_json::Value;
use tack_protocol::wire::{Content, Outcome};

use super::errors::{EngineError, LimitCause, MAX_ENTRIES};

pub(super) fn decode_outcome(value: LuaValue, input: &Value) -> Result<Outcome, EngineError> {
    if matches!(value, LuaValue::Nil) {
        return Ok(Outcome::Allow);
    }

    let LuaValue::Table(table) = value else {
        return Err(EngineError::InvalidResult(
            "tack: hook must return a table or nil".into(),
        ));
    };
    if let Some(reason) = table.get::<Option<String>>("deny")? {
        return Ok(Outcome::Deny { reason });
    }
    if let Some(rewrite) = table.get::<Option<Table>>("rewrite")? {
        let command = rewrite
            .get::<Option<String>>("command")?
            .ok_or_else(|| EngineError::InvalidResult("tack: rewrite needs a command".into()))?;
        return Ok(Outcome::Rewrite {
            input: merge_command(input, command),
        });
    }
    Err(EngineError::InvalidResult(
        "tack: hook result has no deny or rewrite".into(),
    ))
}

/// Replace only the command field, leaving the rest of the tool call intact.
fn merge_command(input: &Value, command: String) -> Value {
    let mut input = input.clone();
    match input.as_object_mut() {
        Some(object) => {
            object.insert("command".to_owned(), Value::String(command));
            input
        }
        None => serde_json::json!({ "command": command }),
    }
}

pub(super) fn decode_content(value: LuaValue) -> Result<Vec<Content>, EngineError> {
    let LuaValue::Table(table) = value else {
        return Err(EngineError::InvalidResult(
            "tack: tool must return a table".into(),
        ));
    };
    let content = table
        .get::<Option<Table>>("content")?
        .ok_or_else(|| EngineError::InvalidResult("tack: tool result needs content".into()))?;
    let mut decoded = Vec::new();
    for pair in content.pairs::<LuaValue, LuaValue>() {
        if decoded.len() >= MAX_ENTRIES {
            return Err(EngineError::Limit(LimitCause::TooManyEntries {
                limit: MAX_ENTRIES,
            }));
        }
        let (_, item) = pair?;
        let LuaValue::Table(item) = item else {
            return Err(EngineError::InvalidResult(
                "tack: content item must be a table".into(),
            ));
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
