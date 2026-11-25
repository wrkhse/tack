//! Install tack's handlers into a Codex home: merge their groups into
//! `hooks.json` and their trust into `[hooks.state.<key>]` of `config.toml`.
//!
//! Every other hook keeps its group index, so its state key, and its state
//! table is copied unchanged. Both files are computed before either is
//! written, and each is replaced by an atomic rename.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::trust::{Event, Handler, handler_hash, hook_key};
use crate::{CodexError, toml_string};

/// The hooks file Codex reads from its home.
pub const HOOKS_FILE: &str = "hooks.json";
/// The user config Codex reads hook state from.
pub const CONFIG_FILE: &str = "config.toml";

/// Find the Codex home as Codex does: `CODEX_HOME`, which must be an
/// existing folder and is canonicalized, else `HOME/.codex`, created when
/// missing and used as written.
///
/// # Errors
///
/// Returns [`CodexError::Home`] when `CODEX_HOME` is not a folder, when
/// neither variable names an absolute path, or when `HOME/.codex` cannot be
/// created.
pub fn resolve_home(
    codex_home: Option<&OsStr>,
    home: Option<&OsStr>,
) -> Result<PathBuf, CodexError> {
    if let Some(codex_home) = codex_home.filter(|value| !value.is_empty()) {
        let path = Path::new(codex_home);

        if !path.is_dir() {
            return Err(CodexError::Home(format!(
                "CODEX_HOME {} is not a folder",
                path.display()
            )));
        }

        return fs::canonicalize(path).map_err(|error| CodexError::Home(error.to_string()));
    }

    let home = home
        .filter(|value| !value.is_empty())
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| CodexError::Home("neither CODEX_HOME nor HOME is set".into()))?;
    let path = home.join(".codex");

    fs::create_dir_all(&path).map_err(|error| CodexError::Home(error.to_string()))?;

    Ok(path)
}

/// The two files written into the Codex home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub hooks: PathBuf,
    pub config: PathBuf,
}

/// Merge `handlers` and their trust into the Codex home at `home`.
///
/// # Errors
///
/// Returns [`CodexError::Unsafe`] for a home path Codex's state key cannot
/// hold, [`CodexError::Hooks`] or [`CodexError::Config`] for an existing
/// file tack cannot merge into safely, and [`CodexError::Io`] when a file
/// cannot be read or written.
pub fn install(home: &Path, handlers: &[Handler]) -> Result<Installed, CodexError> {
    let hooks_path = home.join(HOOKS_FILE);
    let config_path = home.join(CONFIG_FILE);
    let source = hooks_path
        .to_str()
        .filter(|text| !text.chars().any(char::is_control))
        .ok_or(CodexError::Unsafe("codex_home"))?;

    let hooks_text = read_optional(&hooks_path)?;
    let (hooks, groups) = merge_hooks(hooks_text.as_deref(), handlers)?;
    let stale = match hooks_text.as_deref() {
        Some(text) => tack_hashes(
            &serde_json::from_str(text).map_err(|error| CodexError::Hooks(error.to_string()))?,
        ),
        None => HashSet::new(),
    };
    let trust: Vec<(String, String)> = handlers
        .iter()
        .zip(groups)
        .map(|(handler, group)| {
            (
                hook_key(source, handler.event, group, 0),
                handler.trusted_hash(),
            )
        })
        .collect();

    let config_text = read_optional(&config_path)?;
    let config = merge_state(config_text.as_deref().unwrap_or(""), &trust, source, &stale)?;

    // Trust first: a rebuilt hook whose state is missing would be skipped.
    write_atomic(&config_path, &config)?;
    write_atomic(&hooks_path, &hooks)?;

    Ok(Installed {
        hooks: hooks_path,
        config: config_path,
    })
}

fn read_optional(path: &Path) -> Result<Option<String>, CodexError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CodexError::Io(error.to_string())),
    }
}

const fn script_name(event: Event) -> &'static str {
    match event {
        Event::PreToolUse => crate::PRE_TOOL_USE_JS,
        Event::SessionStart => crate::SESSION_START_JS,
    }
}

/// A group tack generated: one command handler running one of its scripts
/// through its wrapper, `sh '<dir>/run-hook.sh' '<dir>/<script>'`.
fn is_tack_group(group: &Value, event: Event) -> bool {
    let suffix = format!("/{}'", script_name(event));
    let wrapper = format!("/{}' '", crate::RUN_HOOK_SH);
    let handlers = group.get("hooks").and_then(Value::as_array);

    let Some([handler]) = handlers.map(Vec::as_slice) else {
        return false;
    };

    handler.get("type").and_then(Value::as_str) == Some("command")
        && handler
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|command| {
                command.starts_with("sh '")
                    && command.contains(&wrapper)
                    && command.ends_with(&suffix)
            })
}

/// Put each handler's group where tack's group of that event already is, or
/// at the end, and return the new file with each handler's group index.
fn merge_hooks(
    existing: Option<&str>,
    handlers: &[Handler],
) -> Result<(String, Vec<usize>), CodexError> {
    let mut file = match existing {
        Some(text) => serde_json::from_str::<Value>(text)
            .map_err(|error| CodexError::Hooks(error.to_string()))?,
        None => Value::Object(Map::new()),
    };
    let root = file
        .as_object_mut()
        .ok_or_else(|| CodexError::Hooks("not an object".into()))?;

    if let Some(key) = root
        .keys()
        .find(|key| *key != "hooks" && *key != "description")
    {
        return Err(CodexError::Hooks(format!("unknown field {key}")));
    }

    let events = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| CodexError::Hooks("hooks is not an object".into()))?;
    let mut indices = Vec::with_capacity(handlers.len());

    for handler in handlers {
        let groups = events
            .entry(handler.event.name())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| CodexError::Hooks(format!("{} is not a list", handler.event.name())))?;
        let mut ours = groups
            .iter()
            .enumerate()
            .filter(|(_, group)| is_tack_group(group, handler.event))
            .map(|(index, _)| index);

        let index = match (ours.next(), ours.next()) {
            (Some(index), None) => index,
            (None, _) => {
                groups.push(Value::Null);
                groups.len().saturating_sub(1)
            }
            (Some(_), Some(_)) => {
                return Err(CodexError::Hooks(format!(
                    "two tack groups in {}",
                    handler.event.name()
                )));
            }
        };

        if let Some(slot) = groups.get_mut(index) {
            *slot = handler.group();
        }

        indices.push(index);
    }

    let mut text = serde_json::to_string_pretty(&file)
        .map_err(|error| CodexError::Hooks(error.to_string()))?;
    text.push('\n');

    Ok((text, indices))
}

/// The hashes Codex trusts tack's own generated groups under in `hooks`, the
/// hooks file as it was before this build. Only a group `is_tack_group`
/// names is hashed; a user's hook is never hashed or judged.
fn tack_hashes(hooks: &Value) -> HashSet<String> {
    let mut hashes = HashSet::new();

    for event in [Event::PreToolUse, Event::SessionStart] {
        let groups = hooks
            .get("hooks")
            .and_then(|events| events.get(event.name()))
            .and_then(Value::as_array);

        for group in groups.into_iter().flatten() {
            if !is_tack_group(group, event) {
                continue;
            }

            let handler = group
                .get("hooks")
                .and_then(Value::as_array)
                .and_then(|handlers| handlers.first());

            if let Some(hash) = handler.and_then(|handler| handler_hash(event, group, handler)) {
                hashes.insert(hash);
            }
        }
    }

    hashes
}

/// Whether `line` sets `trusted_hash` to a plain basic string in `hashes`.
/// Any other spelling, such as a literal string or a trailing comment, reads
/// as no, so its table stays.
fn trusted_hash_in(line: &str, hashes: &HashSet<String>) -> bool {
    let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect();

    compact
        .strip_prefix("trusted_hash=")
        .and_then(|value| value.strip_prefix('"'))
        .and_then(|value| value.strip_suffix('"'))
        .is_some_and(|hash| !hash.contains(['"', '\\', '#']) && hashes.contains(hash))
}

fn state_header(key: &str) -> String {
    format!("[hooks.state.{}]", toml_string(key))
}

/// What the line-level merge cannot place safely: a multi-line string, any
/// other spelling of `hooks` or `hooks.state`, or a tack key outside its
/// own table header.
fn check_line(table: &str, line: &str, keys: &[&str]) -> Result<(), CodexError> {
    let trimmed = line.trim_start();
    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    let refuse = |what: &str| Err(CodexError::Config(what.to_owned()));

    if line.contains("\"\"\"") || line.contains("'''") {
        return refuse("a multi-line string");
    }

    if compact.starts_with("[[hooks") {
        return refuse("an array of hooks tables");
    }

    let defines = |key: &str| {
        compact.starts_with(&format!("{key}="))
            || compact.starts_with(&format!("{key}."))
            || compact.starts_with(&format!("\"{key}\""))
    };

    if (table.is_empty() && defines("hooks")) || (table == "[hooks]" && defines("state")) {
        return refuse("hooks.state outside its own tables");
    }

    if keys.iter().any(|key| line.contains(key)) {
        return refuse("a tack hook key outside its table header");
    }

    Ok(())
}

/// Drop the state tables of `trust`'s keys, and every state table of `source`
/// whose `trusted_hash` is in `stale`: the hashes tack's own groups had
/// before this build, so such a table is tack's, left behind under a key
/// that may now name another hook. Keep every other line as it is, and append
/// one table per key of `trust`.
fn merge_state(
    existing: &str,
    trust: &[(String, String)],
    source: &str,
    stale: &HashSet<String>,
) -> Result<String, CodexError> {
    let headers: Vec<String> = trust.iter().map(|(key, _)| state_header(key)).collect();
    let keys: Vec<&str> = trust.iter().map(|(key, _)| key.as_str()).collect();
    let source_header = state_header(&format!("{source}:"));
    let source_prefix = source_header.strip_suffix("\"]").unwrap_or(&source_header);
    let mut kept = String::with_capacity(existing.len());
    let mut pending = String::new();
    let mut table = String::new();
    let mut skipping = false;
    let mut judged = false;
    let mut dropped = false;

    for line in existing.split_inclusive('\n') {
        let trimmed = line.trim();

        // A table is kept or dropped whole, once its last line is known.
        if trimmed.starts_with('[') {
            if !dropped {
                kept.push_str(&pending);
            }

            pending.clear();
            skipping = headers.iter().any(|header| header == trimmed);
            judged = trimmed.starts_with(source_prefix);
            dropped = false;
            table = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
        }

        if skipping {
            continue;
        }

        check_line(&table, line, &keys)?;

        if judged && trusted_hash_in(line, stale) {
            dropped = true;
        }

        pending.push_str(line);
    }

    if !dropped {
        kept.push_str(&pending);
    }

    let mut output = kept.trim_end().to_owned();

    for ((_, hash), header) in trust.iter().zip(&headers) {
        if !output.is_empty() {
            output.push_str("\n\n");
        }

        output.push_str(header);
        output.push_str("\nenabled = true\ntrusted_hash = ");
        output.push_str(&toml_string(hash));
    }

    output.push('\n');

    Ok(output)
}

/// Write `contents` beside `path` and rename it over `path`, keeping the
/// old file's permissions.
fn write_atomic(path: &Path, contents: &str) -> Result<(), CodexError> {
    let io = |error: std::io::Error| CodexError::Io(format!("{}: {error}", path.display()));
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| CodexError::Io(format!("{}: no file name", path.display())))?;
    let temporary = path.with_file_name(format!(".{name}.tack-{}.tmp", std::process::id()));
    let permissions = fs::metadata(path)
        .ok()
        .map(|metadata| metadata.permissions());

    let written =
        write_new(&temporary, contents, permissions).and_then(|()| fs::rename(&temporary, path));

    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }

    written.map_err(io)
}

fn write_new(
    path: &Path,
    contents: &str,
    permissions: Option<fs::Permissions>,
) -> std::io::Result<()> {
    let mut file = fs::File::create_new(path)?;
    file.write_all(contents.as_bytes())?;

    if let Some(permissions) = permissions {
        file.set_permissions(permissions)?;
    }

    file.sync_all()
}

#[cfg(test)]
mod tests;
