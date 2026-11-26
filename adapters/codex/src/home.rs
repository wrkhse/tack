//! Install tack's handlers into a Codex home: merge their groups into
//! `hooks.json` and their trust into `[hooks.state.<key>]` of `config.toml`.
//!
//! Every other hook keeps its group index, so its state key, and its state
//! table is copied unchanged. tack's own `tack-hashes` file beside them
//! remembers the hashes its hooks were trusted under, so a later build still
//! knows tack's state tables once no tack group is left in `hooks.json`. All
//! three files are computed before any is written, and each is replaced by an
//! atomic rename.

use std::collections::{HashMap, HashSet};
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
/// tack's record of the hashes its hooks were trusted under, newest last: one
/// `sha256:<hex>` per line, with blank lines and `#` comments ignored.
pub const HASHES_FILE: &str = "tack-hashes";
/// The most hashes `HASHES_FILE` keeps.
const MAX_HASHES: usize = 32;
/// Why a `HASHES_FILE` is refused: a line that is not a blank line, a comment
/// or exactly `sha256:<hex>`.
const MALFORMED_HASHES: &str = "a malformed tack-hashes line";

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

/// The three files written into the Codex home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub hooks: PathBuf,
    pub config: PathBuf,
    pub hashes: PathBuf,
}

/// The three home files as a build will write them: read, merged and checked,
/// with nothing written yet. Only [`plan_home`] makes one, and
/// [`Planned::commit`] writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    hooks_path: PathBuf,
    config_path: PathBuf,
    hashes_path: PathBuf,
    hooks: String,
    config: String,
    hashes: String,
}

impl Planned {
    /// Write the planned merge into the Codex home, each file by an atomic
    /// rename.
    ///
    /// # Errors
    ///
    /// Returns [`CodexError::Io`] when a file cannot be written.
    pub fn commit(self) -> Result<Installed, CodexError> {
        // Trust first: a rebuilt hook whose state is missing would be skipped.
        write_atomic(&self.config_path, &self.config)?;
        write_atomic(&self.hooks_path, &self.hooks)?;
        write_atomic(&self.hashes_path, &self.hashes)?;

        Ok(Installed {
            hooks: self.hooks_path,
            config: self.config_path,
            hashes: self.hashes_path,
        })
    }
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
    plan_home(home, handlers)?.commit()
}

/// Read the home files and compute their merge with `handlers` and their
/// trust, checking everything `install` checks, without writing anything.
///
/// # Errors
///
/// Returns [`CodexError::Unsafe`] for a home path Codex's state key cannot
/// hold, [`CodexError::Hooks`] or [`CodexError::Config`] for an existing
/// file tack cannot merge into safely, a malformed `tack-hashes` included, and
/// [`CodexError::Io`] when a file cannot be read.
pub fn plan_home(home: &Path, handlers: &[Handler]) -> Result<Planned, CodexError> {
    let hooks_path = home.join(HOOKS_FILE);
    let config_path = home.join(CONFIG_FILE);
    let hashes_path = home.join(HASHES_FILE);
    let source = hooks_path
        .to_str()
        .filter(|text| !text.chars().any(char::is_control))
        .ok_or(CodexError::Unsafe("codex_home"))?;

    let hooks_text = read_optional(&hooks_path)?;
    let (hooks, groups) = merge_hooks(hooks_text.as_deref(), handlers)?;
    let merged: Value =
        serde_json::from_str(&hooks).map_err(|error| CodexError::Hooks(error.to_string()))?;
    let mut stale = match hooks_text.as_deref() {
        Some(text) => tack_hashes(
            &serde_json::from_str(text).map_err(|error| CodexError::Hooks(error.to_string()))?,
        ),
        None => HashSet::new(),
    };
    let hashes_text = read_optional(&hashes_path)?;
    let record = if hashes_text.is_some() {
        HashRecord::Present
    } else {
        HashRecord::Missing
    };
    let recorded = parse_hashes(hashes_text.as_deref().unwrap_or(""))?;
    stale.extend(recorded.iter().cloned());
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
    let config = merge_state(
        config_text.as_deref().unwrap_or(""),
        &trust,
        source,
        &stale,
        &HookHashes::read(&merged),
        record,
    )?;
    let hashes = render_hashes(&recorded, &trust);

    Ok(Planned {
        hooks_path,
        config_path,
        hashes_path,
        hooks,
        config,
        hashes,
    })
}

/// Whether `text` is exactly a hash as tack writes one: `sha256:` and 64
/// lowercase hex digits.
fn is_hash(text: &str) -> bool {
    text.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// The hashes a `tack-hashes` file holds, each once, in file order, keeping
/// only the newest `MAX_HASHES`: the last ones in the file.
///
/// # Errors
///
/// Returns [`CodexError::Config`] for a line that is not blank, a `#`
/// comment, or exactly a hash.
fn parse_hashes(text: &str) -> Result<Vec<String>, CodexError> {
    let mut seen = HashSet::new();
    let mut hashes = Vec::new();

    for line in text.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }

        if !is_hash(line) {
            return Err(CodexError::Config(MALFORMED_HASHES.to_owned()));
        }

        if seen.insert(line) {
            hashes.push(line.to_owned());
        }
    }

    let excess = hashes.len().saturating_sub(MAX_HASHES);
    hashes.drain(..excess);

    Ok(hashes)
}

/// The next `tack-hashes` file: the `recorded` hashes, then `trust`'s hashes
/// as the newest, each once, keeping the last `MAX_HASHES`. A hash in use is
/// always among the newest, so it is never dropped while tack trusts it.
fn render_hashes(recorded: &[String], trust: &[(String, String)]) -> String {
    let current: Vec<&str> = trust
        .iter()
        .map(|(_, hash)| hash.as_str())
        .filter(|hash| is_hash(hash))
        .collect();
    let mut hashes: Vec<&str> = recorded
        .iter()
        .map(String::as_str)
        .filter(|hash| !current.contains(hash))
        .collect();

    for hash in &current {
        if !hashes.contains(hash) {
            hashes.push(hash);
        }
    }

    let excess = hashes.len().saturating_sub(MAX_HASHES);
    hashes.drain(..excess);

    let mut text =
        String::from("# The hashes tack's Codex hooks were trusted under, newest last.\n");

    for hash in hashes {
        text.push_str(hash);
        text.push('\n');
    }

    text
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

/// The value `line` sets `trusted_hash` to, when it is a plain basic string.
/// Any other spelling, such as a literal string or a trailing comment, gives
/// `None`, so its table stays.
fn plain_trusted_hash(line: &str) -> Option<String> {
    let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect();

    compact
        .strip_prefix("trusted_hash=")
        .and_then(|value| value.strip_prefix('"'))
        .and_then(|value| value.strip_suffix('"'))
        .filter(|hash| !hash.contains(['"', '\\', '#']))
        .map(str::to_owned)
}

/// Whether a `tack-hashes` file was there to read before this build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HashRecord {
    Present,
    Missing,
}

/// What a hooks file holds at one state key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyHook<'a> {
    /// A hook whose trust hash tack reproduces exactly.
    Hashed(&'a str),
    /// A hook tack cannot hash, or an event it does not read.
    Unverified,
    /// No hook at all.
    Missing,
}

/// The hooks of a hooks file by state key, for the events tack reads: per
/// event label, its groups in order, each with its handlers' trust hashes. A
/// group whose handlers are not a list is `None`, and so is a handler tack
/// cannot hash.
#[derive(Debug, Default)]
struct HookHashes {
    events: HashMap<&'static str, Vec<Option<Vec<Option<String>>>>>,
}

impl HookHashes {
    fn read(hooks: &Value) -> Self {
        let mut events = HashMap::new();

        for event in [Event::PreToolUse, Event::SessionStart] {
            let Some(groups) = hooks
                .get("hooks")
                .and_then(|events| events.get(event.name()))
                .and_then(Value::as_array)
            else {
                continue;
            };

            let hashed = groups
                .iter()
                .map(|group| {
                    let handlers = group.get("hooks").and_then(Value::as_array)?;

                    Some(
                        handlers
                            .iter()
                            .map(|handler| handler_hash(event, group, handler))
                            .collect(),
                    )
                })
                .collect();

            events.insert(event.key_label(), hashed);
        }

        Self { events }
    }

    fn at(&self, event: &str, group: usize, handler: usize) -> KeyHook<'_> {
        let Some(groups) = self.events.get(event) else {
            return KeyHook::Unverified;
        };

        match groups.get(group) {
            None => KeyHook::Missing,
            Some(None) => KeyHook::Unverified,
            Some(Some(handlers)) => match handlers.get(handler) {
                None => KeyHook::Missing,
                Some(None) => KeyHook::Unverified,
                Some(Some(hash)) => KeyHook::Hashed(hash),
            },
        }
    }
}

/// Whether `line` makes its table, a state table of this hooks file whose
/// key holds `hook`, tack's to drop: its plain `trusted_hash` is one of
/// tack's `stale` hashes, differs from the hash of the hook now at its key,
/// or names no hook on a build with no `tack-hashes` yet, the first after
/// an upgrade. A table whose hook tack cannot hash, or whose hash is spelled
/// otherwise, stays: tack never drops trust it cannot verify.
fn drops(hook: KeyHook<'_>, line: &str, stale: &HashSet<String>, record: HashRecord) -> bool {
    let Some(hash) = plain_trusted_hash(line) else {
        return false;
    };

    stale.contains(&hash)
        || match hook {
            KeyHook::Hashed(expected) => hash != expected,
            KeyHook::Missing => record == HashRecord::Missing,
            KeyHook::Unverified => false,
        }
}

fn state_header(key: &str) -> String {
    format!("[hooks.state.{}]", toml_string(key))
}

/// The key of a `[hooks.state."<key>"]` header as written, escapes kept, when
/// only space may sit between the key's closing quote and `]`, and only space
/// or a TOML comment follows the `]`.
fn state_key(header: &str) -> Option<&str> {
    let quoted = header.strip_prefix("[hooks.state.\"")?;
    let mut escaped = false;
    let mut end = None;

    // The key ends at the first quote that is not escaped.
    for (index, character) in quoted.char_indices() {
        if escaped {
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            end = Some(index);
            break;
        }
    }

    let end = end?;
    let after = quoted
        .get(end..)?
        .strip_prefix('"')?
        .trim_start()
        .strip_prefix(']')?
        .trim_start();

    if after.is_empty() || after.starts_with('#') {
        quoted.get(..end)
    } else {
        None
    }
}

/// The event label, group and handler of `header` when it is a state table
/// header for a hook of the hooks file `source`:
/// `[hooks.state."<source>:<event>:<group>:<handler>"]`, with a non-empty event
/// label and two indices, and only space or a comment after it. The key is
/// split from its end, so a hooks file whose path only begins with `source`
/// and a colon is another source and does not match.
fn source_state_hook<'a>(header: &'a str, source: &str) -> Option<(&'a str, usize, usize)> {
    let key = state_key(header)?;
    let mut fields = key.rsplitn(4, ':');
    let (Some(handler), Some(group), Some(event), Some(path)) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return None;
    };

    // The key is compared as written, so the source is escaped the same way.
    let quoted = toml_string(source);
    let escaped = quoted
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'));

    if escaped != Some(path) || event.is_empty() {
        return None;
    }

    Some((event, group.parse().ok()?, handler.parse().ok()?))
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
/// that `drops` names: one holding a hash in `stale`, the hashes tack's own
/// groups had before this build, one whose hash differs from the hook `hooks`
/// now holds at its key, and on a first build with no `tack-hashes` (`record`)
/// one whose key holds no hook. Keep every other line as it is, and append one
/// table per key of `trust`.
fn merge_state(
    existing: &str,
    trust: &[(String, String)],
    source: &str,
    stale: &HashSet<String>,
    hooks: &HookHashes,
    record: HashRecord,
) -> Result<String, CodexError> {
    let headers: Vec<String> = trust.iter().map(|(key, _)| state_header(key)).collect();
    let keys: Vec<&str> = trust.iter().map(|(key, _)| key.as_str()).collect();
    let mut kept = String::with_capacity(existing.len());
    let mut pending = String::new();
    let mut table = String::new();
    let mut skipping = false;
    let mut judged: Option<KeyHook<'_>> = None;
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
            judged = source_state_hook(trimmed, source)
                .map(|(event, group, handler)| hooks.at(event, group, handler));
            dropped = false;
            table = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
        }

        if skipping {
            continue;
        }

        check_line(&table, line, &keys)?;

        if let Some(hook) = judged
            && drops(hook, line, stale, record)
        {
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
mod source_state_tests {
    fn is_source_state(header: &str, source: &str) -> bool {
        super::source_state_hook(header, source).is_some()
    }

    #[test]
    fn only_a_tack_key_of_exactly_this_source_is_judged() {
        let source = "/h/hooks.json";

        assert!(is_source_state(
            "[hooks.state.\"/h/hooks.json:pre_tool_use:0:0\"]",
            source
        ));
        assert!(is_source_state(
            "[hooks.state.\"/h/hooks.json:session_start:2:1\"]",
            source
        ));
        assert!(is_source_state(
            "[hooks.state.\"/h/hooks.json:stop:0:0\"]",
            source
        ));
        assert!(is_source_state(
            "[hooks.state.\"/h/\\\"q\\\"/hooks.json:pre_tool_use:0:0\"]",
            "/h/\"q\"/hooks.json"
        ));

        for header in [
            "[hooks.state.\"/h/hooks.json:extra:pre_tool_use:0:0\"]",
            "[hooks.state.\"/p/hooks.json:pre_tool_use:0:0\"]",
            "[hooks.state.\"/h/hooks.json::0:0\"]",
            "[hooks.state.\"/h/hooks.json:pre_tool_use:x:0\"]",
            "[hooks.state.\"/h/hooks.json:pre_tool_use:0:x\"]",
            "[hooks.state.\"/h/hooks.json:pre_tool_use:0\"]",
            "[hooks.state.'/h/hooks.json:pre_tool_use:0:0']",
            "[projects.\"/h/hooks.json:pre_tool_use:0:0\"]",
        ] {
            assert!(!is_source_state(header, source), "{header}");
        }
    }

    #[test]
    fn a_header_may_end_in_space_or_a_comment_but_nothing_else() {
        let source = "/h/hooks.json";

        for header in [
            "[hooks.state.\"/h/hooks.json:pre_tool_use:0:0\"]  ",
            "[hooks.state.\"/h/hooks.json:pre_tool_use:0:0\"] # kept by hand",
            "[hooks.state.\"/h/hooks.json:pre_tool_use:0:0\"]#",
            "[hooks.state.\"/h/hooks.json:pre_tool_use:0:0\" ]",
        ] {
            assert!(is_source_state(header, source), "{header}");
        }

        for header in [
            "[hooks.state.\"/h/hooks.json:pre_tool_use:0:0\"] x",
            "[hooks.state.\"/h/hooks.json:pre_tool_use:0:0\"",
            "[hooks.state.\"/h/hooks.json:pre_tool_use:0:0",
        ] {
            assert!(!is_source_state(header, source), "{header}");
        }
    }
}

#[cfg(test)]
mod tests;
