//! Bounded host grants for plugin calls.
//!
//! A plugin is granted exactly the call names listed for it: no wildcards,
//! no case folding, no prefixes. A document without a `grants` object grants
//! nothing, so no call is allowed unless a name appears in the config.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read};
use std::marker::PhantomData;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::str::FromStr;

use rustix::process::geteuid;
use serde::Deserialize;
use serde::de::{self, MapAccess, SeqAccess, Visitor};

/// Maximum number of plugins in one grants document.
pub const MAX_PLUGINS: usize = 64;

/// Maximum number of call names in one grants document.
pub const MAX_CALLS: usize = 128;

/// Maximum length of a plugin or call name, in bytes.
pub const MAX_NAME_BYTES: usize = 128;

/// Maximum bytes read from a grants file, sized for the largest document the
/// other bounds allow.
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

// open(2) bits for the one safe open, combined: O_NOFOLLOW (no final symlink),
// O_NONBLOCK (no blocking on a FIFO) and O_CLOEXEC (no descriptor inherited by
// child processes). Values are from asm-generic on Linux and sys/fcntl.h on
// macOS.
#[cfg(target_os = "linux")]
const SAFE_OPEN_FLAGS: i32 = 0o2_404_000;
#[cfg(target_os = "macos")]
const SAFE_OPEN_FLAGS: i32 = 0x0100_0104;

// ELOOP from the O_NOFOLLOW open, where the final component is a symlink.
// Values are from errno.h on Linux and macOS.
#[cfg(target_os = "linux")]
const ELOOP: i32 = 40;
#[cfg(target_os = "macos")]
const ELOOP: i32 = 62;

/// Why a document failed to load or a pair was not authorized.
///
/// `Display` is the stable reason: a named parse cause, `grant_limit`,
/// `grant_open:<kind>` or `grant_denied`. The fields carry the detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantError {
    /// A configured bound was exceeded.
    Limit { cause: &'static str, limit: usize },
    /// The document is not exactly one `grants` object of the expected shape.
    Shape { cause: &'static str },
    /// The file could not be opened, other than through a final symlink.
    Open { kind: ErrorKind },
    /// The launched plugin did not declare the call, or has no config grant.
    Denied { plugin: String, call: String },
}

impl fmt::Display for GrantError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Limit { .. } => formatter.write_str("grant_limit"),
            Self::Shape { cause } => formatter.write_str(cause),
            Self::Open { kind } => write!(formatter, "grant_open:{kind:?}"),
            Self::Denied { .. } => formatter.write_str("grant_denied"),
        }
    }
}

impl std::error::Error for GrantError {}

/// An explicit allowlist of plugin call names. Empty by default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Grants {
    plugins: BTreeMap<String, BTreeSet<String>>,
}

impl Grants {
    /// Read and parse one grants document from `path`.
    ///
    /// The parent directory and the file must be owned by the effective user
    /// and not writable by group or other. A final symlink or a non-regular
    /// file is refused on the one open, without following or blocking on it.
    ///
    /// # Errors
    ///
    /// Returns `grant_symlink` for a final symlink or non-regular file,
    /// `grant_owner` for an unsafe file or parent directory, `grant_open`
    /// with the I/O kind for any other open failure, `grant_limit` when the
    /// file is too large, and the named parse cause for text that is not one
    /// well-formed grants document.
    pub fn from_file(path: &Path) -> Result<Self, GrantError> {
        let euid = geteuid().as_raw();
        let parent = path
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));

        let parent_meta = fs::metadata(parent).map_err(|error| file_error(&error))?;

        if parent_meta.uid() != euid || parent_meta.mode() & 0o022 != 0 {
            return Err(GrantError::Shape {
                cause: "grant_owner",
            });
        }

        let file = OpenOptions::new()
            .read(true)
            .custom_flags(SAFE_OPEN_FLAGS)
            .open(path)
            .map_err(|error| open_error(&error))?;

        let meta = file.metadata().map_err(|error| file_error(&error))?;

        if !meta.file_type().is_file() {
            return Err(GrantError::Shape {
                cause: "grant_symlink",
            });
        }

        if meta.uid() != euid || meta.mode() & 0o022 != 0 {
            return Err(GrantError::Shape {
                cause: "grant_owner",
            });
        }

        let cap =
            u64::try_from(MAX_FILE_BYTES.saturating_add(1)).map_err(|_| GrantError::Limit {
                cause: "file_bytes",
                limit: MAX_FILE_BYTES,
            })?;

        let mut bytes = Vec::new();

        file.take(cap)
            .read_to_end(&mut bytes)
            .map_err(|error| file_error(&error))?;

        if bytes.len() > MAX_FILE_BYTES {
            return Err(GrantError::Limit {
                cause: "file_bytes",
                limit: MAX_FILE_BYTES,
            });
        }

        let text = String::from_utf8(bytes).map_err(|_| GrantError::Shape {
            cause: "wrong_type",
        })?;

        Self::from_str(&text)
    }

    /// Authorize `call` for the launched plugin `launched_plugin`.
    ///
    /// Both halves are required: the launched plugin declares
    /// `control.call.<call>` in its own needs, and the host config grants
    /// that plugin/call pair. Plugin identity comes from the daemon's own
    /// launched stall, never from a request frame.
    ///
    /// # Errors
    ///
    /// Returns `Denied` carrying the launched plugin and call unless both the
    /// declaration and the config grant are present.
    pub fn authorize(
        &self,
        launched_plugin: &str,
        declared_needs: &[String],
        call: &str,
    ) -> Result<(), GrantError> {
        let need = format!("control.call.{call}");

        let declared = declared_needs.iter().any(|item| item == &need);
        let granted = self
            .plugins
            .get(launched_plugin)
            .is_some_and(|calls| calls.contains(call));

        if declared && granted {
            return Ok(());
        }

        Err(GrantError::Denied {
            plugin: launched_plugin.to_owned(),
            call: call.to_owned(),
        })
    }
}

impl FromStr for Grants {
    type Err = GrantError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let document: Document = serde_json::from_str(text).map_err(|error| GrantError::Shape {
            cause: cause_of(&error),
        })?;

        validate(&document.plugins)?;

        let plugins = document
            .plugins
            .into_iter()
            .map(|(name, control)| (name, control.calls))
            .collect();

        Ok(Self { plugins })
    }
}

/// File access is refused with the ownership reason when permissions block it.
fn file_error(error: &std::io::Error) -> GrantError {
    let cause = if error.kind() == ErrorKind::PermissionDenied {
        "grant_owner"
    } else {
        "file"
    };

    GrantError::Shape { cause }
}

/// A final symlink fails the one open before any bytes are read.
fn open_error(error: &std::io::Error) -> GrantError {
    match error.kind() {
        ErrorKind::PermissionDenied | ErrorKind::NotFound => file_error(error),
        // O_NOFOLLOW makes a final symlink fail with ELOOP; other refusals
        // keep their kind so a non-symlink error is not mislabeled.
        _ if error.raw_os_error() == Some(ELOOP) => GrantError::Shape {
            cause: "grant_symlink",
        },
        kind => GrantError::Open { kind },
    }
}

/// Map a serde failure to the cause its deserializer named.
fn cause_of(error: &serde_json::Error) -> &'static str {
    let message = error.to_string();

    for cause in [
        "unknown_key",
        "duplicate_plugin",
        "duplicate_call",
        "duplicate_key",
        "missing_control",
        "wrong_type",
    ] {
        if message.contains(cause) {
            return cause;
        }
    }

    "wrong_type"
}

/// Reject a document that fails a name rule or exceeds a bound.
fn validate(plugins: &BTreeMap<String, Control>) -> Result<(), GrantError> {
    if plugins.len() > MAX_PLUGINS {
        return Err(GrantError::Limit {
            cause: "plugins",
            limit: MAX_PLUGINS,
        });
    }

    let mut total: usize = 0;

    for (plugin, control) in plugins {
        if plugin.len() > MAX_NAME_BYTES {
            return Err(GrantError::Limit {
                cause: "plugin_name",
                limit: MAX_NAME_BYTES,
            });
        }
        if !valid_name(plugin) {
            return Err(GrantError::Shape { cause: "bad_name" });
        }

        total = total.saturating_add(control.calls.len());

        if total > MAX_CALLS {
            return Err(GrantError::Limit {
                cause: "calls",
                limit: MAX_CALLS,
            });
        }

        for call in &control.calls {
            if call.len() > MAX_NAME_BYTES {
                return Err(GrantError::Limit {
                    cause: "call_name",
                    limit: MAX_NAME_BYTES,
                });
            }
            if !valid_name(call) {
                return Err(GrantError::Shape { cause: "bad_name" });
            }
        }
    }

    Ok(())
}

/// Names are non-empty ASCII `[a-z0-9_.-]`, so no escaping is needed anywhere.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'-')
        })
}

/// Deserialize one map, either restricted to `field` or open to any name.
///
/// A named field is optional unless `missing` names the cause of its absence.
fn deserialize_object<'de, D, T>(
    deserializer: D,
    field: Option<&'static str>,
    missing: Option<&'static str>,
    expecting: &'static str,
) -> Result<BTreeMap<String, T>, D::Error>
where
    D: de::Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct ObjectVisitor<T> {
        field: Option<&'static str>,
        missing: Option<&'static str>,
        expecting: &'static str,
        marker: PhantomData<T>,
    }

    impl<'de, T> Visitor<'de> for ObjectVisitor<T>
    where
        T: Deserialize<'de>,
    {
        type Value = BTreeMap<String, T>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.expecting)
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut entries = BTreeMap::new();

            while let Some(name) = map.next_key::<String>()? {
                if let Some(field) = self.field {
                    if name != field {
                        return Err(de::Error::custom("unknown_key"));
                    }
                    if entries.contains_key(&name) {
                        return Err(de::Error::custom("duplicate_key"));
                    }

                    let value = map.next_value::<T>()?;

                    entries.insert(name, value);
                } else {
                    let value = map.next_value::<T>()?;

                    if entries.insert(name, value).is_some() {
                        return Err(de::Error::custom("duplicate_plugin"));
                    }
                }
            }

            if let (Some(field), Some(cause)) = (self.field, self.missing)
                && !entries.contains_key(field)
            {
                return Err(de::Error::custom(cause));
            }

            Ok(entries)
        }
    }

    deserializer.deserialize_map(ObjectVisitor::<T> {
        field,
        missing,
        expecting,
        marker: PhantomData,
    })
}

/// The one document shape: an optional `grants` object of plugin names.
#[derive(Debug, Default)]
struct Document {
    plugins: BTreeMap<String, Control>,
}

impl<'de> Deserialize<'de> for Document {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        let mut object = deserialize_object::<D, PluginMap>(
            deserializer,
            Some("grants"),
            None,
            "an object holding a `grants` object",
        )?;

        Ok(Self {
            plugins: object.remove("grants").unwrap_or_default().0,
        })
    }
}

/// The plugin name to plugin config map, with no repeated name.
#[derive(Debug, Default)]
struct PluginMap(BTreeMap<String, Control>);

impl<'de> Deserialize<'de> for PluginMap {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        let object = deserialize_object::<D, Control>(
            deserializer,
            None,
            None,
            "an object of plugin names",
        )?;

        Ok(Self(object))
    }
}

/// One plugin's `control` object, holding its granted call names.
#[derive(Debug, Default)]
struct Control {
    calls: BTreeSet<String>,
}

impl<'de> Deserialize<'de> for Control {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        let mut object = deserialize_object::<D, CallObject>(
            deserializer,
            Some("control"),
            Some("missing_control"),
            "an object holding a `control` object",
        )?;

        Ok(Self {
            calls: object.remove("control").unwrap_or_default().0,
        })
    }
}

/// The `calls` object inside `control`.
#[derive(Debug, Default)]
struct CallObject(BTreeSet<String>);

impl<'de> Deserialize<'de> for CallObject {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        let mut object = deserialize_object::<D, Names>(
            deserializer,
            Some("calls"),
            Some("wrong_type"),
            "an object holding a `calls` array",
        )?;

        Ok(Self(object.remove("calls").unwrap_or_default().0))
    }
}

/// The `calls` array, with no repeated name.
#[derive(Debug, Default)]
struct Names(BTreeSet<String>);

impl<'de> Deserialize<'de> for Names {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        struct NamesVisitor;

        impl<'de> Visitor<'de> for NamesVisitor {
            type Value = Names;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an array of call names")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut names = BTreeSet::new();

                while let Some(name) = seq.next_element::<String>()? {
                    if !names.insert(name) {
                        return Err(de::Error::custom("duplicate_call"));
                    }
                }

                Ok(Names(names))
            }
        }

        deserializer.deserialize_seq(NamesVisitor)
    }
}

#[cfg(test)]
mod tests {
    use std::fs::{self, Permissions};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::PathBuf;
    use std::str::FromStr;

    use serde_json::json;

    use super::*;

    const ONE_GRANT: &str = r#"{"grants":{"github":{"control":{"calls":["navigate"]}}}}"#;

    fn needs(call: &str) -> Vec<String> {
        vec![format!("control.call.{call}")]
    }

    fn with_names(plugin: &str, call: &str) -> String {
        let mut grants = serde_json::Map::new();

        grants.insert(plugin.to_owned(), json!({"control": {"calls": [call]}}));

        json!({"grants": grants}).to_string()
    }

    fn with_counts(plugins: usize, calls: usize) -> String {
        let mut names = serde_json::Map::new();

        for index in 0..plugins {
            let call_names = (0..calls)
                .map(|call| format!("c{call}"))
                .collect::<Vec<_>>();

            names.insert(
                format!("p{index}"),
                json!({"control": {"calls": call_names}}),
            );
        }

        json!({"grants": names}).to_string()
    }

    fn denied(plugin: &str, call: &str) -> GrantError {
        GrantError::Denied {
            plugin: plugin.to_owned(),
            call: call.to_owned(),
        }
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tack-grants-{}", std::process::id()));

        fs::create_dir_all(&dir).expect("fixture directory is made");
        fs::set_permissions(&dir, Permissions::from_mode(0o700)).expect("mode is set");

        dir
    }

    fn temp_path(name: &str) -> PathBuf {
        temp_dir().join(format!("tack-grants-{name}"))
    }

    fn write_file(path: &Path, bytes: &[u8], mode: u32) {
        fs::write(path, bytes).expect("fixture is written");

        fs::set_permissions(path, Permissions::from_mode(mode)).expect("mode is set");
    }

    fn remove_file(path: &Path) {
        fs::remove_file(path).expect("fixture is removed");
    }

    #[test]
    fn an_absent_or_empty_grants_object_denies_every_pair() {
        let empty = Grants::from_str("{}").expect("an empty document parses");
        let no_plugins = Grants::from_str(r#"{"grants":{}}"#).expect("no plugins parse");
        let declared = needs("navigate");

        assert_eq!(
            empty.authorize("github", &declared, "navigate"),
            Err(denied("github", "navigate"))
        );
        assert_eq!(
            no_plugins.authorize("github", &declared, "navigate"),
            Err(denied("github", "navigate"))
        );
        assert_eq!(
            Grants::default().authorize("github", &declared, "navigate"),
            Err(denied("github", "navigate"))
        );
    }

    #[test]
    fn an_exact_grant_authorizes_its_pair_only() {
        let grants = Grants::from_str(ONE_GRANT).expect("one grant parses");
        let declared = needs("navigate");

        assert_eq!(grants.authorize("github", &declared, "navigate"), Ok(()));
        assert_eq!(
            grants.authorize("GitHub", &declared, "navigate"),
            Err(denied("GitHub", "navigate"))
        );
        assert_eq!(
            grants.authorize("github", &declared, "nav"),
            Err(denied("github", "nav"))
        );
        assert_eq!(
            grants.authorize("github", &declared, "navigate "),
            Err(denied("github", "navigate "))
        );
        assert_eq!(
            grants.authorize("gitlab", &declared, "navigate"),
            Err(denied("gitlab", "navigate"))
        );
    }

    #[test]
    fn a_declaration_and_a_grant_are_both_required() {
        let granted = Grants::from_str(ONE_GRANT).expect("one grant parses");
        let declared = needs("navigate");
        let undeclared: Vec<String> = Vec::new();
        let wrong_need = vec!["call.navigate".to_owned()];
        let spaced = vec!["control.call.navigate ".to_owned()];

        assert_eq!(
            granted.authorize("github", &undeclared, "navigate"),
            Err(denied("github", "navigate"))
        );
        assert_eq!(
            granted.authorize("github", &wrong_need, "navigate"),
            Err(denied("github", "navigate"))
        );
        assert_eq!(
            granted.authorize("github", &spaced, "navigate"),
            Err(denied("github", "navigate"))
        );
        assert_eq!(
            Grants::default().authorize("github", &declared, "navigate"),
            Err(denied("github", "navigate"))
        );
    }

    #[test]
    fn every_plugin_and_call_name_is_exact() {
        let text = r#"{"grants":{"github":{"control":{"calls":["navigate","read"]}},"notes":{"control":{"calls":["write"]}}}}"#;
        let grants = Grants::from_str(text).expect("two plugins parse");

        assert_eq!(grants.authorize("github", &needs("read"), "read"), Ok(()));
        assert_eq!(grants.authorize("notes", &needs("write"), "write"), Ok(()));
        assert_eq!(
            grants.authorize("notes", &needs("read"), "read"),
            Err(denied("notes", "read"))
        );
        assert_eq!(
            grants.authorize("github", &needs("write"), "write"),
            Err(denied("github", "write"))
        );
    }

    #[test]
    fn malformed_documents_have_named_causes() {
        let cases = [
            (r#"{"extra":{},"grants":{}}"#, "unknown_key"),
            (
                r#"{"grants":{"github":{"control":{"calls":[]},"extra":1}}}"#,
                "unknown_key",
            ),
            (
                r#"{"grants":{"github":{"control":{"calls":[],"extra":[]}}}}"#,
                "unknown_key",
            ),
            (
                r#"{"grants":{"github":{"control":{"calls":[]}},"github":{"control":{"calls":[]}}}}"#,
                "duplicate_plugin",
            ),
            (
                r#"{"grants":{"github":{"control":{"calls":["read","read"]}}}}"#,
                "duplicate_call",
            ),
            (r#"{"grants":{"github":{}}}"#, "missing_control"),
            ("", "wrong_type"),
            ("[]", "wrong_type"),
            ("null", "wrong_type"),
            (r#"{"grants":[]}"#, "wrong_type"),
            (r#"{"grants":null}"#, "wrong_type"),
            (r#"{"grants":{"github":{"control":null}}}"#, "wrong_type"),
            (r#"{"grants":{"github":{"control":{}}}}"#, "wrong_type"),
            (
                r#"{"grants":{"github":{"control":{"calls":"navigate"}}}}"#,
                "wrong_type",
            ),
            (
                r#"{"grants":{"github":{"control":{"calls":[1]}}}}"#,
                "wrong_type",
            ),
            (r#"{"grants":{},"grants":{}}"#, "duplicate_key"),
            (
                r#"{"grants":{"github":{"control":{"calls":[]},"control":{"calls":[]}}}}"#,
                "duplicate_key",
            ),
            (
                r#"{"grants":{"github":{"control":{"calls":[],"calls":[]}}}}"#,
                "duplicate_key",
            ),
        ];

        for (text, cause) in cases {
            assert_eq!(
                Grants::from_str(text),
                Err(GrantError::Shape { cause }),
                "{text}"
            );
            assert_eq!(GrantError::Shape { cause }.to_string(), cause);
        }
    }

    #[test]
    fn malformed_shapes_name_what_was_expected() {
        let error =
            serde_json::from_str::<Document>("[]").expect_err("a document must be an object");
        assert!(
            error
                .to_string()
                .contains("an object holding a `grants` object"),
            "{error}"
        );

        let error = serde_json::from_str::<Names>(r"{}").expect_err("calls must be an array");
        assert!(
            error.to_string().contains("an array of call names"),
            "{error}"
        );
    }

    #[test]
    fn names_are_non_empty_ascii_lowercase_words() {
        for plugin in ["", "GitHub", "git hub", "git/hub", "git+hub"] {
            assert_eq!(
                Grants::from_str(&with_names(plugin, "navigate")),
                Err(GrantError::Shape { cause: "bad_name" }),
                "plugin {plugin}"
            );
        }

        for call in ["", "Navigate", "nav igate", "nav/igate"] {
            assert_eq!(
                Grants::from_str(&with_names("github", call)),
                Err(GrantError::Shape { cause: "bad_name" }),
                "call {call}"
            );
        }

        assert!(Grants::from_str(&with_names("github.api-1", "read_call.2")).is_ok());
    }

    #[test]
    fn plugin_count_is_bounded() {
        let at_limit = with_counts(MAX_PLUGINS, 0);
        let over_limit = with_counts(MAX_PLUGINS.saturating_add(1), 0);

        assert!(Grants::from_str(&at_limit).is_ok());
        assert_eq!(
            Grants::from_str(&over_limit),
            Err(GrantError::Limit {
                cause: "plugins",
                limit: MAX_PLUGINS
            })
        );
    }

    #[test]
    fn call_count_is_bounded() {
        let at_limit = with_counts(1, MAX_CALLS);
        let over_limit = with_counts(1, MAX_CALLS.saturating_add(1));
        let across_plugins = with_counts(2, 65);
        let expected = Err(GrantError::Limit {
            cause: "calls",
            limit: MAX_CALLS,
        });

        assert!(Grants::from_str(&at_limit).is_ok());
        assert_eq!(Grants::from_str(&over_limit), expected);
        assert_eq!(Grants::from_str(&across_plugins), expected);
    }

    #[test]
    fn name_lengths_are_bounded() {
        let exact_plugin = "p".repeat(MAX_NAME_BYTES);
        let long_plugin = "p".repeat(MAX_NAME_BYTES.saturating_add(1));
        let exact_call = "c".repeat(MAX_NAME_BYTES);
        let long_call = "c".repeat(MAX_NAME_BYTES.saturating_add(1));

        assert!(Grants::from_str(&with_names(&exact_plugin, &exact_call)).is_ok());
        assert_eq!(
            Grants::from_str(&with_names(&long_plugin, "c")),
            Err(GrantError::Limit {
                cause: "plugin_name",
                limit: MAX_NAME_BYTES
            })
        );
        assert_eq!(
            Grants::from_str(&with_names("p", &long_call)),
            Err(GrantError::Limit {
                cause: "call_name",
                limit: MAX_NAME_BYTES
            })
        );
    }

    #[test]
    fn from_file_reads_and_parses_a_document() {
        let path = temp_path("valid.json");

        write_file(&path, ONE_GRANT.as_bytes(), 0o600);

        let loaded = Grants::from_file(&path);

        remove_file(&path);

        assert_eq!(
            loaded
                .expect("file parses")
                .authorize("github", &needs("navigate"), "navigate"),
            Ok(())
        );
        assert_eq!(
            Grants::from_file(Path::new("/no/such/tack/grants/file.json")),
            Err(GrantError::Shape { cause: "file" })
        );
    }

    #[test]
    fn a_missing_grants_file_is_a_file_error() {
        let path = temp_path("missing.json");

        let error = Grants::from_file(&path).expect_err("a missing file is refused");

        assert_eq!(error.to_string(), "file");
    }

    #[test]
    fn from_file_refuses_symlinks_and_unsafe_ownership() {
        let target = temp_path("target.json");
        let link = temp_path("link.json");
        let loose = temp_path("loose.json");

        write_file(&target, ONE_GRANT.as_bytes(), 0o600);
        symlink(&target, &link).expect("symlink is made");
        write_file(&loose, ONE_GRANT.as_bytes(), 0o622);

        let linked = Grants::from_file(&link);
        let loose_result = Grants::from_file(&loose);

        remove_file(&link);
        remove_file(&loose);
        remove_file(&target);

        assert_eq!(
            linked,
            Err(GrantError::Shape {
                cause: "grant_symlink"
            })
        );
        assert_eq!(
            loose_result,
            Err(GrantError::Shape {
                cause: "grant_owner"
            })
        );
    }

    #[test]
    fn a_fifo_grants_file_is_refused_without_blocking() {
        let path = temp_path("fifo.json");
        let status = std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .expect("mkfifo runs");

        assert!(status.success(), "mkfifo makes the FIFO");

        let result = Grants::from_file(&path);

        remove_file(&path);

        assert_eq!(
            result,
            Err(GrantError::Shape {
                cause: "grant_symlink"
            })
        );
    }

    #[test]
    fn a_directory_grants_path_is_refused() {
        let path = temp_dir().join("a-directory");

        fs::create_dir(&path).expect("directory is made");

        let result = Grants::from_file(&path);

        fs::remove_dir(&path).expect("directory is removed");

        assert_eq!(
            result,
            Err(GrantError::Shape {
                cause: "grant_symlink"
            })
        );
    }

    #[test]
    fn a_non_symlink_open_refusal_names_its_kind() {
        let path = temp_path(&"n".repeat(256));

        let error = Grants::from_file(&path).expect_err("a too-long name is refused");

        assert!(matches!(error, GrantError::Open { .. }), "{error}");
        assert!(error.to_string().starts_with("grant_open:"), "{error}");
    }

    #[test]
    fn from_file_refuses_an_unsafe_parent_directory() {
        let dir = temp_dir().join("loose-dir");
        let path = dir.join("grants.json");

        fs::create_dir_all(&dir).expect("directory is made");
        write_file(&path, ONE_GRANT.as_bytes(), 0o600);
        fs::set_permissions(&dir, Permissions::from_mode(0o777)).expect("mode is set");

        let loaded = Grants::from_file(&path);

        remove_file(&path);
        fs::remove_dir(&dir).expect("directory is removed");

        assert_eq!(
            loaded,
            Err(GrantError::Shape {
                cause: "grant_owner"
            })
        );
    }

    #[test]
    fn from_file_bounds_the_bytes_it_reads() {
        let path = temp_path("large.json");
        let bytes = vec![b'x'; MAX_FILE_BYTES.saturating_add(1)];

        write_file(&path, &bytes, 0o600);

        let loaded = Grants::from_file(&path);

        remove_file(&path);

        assert_eq!(
            loaded,
            Err(GrantError::Limit {
                cause: "file_bytes",
                limit: MAX_FILE_BYTES
            })
        );
    }

    #[test]
    fn a_two_mib_grants_file_is_accepted() {
        let path = temp_path("two-mib.json");
        let mut bytes = br#"{"grants":{}}"#.to_vec();

        bytes.resize(MAX_FILE_BYTES, b' ');
        write_file(&path, &bytes, 0o600);

        let loaded = Grants::from_file(&path);

        remove_file(&path);

        assert!(loaded.is_ok());
    }

    #[test]
    fn file_byte_cap_is_two_mib() {
        assert_eq!(MAX_FILE_BYTES, 2_097_152);
    }

    #[test]
    fn from_file_refuses_bytes_that_are_not_text() {
        let path = temp_path("binary.json");

        write_file(&path, &[0xff, 0xfe], 0o600);

        let loaded = Grants::from_file(&path);

        remove_file(&path);

        assert_eq!(
            loaded,
            Err(GrantError::Shape {
                cause: "wrong_type"
            })
        );
    }

    #[test]
    fn error_names_are_stable() {
        assert_eq!(denied("p", "c").to_string(), "grant_denied");
        assert_eq!(
            GrantError::Limit {
                cause: "plugins",
                limit: MAX_PLUGINS
            }
            .to_string(),
            "grant_limit"
        );
        assert_eq!(
            GrantError::Open {
                kind: ErrorKind::Other
            }
            .to_string(),
            "grant_open:Other"
        );

        for cause in [
            "unknown_key",
            "duplicate_plugin",
            "duplicate_call",
            "missing_control",
            "wrong_type",
            "bad_name",
            "duplicate_key",
            "grant_symlink",
            "grant_owner",
            "file",
        ] {
            assert_eq!(GrantError::Shape { cause }.to_string(), cause);
        }
    }
}
