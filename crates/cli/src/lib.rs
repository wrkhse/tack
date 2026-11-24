//! Public API for the tack build pipeline.
//!
//! The CLI assembles a sandbox, validates a plugin's needs, and renders the
//! `OpenCode` wrapper. No daemon, `OpenCode` process, or child process starts here.

use std::error::Error;
use std::fmt;
use std::path::{Path, PathBuf};

use tack_adapter_opencode::{WrapperConfig, WrapperError};
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

const SUPPORTED: [&str; 3] = ["sandbox", "daemon", "opencode"];

#[derive(Debug)]
pub enum BuildError {
    NeedMissing(String),
    Sandbox(EngineError),
    Manifest(serde_json::Error),
    Render(WrapperError),
    Io(std::io::Error),
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NeedMissing(name) => write!(f, "need_missing:{name}"),
            Self::Sandbox(error) => write!(f, "sandbox:tack: {error}"),
            Self::Manifest(error) => write!(f, "manifest:{error}"),
            Self::Render(error) => write!(f, "render:{error}"),
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

    let reasons: Vec<&str> = DenyReason::ALL
        .iter()
        .map(|reason| reason.as_str())
        .collect();
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
}
