//! Public API for the tack build pipeline.
//!
//! The CLI assembles a sandbox, validates a plugin's needs, and renders the
//! `OpenCode` wrapper, Claude Code mod, Pi extension, or Codex adapter. No
//! daemon, agent, or child process starts here.

use std::error::Error;
use std::fmt;
use std::path::{Path, PathBuf};

use tack_adapter_claude::{ModConfig, ModError};
use tack_adapter_codex::CodexError;
use tack_adapter_opencode::{WrapperConfig, WrapperError};
use tack_adapter_pi::{EXTENSION_JS, ExtensionError};
use tack_luau::{Capabilities, EngineError, Limits, Sandbox};
use tack_protocol::wire::{DenyReason, PROTOCOL_VERSION, PluginManifest};
use tack_protocol::{DEFAULT_DEADLINE_MS, DEFAULT_MEMORY_BYTES};

/// Wall-clock budget for one wrapper call in the default build.
pub const CALL_TIMEOUT_MS: u64 = 2000;
/// Wall-clock budget for the first daemon start in the default build.
pub const START_TIMEOUT_MS: u64 = 3000;
/// Daemon binary baked into the wrapper and resolved from the
/// `TACK_DAEMON_BIN` environment variable or PATH at run time, so the emitted
/// script is host-independent.
pub const DAEMON_BIN: &str = "tack-daemon";
/// Hook client the Claude Code mod runs by its plain name, so the host's PATH
/// resolves it.
pub const HOOK_BIN: &str = "tack-hook";

const SUPPORTED: [&str; 3] = ["sandbox", "daemon", "opencode"];

#[derive(Debug)]
pub enum BuildError {
    NeedMissing(String),
    Sandbox(EngineError),
    Manifest(serde_json::Error),
    Render(WrapperError),
    RenderMod(ModError),
    RenderExtension(ExtensionError),
    Codex(CodexError),
    Io(std::io::Error),
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NeedMissing(name) => write!(f, "need_missing:{name}"),
            Self::Sandbox(error) => write!(f, "sandbox:tack: {error}"),
            Self::Manifest(error) => write!(f, "manifest:{error}"),
            Self::Render(error) => write!(f, "render:{error}"),
            Self::RenderMod(error) => write!(f, "render:{error}"),
            Self::RenderExtension(error) => write!(f, "render:{error}"),
            Self::Codex(error) => write!(f, "codex:{error}"),
            Self::Io(error) => write!(f, "io:{error}"),
        }
    }
}

impl Error for BuildError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::NeedMissing(_) => None,
            Self::Sandbox(error) => Some(error),
            Self::Manifest(error) => Some(error),
            Self::Render(error) => Some(error),
            Self::RenderMod(error) => Some(error),
            Self::RenderExtension(error) => Some(error),
            Self::Codex(error) => Some(error),
            Self::Io(error) => Some(error),
        }
    }
}

/// Timeouts baked into the generated wrapper. Tests shorten them so a call
/// denies within milliseconds instead of waiting on production budgets.
#[derive(Debug, Clone, Copy)]
pub struct BuildOptions {
    pub call_timeout_ms: u64,
    pub start_timeout_ms: u64,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self {
            call_timeout_ms: CALL_TIMEOUT_MS,
            start_timeout_ms: START_TIMEOUT_MS,
        }
    }
}

/// Canonicalize a plugin folder, read its manifest in the sandbox, and check
/// its needs.
fn load(plugin_dir: &Path) -> Result<(PathBuf, PluginManifest), BuildError> {
    let plugin_dir = std::fs::canonicalize(plugin_dir).map_err(BuildError::Io)?;
    let metadata = Limits::new(DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS)
        .and_then(|limits| Sandbox::new(&plugin_dir, limits, Capabilities::default()))
        .and_then(|sandbox| sandbox.manifest())
        .map_err(BuildError::Sandbox)?;
    let manifest: PluginManifest =
        serde_json::from_value(metadata).map_err(BuildError::Manifest)?;

    for need in &manifest.needs {
        if !SUPPORTED.contains(&need.as_str()) {
            return Err(BuildError::NeedMissing(need.clone()));
        }
    }

    Ok((plugin_dir, manifest))
}

fn deny_reasons() -> Vec<&'static str> {
    DenyReason::ALL
        .iter()
        .map(|reason| reason.as_str())
        .collect()
}

/// Read one plugin, check its needs, and emit the `OpenCode` wrapper and manifest.
///
/// The plugin folder is canonicalized so the emitted wrapper carries its
/// absolute path. That is the only host-specific value in the output: the
/// daemon stays a plain name, resolved by the wrapper at run time.
///
/// # Errors
///
/// Returns [`BuildError::Io`] when the plugin folder or output files cannot be
/// read or written, [`BuildError::Sandbox`] when the host limits are invalid or
/// the plugin cannot be loaded or read, [`BuildError::Manifest`] when the
/// manifest does not match the wire contract, [`BuildError::NeedMissing`] for
/// an unsupported need, and [`BuildError::Render`] when the wrapper cannot be
/// rendered.
pub fn build(
    plugin_dir: &Path,
    out: &Path,
    options: BuildOptions,
) -> Result<(PathBuf, PathBuf), BuildError> {
    let (plugin_dir, manifest) = load(plugin_dir)?;
    let reasons = deny_reasons();
    let plugin = plugin_dir.to_string_lossy();
    let config = WrapperConfig {
        manifest: &manifest,
        daemon_bin: DAEMON_BIN,
        plugin_dir: plugin.as_ref(),
        protocol_version: PROTOCOL_VERSION,
        deny_reasons: &reasons,
        call_timeout_ms: options.call_timeout_ms,
        start_timeout_ms: options.start_timeout_ms,
    };
    let script = tack_adapter_opencode::render(&config).map_err(BuildError::Render)?;

    let dest = out.join("opencode");
    std::fs::create_dir_all(&dest).map_err(BuildError::Io)?;
    let index = dest.join("index.js");
    let descriptor = dest.join("manifest.json");
    std::fs::write(&index, script).map_err(BuildError::Io)?;

    let pretty = serde_json::to_string_pretty(&manifest).map_err(|error| {
        BuildError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    })?;
    std::fs::write(&descriptor, pretty).map_err(BuildError::Io)?;

    Ok((index, descriptor))
}

/// Read one plugin, check its needs, and emit the Claude Code mod into
/// `<out>/claude`: `.claude-plugin/plugin.json`, `hooks/hooks.json` and
/// `hooks/register.js`.
///
/// The mod runs [`HOOK_BIN`] by its plain name with `--plugin` and the
/// canonical plugin folder, the only host-specific value in the output.
///
/// # Errors
///
/// Returns [`BuildError::Io`] when the plugin folder or output files cannot be
/// read or written, [`BuildError::Sandbox`] when the plugin cannot be loaded
/// or read, [`BuildError::Manifest`] when the manifest does not match the
/// wire contract, [`BuildError::NeedMissing`] for an unsupported need, and
/// [`BuildError::RenderMod`] when the mod cannot be rendered.
pub fn build_claude(plugin_dir: &Path, out: &Path) -> Result<Vec<PathBuf>, BuildError> {
    let (plugin_dir, manifest) = load(plugin_dir)?;
    let reasons = deny_reasons();
    let plugin = plugin_dir.to_string_lossy();
    let config = ModConfig {
        manifest: &manifest,
        hook_bin: HOOK_BIN,
        plugin_dir: plugin.as_ref(),
        protocol_version: PROTOCOL_VERSION,
        deny_reasons: &reasons,
        version: env!("CARGO_PKG_VERSION"),
    };
    let files = tack_adapter_claude::render(&config).map_err(BuildError::RenderMod)?;

    let dest = out.join("claude");
    let mut written = Vec::with_capacity(files.len());

    for file in files {
        let path = dest.join(file.path);

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(BuildError::Io)?;
        }

        std::fs::write(&path, file.contents).map_err(BuildError::Io)?;
        written.push(path);
    }

    Ok(written)
}

/// Read one plugin, check its needs, and emit `<out>/pi/extension.js`.
///
/// # Errors
/// Returns [`BuildError::Io`] when the plugin folder or output file cannot be
/// read or written, [`BuildError::Sandbox`] when the plugin cannot be loaded
/// or read, [`BuildError::Manifest`] when the manifest does not match the wire
/// contract, [`BuildError::NeedMissing`] for an unsupported need, and
/// [`BuildError::RenderExtension`] when the extension cannot be rendered.
pub fn build_pi(plugin_dir: &Path, out: &Path) -> Result<PathBuf, BuildError> {
    let (plugin_dir, _) = load(plugin_dir)?;
    let script = tack_adapter_pi::render(&plugin_dir).map_err(BuildError::RenderExtension)?;

    let dest = out.join("pi");
    std::fs::create_dir_all(&dest).map_err(BuildError::Io)?;
    let extension = dest.join(EXTENSION_JS);
    std::fs::write(&extension, script).map_err(BuildError::Io)?;

    Ok(extension)
}

/// Read one plugin, check its needs, emit the Codex adapter into
/// `<out>/codex`, and install its hooks and their trust into `codex_home`.
///
/// The emitted files are `hooks.json`, `pre-tool-use.js`,
/// `session-start.js`, `mcp.js`, the `config.toml` fragment that
/// registers the MCP server, and `run-hook.sh`, which each hook command runs
/// its script through. Into the Codex home go tack's groups in
/// `hooks.json` and `[hooks.state.<key>]` in `config.toml` for exactly
/// tack's handlers, rewritten on every build; every other hook and its state
/// stays as it is. The scripts are written before the home trusts them, and
/// both home files are checked before either is written.
///
/// # Errors
///
/// Returns [`BuildError::Io`] when the plugin folder or output files cannot be
/// read or written, [`BuildError::Sandbox`] when the plugin cannot be loaded
/// or read, [`BuildError::Manifest`] when the manifest does not match the wire
/// contract, [`BuildError::NeedMissing`] for an unsupported need, and
/// [`BuildError::Codex`] when the adapter cannot be rendered or the Codex home
/// cannot be merged.
pub fn build_codex(
    plugin_dir: &Path,
    out: &Path,
    codex_home: &Path,
) -> Result<Vec<PathBuf>, BuildError> {
    let (plugin_dir, _) = load(plugin_dir)?;
    let dest = out.join("codex");
    std::fs::create_dir_all(&dest).map_err(BuildError::Io)?;
    let dest = std::fs::canonicalize(&dest).map_err(BuildError::Io)?;

    let adapter = tack_adapter_codex::render(&tack_adapter_codex::Config {
        plugin_dir: &plugin_dir,
        codex_dir: &dest,
        version: env!("CARGO_PKG_VERSION"),
    })
    .map_err(BuildError::Codex)?;
    let mut written = Vec::with_capacity(adapter.files.len().saturating_add(2));

    for file in adapter.files {
        let path = dest.join(file.name);
        std::fs::write(&path, file.contents).map_err(BuildError::Io)?;
        written.push(path);
    }

    let installed =
        tack_adapter_codex::install(codex_home, &adapter.handlers).map_err(BuildError::Codex)?;

    written.push(installed.hooks);
    written.push(installed.config);

    Ok(written)
}

#[cfg(test)]
mod tests {
    use tack_luau::LimitCause;

    use super::*;

    #[test]
    fn build_error_reports_the_underlying_source() {
        let sandbox = EngineError::Limit(LimitCause::Deadline);
        let build_error = BuildError::Sandbox(sandbox.clone());

        assert_eq!(
            build_error.to_string(),
            "sandbox:tack: script deadline exceeded"
        );
        assert_eq!(
            build_error.source().map(ToString::to_string),
            Some(sandbox.to_string())
        );

        let render = WrapperError::Json("bad json".into());
        assert_eq!(
            BuildError::Render(render.clone())
                .source()
                .map(ToString::to_string),
            Some(render.to_string())
        );

        let io = std::io::Error::other("disk");
        assert_eq!(
            BuildError::Io(std::io::Error::other("disk"))
                .source()
                .map(ToString::to_string),
            Some(io.to_string())
        );

        assert!(BuildError::NeedMissing("daemon".into()).source().is_none());
    }

    #[test]
    fn a_mod_render_error_names_its_class_and_source() {
        let render = ModError::ToolName("guard status".into());
        let build_error = BuildError::RenderMod(render.clone());

        assert_eq!(build_error.to_string(), "render:tool_name:guard status");
        assert_eq!(
            build_error.source().map(ToString::to_string),
            Some(render.to_string())
        );
    }
}
