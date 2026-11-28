//! Generate the Pi extension that forwards guarded calls to `tack-hook`.

use std::error::Error;
use std::fmt;
use std::path::Path;

use serde_json::json;
use tack_protocol::wire::{DenyReason, MAX_FRAME_BYTES, PROTOCOL_VERSION, PluginManifest};

const TEMPLATE: &str = include_str!("../register.js");
const BUDGET_MS: u64 = 8500;

/// The extension's filename under the Pi output folder.
pub const EXTENSION_JS: &str = "extension.js";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtensionError {
    UnsafePluginDir,
    UnsafeValue(&'static str),
    MissingToken(&'static str),
}

impl fmt::Display for ExtensionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsafePluginDir => f.write_str("unsafe_value:plugin_dir"),
            Self::UnsafeValue(name) => write!(f, "unsafe_value:{name}"),
            Self::MissingToken(token) => write!(f, "missing_token:{token}"),
        }
    }
}

impl Error for ExtensionError {}

/// A manifest value embedded in a template cannot carry a token marker or a
/// newline into the generated script.
fn validate_value(name: &'static str, value: &str) -> Result<(), ExtensionError> {
    if value.contains("__TACK_") || value.chars().any(|c| c == '\n' || c == '\r') {
        return Err(ExtensionError::UnsafeValue(name));
    }
    Ok(())
}

/// Render the Pi extension with the caller's canonical plugin directory and
/// the plugin's declared identity.
///
/// # Errors
/// Returns [`ExtensionError::UnsafePluginDir`] for a relative or non-UTF-8
/// path, or one with a control character or reserved template marker,
/// [`ExtensionError::UnsafeValue`] for an unsafe manifest name or need, and
/// [`ExtensionError::MissingToken`] when the template is missing a slot.
pub fn render(plugin_dir: &Path, manifest: &PluginManifest) -> Result<String, ExtensionError> {
    let dir = plugin_dir.to_str().ok_or(ExtensionError::UnsafePluginDir)?;

    let unsafe_text = dir.contains("__TACK_") || dir.chars().any(char::is_control);

    if !plugin_dir.is_absolute() || unsafe_text {
        return Err(ExtensionError::UnsafePluginDir);
    }

    validate_value("plugin_name", &manifest.name)?;
    for need in &manifest.needs {
        validate_value("needs", need)?;
    }

    let slots = [
        ("__TACK_PLUGIN_DIR__", json!(dir).to_string()),
        (
            "__TACK_PLUGIN_NAME__",
            json!(manifest.name.as_str()).to_string(),
        ),
        ("__TACK_NEEDS__", json!(&manifest.needs).to_string()),
        ("__TACK_PROTOCOL_VERSION__", PROTOCOL_VERSION.to_string()),
        ("__TACK_BUDGET_MS__", BUDGET_MS.to_string()),
        ("__TACK_MAX_FRAME_BYTES__", MAX_FRAME_BYTES.to_string()),
        (
            "__TACK_DENY_REASONS__",
            json!(DenyReason::ALL.map(DenyReason::as_str)).to_string(),
        ),
    ];
    let mut output = TEMPLATE.to_owned();

    for (token, value) in slots {
        if !output.contains(token) {
            return Err(ExtensionError::MissingToken(token));
        }

        output = output.replace(token, &value);
    }

    Ok(output)
}
