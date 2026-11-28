//! Public API for the tack build pipeline.
//!
//! The CLI assembles a sandbox, validates a plugin's needs, and renders the
//! `OpenCode` wrapper, Claude Code mod, Pi extension, or Codex adapter. No
//! daemon, agent, or child process starts here.

use std::error::Error;
use std::fmt;
use std::io::ErrorKind;
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

const SUPPORTED: [&str; 3] = ["sandbox", "daemon", "opencode"];

/// The opt-in module whose typed declarations `build_sdk` emits.
const SDK_MODULE: &str = "sdk";
/// Modules a plugin may list in its `modules` table. Any other name is refused.
const MODULES: [&str; 1] = [SDK_MODULE];
/// Longest plugin name that becomes a declaration file name.
const MAX_NAME_BYTES: usize = 64;

#[derive(Debug)]
pub enum BuildError {
    NeedMissing(String),
    ModuleMissing(String),
    PluginName(String),
    DeclarationPath(String),
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
            Self::ModuleMissing(name) => write!(f, "module_missing:{name}"),
            Self::PluginName(name) => write!(f, "plugin_name:{name}"),
            Self::DeclarationPath(path) => write!(f, "declaration_path:{path}"),
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
            Self::NeedMissing(_)
            | Self::ModuleMissing(_)
            | Self::PluginName(_)
            | Self::DeclarationPath(_) => None,
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

/// A plugin read once: its canonical folder, its manifest and the modules it lists.
struct Loaded {
    dir: PathBuf,
    manifest: PluginManifest,
    modules: Vec<String>,
}

/// Canonicalize a plugin folder, read its manifest in the sandbox, and check its
/// needs and modules. The modules sit beside the manifest because the wire
/// contract does not carry them.
fn load(plugin_dir: &Path) -> Result<Loaded, BuildError> {
    let plugin_dir = std::fs::canonicalize(plugin_dir).map_err(BuildError::Io)?;
    let metadata = Limits::new(DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS)
        .and_then(|limits| Sandbox::new(&plugin_dir, limits, Capabilities::default()))
        .and_then(|sandbox| sandbox.manifest())
        .map_err(BuildError::Sandbox)?;
    let modules = declared_modules(&metadata)?;
    let manifest: PluginManifest =
        serde_json::from_value(metadata).map_err(BuildError::Manifest)?;

    for need in &manifest.needs {
        if !SUPPORTED.contains(&need.as_str()) {
            return Err(BuildError::NeedMissing(need.clone()));
        }
    }

    for module in &modules {
        if !MODULES.contains(&module.as_str()) {
            return Err(BuildError::ModuleMissing(module.clone()));
        }
    }

    Ok(Loaded {
        dir: plugin_dir,
        manifest,
        modules,
    })
}

/// The module names a plugin lists, read from the `modules` array that the
/// sandbox puts in the manifest JSON.
fn declared_modules(metadata: &serde_json::Value) -> Result<Vec<String>, BuildError> {
    let listed = metadata.get("modules").cloned().unwrap_or_default();
    serde_json::from_value(listed).map_err(BuildError::Manifest)
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
    opencode(&load(plugin_dir)?, out, options)
}

/// Emit the `OpenCode` wrapper and manifest for a plugin that is already read.
fn opencode(
    loaded: &Loaded,
    out: &Path,
    options: BuildOptions,
) -> Result<(PathBuf, PathBuf), BuildError> {
    let reasons = deny_reasons();
    let plugin = loaded.dir.to_string_lossy();
    let config = WrapperConfig {
        manifest: &loaded.manifest,
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

    let pretty = serde_json::to_string_pretty(&loaded.manifest).map_err(|error| {
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
    claude(&load(plugin_dir)?, out)
}

/// Emit the Claude Code mod for a plugin that is already read.
fn claude(loaded: &Loaded, out: &Path) -> Result<Vec<PathBuf>, BuildError> {
    let reasons = deny_reasons();
    let plugin = loaded.dir.to_string_lossy();
    let config = ModConfig {
        manifest: &loaded.manifest,
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
    pi(&load(plugin_dir)?, out)
}

/// Emit the Pi extension for a plugin that is already read.
fn pi(loaded: &Loaded, out: &Path) -> Result<PathBuf, BuildError> {
    let script = tack_adapter_pi::render(&loaded.dir).map_err(BuildError::RenderExtension)?;

    let dest = out.join("pi");
    std::fs::create_dir_all(&dest).map_err(BuildError::Io)?;
    let extension = dest.join(EXTENSION_JS);
    std::fs::write(&extension, script).map_err(BuildError::Io)?;

    Ok(extension)
}

/// The agent a build emits for, with what its target needs.
pub enum Output {
    /// The `OpenCode` wrapper and manifest, with their timeouts.
    OpenCode(BuildOptions),
    /// The Claude Code mod.
    Claude,
    /// The Pi extension.
    Pi,
    /// The Codex adapter, installed into this Codex home.
    Codex(PathBuf),
}

/// Read one plugin once, emit its target, then sync its SDK declarations.
///
/// The SDK step is planned before the target writes, so a refused module, name
/// or path writes nothing. It is applied only once the target has succeeded.
///
/// Path refusal is a one-shot check at plan time, assuming `out` is a build-owned
/// folder that no other process modifies concurrently; it needs no added
/// dependency or unsafe FFI. Concurrent replacement of an entry is out of scope
/// (see [`build_sdk`]): a path swapped in after planning may be a symlink the
/// check never saw and can be followed, so no guarantee against that is made.
///
/// # Errors
///
/// Returns the errors of the target build, and [`BuildError::DeclarationPath`]
/// or [`BuildError::PluginName`] when the SDK step cannot use its path or name.
pub fn build_plugin(
    plugin_dir: &Path,
    out: &Path,
    output: &Output,
) -> Result<Vec<PathBuf>, BuildError> {
    let loaded = load(plugin_dir)?;
    let sdk = plan_sdk(&loaded, out)?;
    let mut written = match output {
        Output::OpenCode(options) => {
            let (index, manifest) = opencode(&loaded, out, *options)?;
            vec![index, manifest]
        }
        Output::Claude => claude(&loaded, out)?,
        Output::Pi => vec![pi(&loaded, out)?],
        Output::Codex(codex_home) => codex(&loaded, out, codex_home)?,
    };
    written.extend(apply_sdk(sdk)?);

    Ok(written)
}

/// Sync one plugin's SDK declarations under `<out>/sdk/`.
///
/// A plugin that lists the `sdk` module gets `<name>.d.luau`. A plugin that does
/// not list it loses the declaration an earlier build wrote, and the folder once
/// that leaves it empty.
///
/// Path refusal is a one-shot check at plan time: the folder and file are
/// inspected as they stand, without following symlinks. That needs no added
/// dependency or unsafe FFI, but assumes `out` is build-owned and not modified
/// concurrently. Concurrent replacement is out of scope: an entry swapped in
/// after planning can be a symlink the check never saw and may be followed, so
/// no guarantee against that case is made.
///
/// # Errors
///
/// Returns [`BuildError::Io`] when the output folder or file cannot be read or
/// written, [`BuildError::Sandbox`] when the plugin cannot be loaded or read,
/// [`BuildError::Manifest`] when the manifest does not match the wire contract,
/// [`BuildError::NeedMissing`] for an unsupported need, [`BuildError::ModuleMissing`]
/// for an unknown module, [`BuildError::PluginName`] when the name of a plugin
/// that lists the module is not a plain file name, and
/// [`BuildError::DeclarationPath`] when the folder or file a declaration goes to
/// is a symlink or any other entry.
pub fn build_sdk(plugin_dir: &Path, out: &Path) -> Result<Option<PathBuf>, BuildError> {
    let loaded = load(plugin_dir)?;
    apply_sdk(plan_sdk(&loaded, out)?)
}

/// What the SDK step writes or removes. It is decided before any target writes.
enum SdkStep {
    /// Nothing to write and nothing to remove.
    Nothing,
    /// Write the declaration at `path`, creating `folder` when it is missing.
    Write { folder: PathBuf, path: PathBuf },
    /// Remove the declaration at `path`, and `folder` once it is empty.
    Clear { folder: PathBuf, path: PathBuf },
}

/// Decide the SDK step from a plugin that is already read. It only reads `out`,
/// so every refusal comes before any target writes.
fn plan_sdk(loaded: &Loaded, out: &Path) -> Result<SdkStep, BuildError> {
    let folder = out.join("sdk");

    if loaded.modules.iter().any(|module| module == SDK_MODULE) {
        let stem = declaration_stem(&loaded.manifest.name)?;
        let path = folder.join(format!("{stem}.d.luau"));

        match entry_at(&folder)? {
            Some(metadata) if !metadata.is_dir() => {
                return Err(BuildError::DeclarationPath(folder.display().to_string()));
            }
            Some(_) => refuse_other_entry(&path)?,
            None => {}
        }

        return Ok(SdkStep::Write { folder, path });
    }

    let Ok(stem) = declaration_stem(&loaded.manifest.name) else {
        return Ok(SdkStep::Nothing);
    };
    let path = folder.join(format!("{stem}.d.luau"));

    match entry_at(&folder)? {
        Some(metadata) if metadata.is_dir() => {
            refuse_other_entry(&path)?;
            Ok(SdkStep::Clear { folder, path })
        }
        Some(_) => Err(BuildError::DeclarationPath(folder.display().to_string())),
        None => Ok(SdkStep::Nothing),
    }
}

/// Carry out a planned SDK step. Writing creates the folder when it is missing.
/// Clearing removes the declaration when it is a regular file, then the folder
/// once it is empty.
fn apply_sdk(step: SdkStep) -> Result<Option<PathBuf>, BuildError> {
    match step {
        SdkStep::Nothing => Ok(None),
        SdkStep::Write { folder, path } => {
            std::fs::create_dir_all(&folder).map_err(BuildError::Io)?;
            std::fs::write(&path, declarations()).map_err(BuildError::Io)?;
            Ok(Some(path))
        }
        SdkStep::Clear { folder, path } => {
            if entry_at(&path)?.is_some_and(|metadata| metadata.is_file()) {
                std::fs::remove_file(&path).map_err(BuildError::Io)?;
            }
            if std::fs::read_dir(&folder)
                .map_err(BuildError::Io)?
                .next()
                .is_none()
            {
                std::fs::remove_dir(&folder).map_err(BuildError::Io)?;
            }
            Ok(None)
        }
    }
}

/// The entry at `path` as it is, without following a symlink, or `None` when it
/// is missing.
fn entry_at(path: &Path) -> Result<Option<std::fs::Metadata>, BuildError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(BuildError::Io(error)),
    }
}

/// Refuse a declaration path that holds anything but a regular file. A regular
/// file is an earlier build's output, so it is overwritten.
fn refuse_other_entry(path: &Path) -> Result<(), BuildError> {
    match entry_at(path)? {
        Some(metadata) if !metadata.is_file() => {
            Err(BuildError::DeclarationPath(path.display().to_string()))
        }
        _ => Ok(()),
    }
}

/// A plugin name as a declaration file name: ASCII letters, digits, `-` and
/// `_`, starting with a letter or digit, at most `MAX_NAME_BYTES` long.
fn declaration_stem(name: &str) -> Result<&str, BuildError> {
    let plain = name.len() <= MAX_NAME_BYTES
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');

    if plain {
        Ok(name)
    } else {
        Err(BuildError::PluginName(name.to_owned()))
    }
}

/// The SDK's declarations as one file: the contract text, then its version.
fn declarations() -> String {
    format!(
        "{}export type ContractVersion = {}\n",
        tack_sdk::TACK_D_LUAU,
        tack_sdk::CONTRACT_VERSION
    )
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
    codex(&load(plugin_dir)?, out, codex_home)
}

/// Emit the Codex adapter for a plugin that is already read, and install it into `codex_home`.
fn codex(loaded: &Loaded, out: &Path, codex_home: &Path) -> Result<Vec<PathBuf>, BuildError> {
    let dest = planned_dir(&out.join("codex")).map_err(BuildError::Io)?;

    let adapter = tack_adapter_codex::render(&tack_adapter_codex::Config {
        plugin_dir: &loaded.dir,
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
