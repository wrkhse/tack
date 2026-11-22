//! Public API for the tack build pipeline.
//!
//! The CLI assembles a sandbox, validates a plugin's needs, and renders the
//! OpenCode wrapper. No daemon, OpenCode process, or child process starts here.

use std::error::Error;
use std::fmt;
use std::path::{Path, PathBuf};

use tack_protocol::wire::{DenyReason, PROTOCOL_VERSION};
use tack_protocol::{DEFAULT_DEADLINE_MS, DEFAULT_MEMORY_BYTES};
use tack_runtime::{EngineError, Sandbox};
use tack_wrapper::{WrapperConfig, WrapperError};

/// Wall-clock budget for one wrapper call in the default build.
pub const CALL_TIMEOUT_MS: u64 = 2000;
/// Wall-clock budget for the first daemon start in the default build.
pub const START_TIMEOUT_MS: u64 = 3000;
/// Daemon binary baked into the wrapper and resolved from the
/// TACK_DAEMON_BIN environment variable or PATH at run time, so the emitted
/// script is host-independent.
pub const DAEMON_BIN: &str = "tack-daemon";

const SUPPORTED: [&str; 3] = ["sandbox", "daemon", "opencode"];

#[derive(Debug)]
pub enum BuildError {
    NeedMissing(String),
    Sandbox(EngineError),
    Render(WrapperError),
    Io(std::io::Error),
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BuildError::NeedMissing(name) => write!(f, "need_missing:{name}"),
            BuildError::Sandbox(error) => write!(f, "sandbox:{error}"),
            BuildError::Render(error) => write!(f, "render:{error}"),
            BuildError::Io(error) => write!(f, "io:{error}"),
        }
    }
}

impl Error for BuildError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            BuildError::NeedMissing(_) => None,
            BuildError::Sandbox(error) => Some(error),
            BuildError::Render(error) => Some(error),
            BuildError::Io(error) => Some(error),
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

/// Read one plugin, check its needs, and emit the OpenCode wrapper and manifest.
///
/// The plugin folder is canonicalized so the emitted wrapper carries its
/// absolute path. That is the only host-specific value in the output: the
/// daemon stays a plain name, resolved by the wrapper at run time.
pub fn build(
    plugin_dir: &Path,
    out: &Path,
    options: BuildOptions,
) -> Result<(PathBuf, PathBuf), BuildError> {
    let plugin_dir = std::fs::canonicalize(plugin_dir).map_err(BuildError::Io)?;
    let sandbox = Sandbox::new(&plugin_dir, DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS)
        .map_err(BuildError::Sandbox)?;
    let manifest = sandbox.manifest().map_err(BuildError::Sandbox)?;

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
    let script = tack_wrapper::render(&config).map_err(BuildError::Render)?;

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
