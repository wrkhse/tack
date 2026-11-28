//! Generation of the Codex adapter: hooks that relay a guarded Bash call to
//! `tack-hook`, a stdio MCP server for `guard_status`, and the hook trust
//! Codex needs before it runs them.
//!
//! Plugin code runs only in the daemon. Every generated script runs the
//! released `tack-hook` by its plain name and fails closed.

mod home;
mod trust;

use std::error::Error;
use std::fmt;
use std::path::Path;

use serde_json::{Map, Value, json};
use tack_protocol::wire::{DenyReason, MAX_FRAME_BYTES, PROTOCOL_VERSION, PluginManifest};

pub use home::{
    CONFIG_FILE, HASHES_FILE, HOOKS_FILE, Installed, Planned, install, plan_home, resolve_home,
};
pub use trust::{Event, HOOK_TIMEOUT_SEC, Handler, fingerprint, hook_key};

const CLIENT: &str = include_str!("../client.js");
const PRE_TOOL_USE: &str = include_str!("../pre-tool-use.js");
const SESSION_START: &str = include_str!("../session-start.js");
const MCP: &str = include_str!("../mcp.js");
const RUN_HOOK: &str = include_str!("../run-hook.sh");

/// The one deadline on a `tack-hook` call, inside Codex's hook timeout.
pub const BUDGET_MS: u64 = 8000;
/// The MCP version Codex 0.172.0 offers a stdio server: its default
/// `McpProtocolMode::Legacy` initializes with `2025-06-18`.
pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
/// The MCP server's name in `[mcp_servers.<name>]`.
pub const MCP_SERVER: &str = "tack";
/// Codex's wait for the MCP server to start and for one tool call.
pub const MCP_TIMEOUT_SEC: u64 = 10;
/// The matcher of the guarded tool.
pub const BASH_MATCHER: &str = "^Bash$";
/// What Codex passes the MCP server beyond its reduced default environment:
/// the recorder, and where tack-hook finds the daemon's state and binary.
pub const MCP_ENV_VARS: [&str; 3] = ["TACK_RECORDER", "TACK_STATE_DIR", "TACK_DAEMON_BIN"];

/// The emitted files under `<out>/codex`.
pub const HOOKS_JSON: &str = "hooks.json";
pub const PRE_TOOL_USE_JS: &str = "pre-tool-use.js";
pub const SESSION_START_JS: &str = "session-start.js";
pub const MCP_JS: &str = "mcp.js";
pub const CONFIG_TOML: &str = "config.toml";
pub const RUN_HOOK_SH: &str = "run-hook.sh";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexError {
    Unsafe(&'static str),
    MissingToken(&'static str),
    UnreplacedToken,
    Home(String),
    Hooks(String),
    Config(String),
    Io(String),
}

impl fmt::Display for CodexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsafe(name) => write!(f, "unsafe_value:{name}"),
            Self::MissingToken(token) => write!(f, "missing_token:{token}"),
            Self::UnreplacedToken => f.write_str("unreplaced_token"),
            Self::Home(message) => write!(f, "codex_home:{message}"),
            Self::Hooks(message) => write!(f, "codex_hooks:{message}"),
            Self::Config(message) => write!(f, "codex_config:{message}"),
            Self::Io(message) => write!(f, "io:{message}"),
        }
    }
}

impl Error for CodexError {}

/// What a build bakes in: the canonical plugin folder, the absolute folder
/// the scripts are written to, and tack's version.
#[derive(Debug, Clone, Copy)]
pub struct Config<'a> {
    pub manifest: &'a PluginManifest,
    pub plugin_dir: &'a Path,
    pub codex_dir: &'a Path,
    pub version: &'a str,
}

/// One emitted file, by its name under the Codex output folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterFile {
    pub name: &'static str,
    pub contents: String,
}

/// The rendered adapter: its files, and the handlers to trust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adapter {
    pub files: [AdapterFile; 6],
    pub handlers: [Handler; 2],
}

/// A TOML basic string. Control characters are refused before this point.
pub(crate) fn toml_string(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// A template value: no token marker or control character may reach the
/// generated script.
fn safe_text(name: &'static str, text: &str) -> Result<(), CodexError> {
    if text.contains("__TACK_") || text.chars().any(char::is_control) {
        return Err(CodexError::Unsafe(name));
    }
    Ok(())
}

fn safe_path<'a>(name: &'static str, path: &'a Path) -> Result<&'a str, CodexError> {
    let text = path.to_str().ok_or(CodexError::Unsafe(name))?;
    safe_text(name, text)?;

    if !path.is_absolute() {
        return Err(CodexError::Unsafe(name));
    }

    Ok(text)
}

/// A POSIX shell word: Codex runs a command hook with `$SHELL -lc`.
fn shell_word(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn fill(template: &str, slots: &[(&'static str, String)]) -> Result<String, CodexError> {
    let mut output = template.to_owned();

    for (token, value) in slots {
        if !output.contains(token) {
            return Err(CodexError::MissingToken(token));
        }

        output = output.replace(token, value);
    }

    if output.contains("__TACK_") {
        return Err(CodexError::UnreplacedToken);
    }

    Ok(output)
}

fn client(plugin_dir: &str, manifest: &PluginManifest) -> Result<String, CodexError> {
    fill(
        CLIENT,
        &[
            ("__TACK_PLUGIN_DIR__", json!(plugin_dir).to_string()),
            (
                "__TACK_PLUGIN_NAME__",
                json!(manifest.name.as_str()).to_string(),
            ),
            (
                "__TACK_NEEDS__",
                json!(&manifest.needs).to_string(),
            ),
            ("__TACK_PROTOCOL_VERSION__", PROTOCOL_VERSION.to_string()),
            ("__TACK_BUDGET_MS__", BUDGET_MS.to_string()),
            ("__TACK_MAX_FRAME_BYTES__", MAX_FRAME_BYTES.to_string()),
            (
                "__TACK_DENY_REASONS__",
                json!(DenyReason::ALL.map(DenyReason::as_str)).to_string(),
            ),
        ],
    )
}

/// A script that runs on the shared client: the client, one blank line, then
/// the script's own body. Each template is formatted on its own, so neither
/// side carries the separator.
fn with_client(client: &str, body: &str) -> String {
    format!(
        "{}\n\n{}",
        client.trim_end_matches('\n'),
        body.trim_start_matches('\n')
    )
}

fn hooks_json(handlers: &[Handler; 2]) -> String {
    let mut events = Map::new();

    for handler in handlers {
        events.insert(
            handler.event.name().into(),
            Value::Array(vec![handler.group()]),
        );
    }

    let file = json!({ "hooks": events });
    let mut text = serde_json::to_string_pretty(&file).unwrap_or_else(|_| file.to_string());

    text.push('\n');
    text
}

/// The settings to add to Codex's config.toml. `required` makes a server
/// that fails to start a named failure, and `env_vars` passes the named
/// variables through Codex's reduced MCP environment when they are set.
fn config_toml(mcp_js: &str) -> String {
    let env_vars: Vec<String> = MCP_ENV_VARS.iter().map(|name| toml_string(name)).collect();

    format!(
        "# Generated by tack build. Codex settings for the tack MCP server; add them\n\
         # to Codex's config.toml before any table there.\n\
         check_for_update_on_startup = false\n\
         \n\
         [analytics]\n\
         enabled = false\n\
         \n\
         [mcp_servers.{MCP_SERVER}]\n\
         command = \"node\"\n\
         args = [{}]\n\
         env_vars = [{}]\n\
         required = true\n\
         startup_timeout_sec = {MCP_TIMEOUT_SEC}.0\n\
         tool_timeout_sec = {MCP_TIMEOUT_SEC}.0\n",
        toml_string(mcp_js),
        env_vars.join(", ")
    )
}

/// Render the adapter's files and the two handlers Codex must trust.
///
/// # Errors
///
/// Returns [`CodexError::Unsafe`] for a relative or non-UTF-8 path, one with
/// a control character or a template marker, or a version with a marker, and
/// [`CodexError::MissingToken`] or [`CodexError::UnreplacedToken`] when the
/// template slots do not match.
pub fn render(config: &Config) -> Result<Adapter, CodexError> {
    let plugin_dir = safe_path("plugin_dir", config.plugin_dir)?;
    let codex_dir = safe_path("codex_dir", config.codex_dir)?;

    safe_text("version", config.version)?;
    safe_text("plugin_name", &config.manifest.name)?;
    for need in &config.manifest.needs {
        safe_text("needs", need)?;
    }

    let script = |name: &str| format!("{codex_dir}/{name}");
    let wrapped = |name: &str| {
        format!(
            "sh {} {}",
            shell_word(&script(RUN_HOOK_SH)),
            shell_word(&script(name))
        )
    };
    let handlers = [
        Handler {
            event: Event::PreToolUse,
            matcher: Some(BASH_MATCHER),
            command: wrapped(PRE_TOOL_USE_JS),
        },
        Handler {
            event: Event::SessionStart,
            matcher: None,
            command: wrapped(SESSION_START_JS),
        },
    ];
    let client = client(plugin_dir, config.manifest)?;
    let mcp = fill(
        MCP,
        &[
            (
                "__TACK_MCP_PROTOCOL_VERSION__",
                json!(MCP_PROTOCOL_VERSION).to_string(),
            ),
            ("__TACK_VERSION__", json!(config.version).to_string()),
        ],
    )?;

    let files = [
        AdapterFile {
            name: HOOKS_JSON,
            contents: hooks_json(&handlers),
        },
        AdapterFile {
            name: PRE_TOOL_USE_JS,
            contents: with_client(&client, &fill(PRE_TOOL_USE, &[])?),
        },
        AdapterFile {
            name: SESSION_START_JS,
            contents: fill(
                SESSION_START,
                &[("__TACK_BUDGET_MS__", BUDGET_MS.to_string())],
            )?,
        },
        AdapterFile {
            name: MCP_JS,
            contents: with_client(&client, &mcp),
        },
        AdapterFile {
            name: CONFIG_TOML,
            contents: config_toml(&script(MCP_JS)),
        },
        AdapterFile {
            name: RUN_HOOK_SH,
            contents: fill(RUN_HOOK, &[])?,
        },
    ];

    Ok(Adapter { files, handlers })
}
