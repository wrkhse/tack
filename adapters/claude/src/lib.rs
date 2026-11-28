//! Generation of the Claude Code mod: a plugin folder whose hooks module sends
//! each guarded Bash call and each tack tool run to `tack-hook` as NDJSON and
//! fails closed.

use std::error::Error;
use std::fmt;

use serde_json::{Map, Value};
use tack_protocol::wire::{PluginManifest, ToolDef};

const TEMPLATE: &str = include_str!("../register.js");

/// The mod's name in `.claude-plugin/plugin.json`; Claude Code calls its tools
/// `mcp__tack__<name>`.
pub const PLUGIN_NAME: &str = "tack";

/// Wall-clock limit on one `tack-hook` run, inside Claude Code's 10-second
/// hook limit.
pub const BUDGET_MS: u64 = 9000;

/// The manifest Claude Code reads the plugin's name and version from.
pub const PLUGIN_JSON: &str = ".claude-plugin/plugin.json";
/// The hooks file naming the module Claude Code loads.
pub const HOOKS_JSON: &str = "hooks/hooks.json";
/// The hooks module itself.
pub const REGISTER_JS: &str = "hooks/register.js";

const MAX_TOOL_NAME: usize = 64;

const TOKENS: [&str; 9] = [
    "__TACK_TOOLS__",
    "__TACK_HOOK_BIN__",
    "__TACK_PLUGIN_DIR__",
    "__TACK_DENY_REASONS__",
    "__TACK_PROTOCOL_VERSION__",
    "__TACK_BUDGET_MS__",
    "__TACK_TOOL_PREFIX__",
    "__TACK_PLUGIN_NAME__",
    "__TACK_NEEDS__",
];

#[derive(Debug)]
pub struct ModConfig<'a> {
    pub manifest: &'a PluginManifest,
    pub hook_bin: &'a str,
    pub plugin_dir: &'a str,
    pub protocol_version: u32,
    pub deny_reasons: &'a [&'a str],
    pub version: &'a str,
}

/// One file of the plugin folder, by its path under the folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModFile {
    pub path: &'static str,
    pub contents: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModError {
    MissingToken(&'static str),
    UnreplacedToken(&'static str),
    UnsafeValue(&'static str),
    ToolName(String),
    ToolSchema(String),
    Json(String),
}

impl fmt::Display for ModError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingToken(token) => write!(f, "missing_token:{token}"),
            Self::UnreplacedToken(token) => write!(f, "unreplaced_token:{token}"),
            Self::UnsafeValue(name) => write!(f, "unsafe_value:{name}"),
            Self::ToolName(name) => write!(f, "tool_name:{name}"),
            Self::ToolSchema(name) => write!(f, "tool_schema:{name}"),
            Self::Json(message) => write!(f, "json:{message}"),
        }
    }
}

impl Error for ModError {}

fn json_error(error: &serde_json::Error) -> ModError {
    ModError::Json(error.to_string())
}

fn validate(name: &'static str, value: &str) -> Result<(), ModError> {
    if value.contains("__TACK_") || value.chars().any(|c| c == '\n' || c == '\r') {
        return Err(ModError::UnsafeValue(name));
    }
    Ok(())
}

fn valid_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_TOOL_NAME
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The `$.tool.register` spec for one tool: Claude Code takes an object
/// schema, so a schema without a `type` becomes one and any other type is
/// refused. `isDeferred: false` keeps the tool in the model's list.
fn tool_spec(tool: &ToolDef) -> Result<Value, ModError> {
    if !valid_tool_name(&tool.name) {
        return Err(ModError::ToolName(tool.name.clone()));
    }

    let Value::Object(input) = &tool.input else {
        return Err(ModError::ToolSchema(tool.name.clone()));
    };
    let mut schema = input.clone();

    match schema.get("type") {
        None => {
            schema.insert("type".into(), Value::from("object"));
        }
        Some(Value::String(kind)) if kind == "object" => {}
        Some(_) => return Err(ModError::ToolSchema(tool.name.clone())),
    }

    let mut spec = Map::new();
    spec.insert("name".into(), Value::from(tool.name.as_str()));
    spec.insert("description".into(), Value::from(tool.description.as_str()));
    spec.insert("inputSchema".into(), Value::Object(schema));
    spec.insert("isDeferred".into(), Value::Bool(false));

    Ok(Value::Object(spec))
}

fn fill(values: [(&'static str, String); 9]) -> Result<String, ModError> {
    let mut output = TEMPLATE.to_owned();

    for (token, value) in values {
        if !output.contains(token) {
            return Err(ModError::MissingToken(token));
        }
        output = output.replace(token, &value);
    }

    for token in TOKENS {
        if output.contains(token) {
            return Err(ModError::UnreplacedToken(token));
        }
    }

    Ok(output)
}

fn register_js(config: &ModConfig) -> Result<String, ModError> {
    let specs = config
        .manifest
        .tools
        .iter()
        .map(tool_spec)
        .collect::<Result<Vec<_>, _>>()?;
    let tools = serde_json::to_string(&specs).map_err(|e| json_error(&e))?;
    validate("tools", &tools)?;

    let prefix = format!("mcp__{PLUGIN_NAME}__");
    let string = |value: &str| serde_json::to_string(value).map_err(|e| json_error(&e));

    fill([
        (TOKENS[0], tools),
        (TOKENS[1], string(config.hook_bin)?),
        (TOKENS[2], string(config.plugin_dir)?),
        (
            TOKENS[3],
            serde_json::to_string(config.deny_reasons).map_err(|e| json_error(&e))?,
        ),
        (TOKENS[4], config.protocol_version.to_string()),
        (TOKENS[5], BUDGET_MS.to_string()),
        (TOKENS[6], string(&prefix)?),
        (TOKENS[7], string(&config.manifest.name)?),
        (
            TOKENS[8],
            serde_json::to_string(&config.manifest.needs).map_err(|e| json_error(&e))?,
        ),
    ])
}

fn pretty(value: &Value) -> Result<String, ModError> {
    let mut text = serde_json::to_string_pretty(value).map_err(|e| json_error(&e))?;
    text.push('\n');
    Ok(text)
}

/// Render the plugin folder's three files: the plugin manifest, the hooks
/// file and the hooks module, with every template slot filled.
///
/// # Errors
///
/// Returns [`ModError::UnsafeValue`] for a value holding a token marker or a
/// newline, [`ModError::ToolName`] for a tool name Claude Code refuses,
/// [`ModError::ToolSchema`] for an input schema that is not an object
/// schema, [`ModError::Json`] when serialization fails, and
/// [`ModError::MissingToken`] or [`ModError::UnreplacedToken`] when the
/// template slots do not match.
pub fn render(config: &ModConfig) -> Result<[ModFile; 3], ModError> {
    validate("hook_bin", config.hook_bin)?;
    validate("plugin_dir", config.plugin_dir)?;
    validate("version", config.version)?;
    validate("plugin_name", &config.manifest.name)?;
    for need in &config.manifest.needs {
        validate("needs", need)?;
    }
    for reason in config.deny_reasons {
        validate("deny_reasons", reason)?;
    }

    let mut plugin = Map::new();
    plugin.insert("name".into(), Value::from(PLUGIN_NAME));
    plugin.insert("version".into(), Value::from(config.version));

    let mut hooks = Map::new();
    hooks.insert("modules".into(), Value::from(vec!["./register.js"]));

    Ok([
        ModFile {
            path: PLUGIN_JSON,
            contents: pretty(&Value::Object(plugin))?,
        },
        ModFile {
            path: HOOKS_JSON,
            contents: pretty(&Value::Object(hooks))?,
        },
        ModFile {
            path: REGISTER_JS,
            contents: register_js(config)?,
        },
    ])
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn tool(name: &str, input: Value) -> ToolDef {
        ToolDef {
            name: name.into(),
            description: "Reports daemon status".into(),
            input,
        }
    }

    #[test]
    fn errors_display_their_machine_readable_messages() {
        for (error, expected) in [
            (ModError::MissingToken("TOOLS"), "missing_token:TOOLS"),
            (ModError::UnreplacedToken("TOOLS"), "unreplaced_token:TOOLS"),
            (ModError::UnsafeValue("hook_bin"), "unsafe_value:hook_bin"),
            (ModError::ToolName("a b".into()), "tool_name:a b"),
            (ModError::ToolSchema("t".into()), "tool_schema:t"),
            (ModError::Json("bad json".into()), "json:bad json"),
        ] {
            assert_eq!(error.to_string(), expected);
        }
    }

    #[test]
    fn a_tool_spec_fills_the_object_type_and_keeps_the_schema() {
        let empty = tool_spec(&tool("guard_status", json!({}))).expect("spec");
        assert_eq!(
            empty,
            json!({
                "name": "guard_status",
                "description": "Reports daemon status",
                "inputSchema": { "type": "object" },
                "isDeferred": false
            })
        );

        let schema = json!({
            "type": "object",
            "properties": { "key": { "type": "string" } },
            "required": ["key"]
        });
        let typed = tool_spec(&tool("monitor-create", schema.clone())).expect("spec");
        assert_eq!(typed.get("inputSchema"), Some(&schema));
    }

    #[test]
    fn a_tool_spec_refuses_names_and_schemas_claude_code_refuses() {
        let long = "a".repeat(MAX_TOOL_NAME + 1);
        let edge = "a".repeat(MAX_TOOL_NAME);

        for name in ["", "two words", "dot.name", long.as_str()] {
            assert_eq!(
                tool_spec(&tool(name, json!({}))),
                Err(ModError::ToolName(name.into()))
            );
        }
        assert!(tool_spec(&tool(&edge, json!({}))).is_ok());

        for input in [json!([]), json!("x"), json!({ "type": "string" })] {
            assert_eq!(
                tool_spec(&tool("guard_status", input)),
                Err(ModError::ToolSchema("guard_status".into()))
            );
        }
    }
}
