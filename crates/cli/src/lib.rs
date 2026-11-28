//! Public API for the tack build pipeline.
//!
//! The CLI assembles a sandbox, validates a plugin's needs, and renders the
//! `OpenCode` wrapper, Claude Code mod, Pi extension, or Codex adapter. No
//! daemon, agent, or child process starts here.

use std::error::Error;
use std::fmt;
use std::io::ErrorKind;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};

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

const SUPPORTED: [&str; 4] = ["sandbox", "daemon", "opencode", tack_sdk::SDK_NEED];

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
/// its needs. `sdk` is an opt-in need that emits typed Luau declarations.
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

/// Emit the SDK's typed Luau declarations only when the plugin opts in,
/// returning the path of the emitted file. When the plugin does not opt in,
/// remove any declarations left by an earlier build so a reused output
/// directory cannot keep a stale SDK file, and return `None`. The parent
/// folder is checked for symlinks, and every metadata error other than a
/// missing folder is propagated. The declarations file is unlinked and then
/// created with `create_new`, so the final operation cannot follow a symlink
/// planted at the leaf between those two steps.
fn emit_sdk(out: &Path, manifest: &PluginManifest) -> Result<Option<PathBuf>, BuildError> {
    let dest = out.join("sdk");
    let declarations = dest.join("tack.d.luau");

    match std::fs::symlink_metadata(&dest) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(BuildError::Io(std::io::Error::new(
                ErrorKind::InvalidInput,
                "symlink in SDK output path",
            )));
        }
        Ok(_) => {}
        Err(err) => match err.kind() {
            ErrorKind::NotFound => {}
            _ => return Err(BuildError::Io(err)),
        },
    }

    let remove_stale = || -> Result<(), BuildError> {
        match std::fs::remove_file(&declarations) {
            Ok(()) => {}
            Err(err) => match err.kind() {
                ErrorKind::NotFound => {}
                _ => return Err(BuildError::Io(err)),
            },
        }
        Ok(())
    };

    if !manifest.needs.iter().any(|need| need == tack_sdk::SDK_NEED) {
        remove_stale()?;
        // A folder holding other files is left alone.
        let _ = std::fs::remove_dir(&dest);
        return Ok(None);
    }

    std::fs::create_dir_all(&dest).map_err(BuildError::Io)?;
    remove_stale()?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&declarations)
        .map_err(BuildError::Io)?;
    file.write_all(tack_sdk::TACK_D_LUAU.as_bytes())
        .map_err(BuildError::Io)?;

    Ok(Some(declarations))
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
    let _ = emit_sdk(out, &manifest)?;

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

    if let Some(path) = emit_sdk(out, &manifest)? {
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
    let (plugin_dir, manifest) = load(plugin_dir)?;
    let script = tack_adapter_pi::render(&plugin_dir).map_err(BuildError::RenderExtension)?;

    let dest = out.join("pi");
    std::fs::create_dir_all(&dest).map_err(BuildError::Io)?;
    let extension = dest.join(EXTENSION_JS);
    std::fs::write(&extension, script).map_err(BuildError::Io)?;
    let _ = emit_sdk(out, &manifest)?;

    Ok(extension)
}

/// Where `path` will resolve once its folders exist, without creating
/// anything: its deepest existing ancestor, canonicalized, then the rest of
/// its components as written. A component that does not exist yet cannot be a
/// symlink, so `..` drops the last of them; one that would climb above the
/// existing ancestor is refused.
fn planned_dir(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    let mut existing = absolute.as_path();
    let mut missing = Vec::new();

    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        let (Some(parent), Some(last)) = (existing.parent(), existing.components().next_back())
        else {
            return Err(std::io::Error::new(
                ErrorKind::NotFound,
                "no existing ancestor",
            ));
        };

        missing.push(last);
        existing = parent;
    }

    let mut planned = std::fs::canonicalize(existing)?;
    let mut added = 0_usize;

    for component in missing.into_iter().rev() {
        match component {
            Component::Normal(name) => {
                planned.push(name);
                added = added.saturating_add(1);
            }
            Component::ParentDir => {
                added = added.checked_sub(1).ok_or_else(|| {
                    std::io::Error::new(
                        ErrorKind::InvalidInput,
                        "the output path climbs above an existing folder",
                    )
                })?;
                planned.pop();
            }
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => {
                return Err(std::io::Error::new(
                    ErrorKind::InvalidInput,
                    "the output path is not a plain folder path",
                ));
            }
        }
    }

    Ok(planned)
}

/// Read one plugin, check its needs, emit the Codex adapter into
/// `<out>/codex`, and install its hooks and their trust into `codex_home`.
///
/// The emitted files are `hooks.json`, `pre-tool-use.js`,
/// `session-start.js`, `mcp.js`, the `config.toml` fragment that
/// registers the MCP server, and `run-hook.sh`, which each hook command runs
/// its script through. Into the Codex home go tack's groups in
/// `hooks.json` and `[hooks.state.<key>]` in `config.toml` for exactly
/// tack's handlers, rewritten on every build, and `tack-hashes`, tack's record
/// of the hashes its hooks were trusted under. Every other hook stays as it
/// is, and so does the state of every hook that still exists. Two kinds of
/// state table are dropped: one holding a hash tack recorded as its own, and,
/// on the first build after an upgrade, before any `tack-hashes` exists, one
/// whose key names no hook. The home is merged and checked before anything is
/// created, so a home tack cannot merge into leaves no output behind; the
/// scripts are written before the home trusts them.
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
    let (plugin_dir, manifest) = load(plugin_dir)?;
    let dest = planned_dir(&out.join("codex")).map_err(BuildError::Io)?;

    let adapter = tack_adapter_codex::render(&tack_adapter_codex::Config {
        plugin_dir: &plugin_dir,
        codex_dir: &dest,
        version: env!("CARGO_PKG_VERSION"),
    })
    .map_err(BuildError::Codex)?;
    let planned =
        tack_adapter_codex::plan_home(codex_home, &adapter.handlers).map_err(BuildError::Codex)?;

    std::fs::create_dir_all(&dest).map_err(BuildError::Io)?;

    // The scripts embed `dest`, so it must be where they now live.
    if std::fs::canonicalize(&dest).map_err(BuildError::Io)? != dest {
        return Err(BuildError::Io(std::io::Error::other(
            "the output folder changed while building",
        )));
    }

    let mut written = Vec::with_capacity(adapter.files.len().saturating_add(3));

    for file in adapter.files {
        let path = dest.join(file.name);
        std::fs::write(&path, file.contents).map_err(BuildError::Io)?;
        written.push(path);
    }

    let installed = planned.commit().map_err(BuildError::Codex)?;

    written.push(installed.hooks);
    written.push(installed.config);
    written.push(installed.hashes);
    if let Some(path) = emit_sdk(out, &manifest)? {
        written.push(path);
    }

    Ok(written)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use tack_luau::LimitCause;

    use super::*;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    /// A temporary folder removed when the test ends.
    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock is after the epoch")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "tack-cli-lib-{}-{}-{}",
                std::process::id(),
                unique,
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&root).expect("scratch folder");
            Self { root }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

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

    #[test]
    fn planned_dir_puts_a_missing_tail_under_the_canonical_ancestor() {
        let scratch = Scratch::new();
        let canonical = std::fs::canonicalize(&scratch.root).expect("canonical");

        let planned = planned_dir(&scratch.root.join("dist").join("codex")).expect("planned");

        assert_eq!(planned, canonical.join("dist").join("codex"));
        assert!(!scratch.root.join("dist").exists());
    }

    #[test]
    fn planned_dir_collapses_a_missing_parent_step_without_creating_folders() {
        let scratch = Scratch::new();
        let canonical = std::fs::canonicalize(&scratch.root).expect("canonical");

        let planned = planned_dir(&scratch.root.join("a/../b")).expect("planned");

        assert_eq!(planned, canonical.join("b"));
        assert!(!scratch.root.join("a").exists());
        assert!(!scratch.root.join("b").exists());
    }

    #[test]
    fn planned_dir_refuses_a_parent_step_above_the_existing_ancestor() {
        let scratch = Scratch::new();

        let error = planned_dir(&scratch.root.join("missing/../../x")).expect_err("refused");

        assert_eq!(error.kind(), ErrorKind::InvalidInput);
        assert_eq!(
            error.to_string(),
            "the output path climbs above an existing folder"
        );
        assert!(!scratch.root.join("missing").exists());
    }

    #[test]
    fn planned_dir_reports_a_file_in_the_way_rather_than_treating_it_as_missing() {
        let scratch = Scratch::new();
        let file = scratch.root.join("file");
        std::fs::write(&file, "x").expect("file");

        let error = planned_dir(&file.join("child/codex")).expect_err("refused");

        assert_eq!(error.kind(), ErrorKind::NotADirectory);
        assert_eq!(std::fs::read(&file).expect("still a file"), b"x");
        assert!(file.is_file());
    }
}
