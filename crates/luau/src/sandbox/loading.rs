use mlua::{Function, Table, Value as LuaValue};

use super::errors::{EngineError, LoadCause};

pub(super) fn load_plugin(loader: &Function) -> Result<Table, EngineError> {
    let value: LuaValue =
        loader
            .call(("./plugin",))
            .map_err(|error| match EngineError::from(error) {
                EngineError::Script(message) => EngineError::Load(LoadCause::Message(message)),
                classified => classified,
            })?;
    match value {
        LuaValue::Table(table) => Ok(table),
        _ => Err(EngineError::Load(LoadCause::Message(
            "plugin.luau must return a table".into(),
        ))),
    }
}
