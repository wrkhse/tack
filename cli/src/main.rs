//! The tack command-line entry point.

use std::error::Error;
use std::fmt;
use std::path::{Path, PathBuf};

use tack_protocol::wire::{DenyReason, PROTOCOL_VERSION};
use tack_protocol::{DEFAULT_DEADLINE_MS, DEFAULT_MEMORY_BYTES};
use tack_runtime::{EngineError, Sandbox};
use tack_wrapper::{WrapperConfig, WrapperError};

const CALL_TIMEOUT_MS: u64 = 2000;
const START_TIMEOUT_MS: u64 = 3000;
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

/// Daemon binary injected into the wrapper; never invoked by the build itself.
pub fn daemon_bin() -> Result<String, BuildError> {
    if let Ok(value) = std::env::var("TACK_DAEMON_BIN") {
        return Ok(value);
    }
    let exe = std::env::current_exe().map_err(BuildError::Io)?;
    let parent = exe.parent().ok_or_else(|| {
        BuildError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "current executable has no parent folder",
        ))
    })?;
    Ok(parent.join("tack-daemon").to_string_lossy().into_owned())
}

/// Read one plugin, check its needs, and emit the OpenCode wrapper and manifest.
pub fn build(plugin_dir: &Path, out: &Path) -> Result<(PathBuf, PathBuf), BuildError> {
    let sandbox = Sandbox::new(plugin_dir, DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS)
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
    let bin = daemon_bin()?;
    let plugin = plugin_dir.to_string_lossy();
    let config = WrapperConfig {
        manifest: &manifest,
        daemon_bin: &bin,
        plugin_dir: &plugin,
        protocol_version: PROTOCOL_VERSION,
        deny_reasons: &reasons,
        call_timeout_ms: CALL_TIMEOUT_MS,
        start_timeout_ms: START_TIMEOUT_MS,
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

enum CliError {
    Usage(String),
    Build(BuildError),
}

fn print_version() {
    println!("tack {}", env!("CARGO_PKG_VERSION"));
}

fn parse_output(rest: &[String]) -> Result<&str, CliError> {
    match rest {
        [flag, value] if flag == "--out" => Ok(value.as_str()),
        _ => Err(CliError::Usage("build needs --out <dist-dir>".into())),
    }
}

fn dispatch(args: &[String]) -> Result<(), CliError> {
    match args {
        [] => print_version(),
        [flag] if flag == "--version" => print_version(),
        [command, plugin_dir, rest @ ..] if command == "build" => {
            let out = parse_output(rest)?;
            let (index, manifest) =
                build(Path::new(plugin_dir), Path::new(out)).map_err(CliError::Build)?;
            println!("{}", index.display());
            println!("{}", manifest.display());
        }
        _ => return Err(CliError::Usage("unknown arguments".into())),
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(error) = dispatch(&args) {
        match error {
            CliError::Usage(message) => {
                eprintln!("tack: {message}");
                eprintln!("usage: tack [--version | build <plugin-dir> --out <dist-dir>]");
                std::process::exit(2);
            }
            CliError::Build(error) => {
                eprintln!("tack: {error}");
                std::process::exit(1);
            }
        }
    }
}
