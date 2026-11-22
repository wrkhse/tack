//! Generation of the OpenCode JavaScript wrapper that forwards hooks and tool
//! runs to the daemon as NDJSON and fails closed.

use std::error::Error;
use std::fmt;

use tack_protocol::wire::PluginManifest;

const TEMPLATE: &str = include_str!("../opencode.js");

const TOKENS: [&str; 7] = [
    "__TACK_MANIFEST__",
    "__TACK_DAEMON_BIN__",
    "__TACK_PLUGIN_DIR__",
    "__TACK_DENY_REASONS__",
    "__TACK_CALL_TIMEOUT_MS__",
    "__TACK_START_TIMEOUT_MS__",
    "__TACK_PROTOCOL_VERSION__",
];

pub struct WrapperConfig<'a> {
    pub manifest: &'a PluginManifest,
    pub daemon_bin: &'a str,
    pub plugin_dir: &'a str,
    pub protocol_version: u32,
    pub deny_reasons: &'a [&'a str],
    pub call_timeout_ms: u64,
    pub start_timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WrapperError {
    MissingToken(&'static str),
    UnreplacedToken(&'static str),
    UnsafeValue(&'static str),
    Json(String),
}

impl fmt::Display for WrapperError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WrapperError::MissingToken(token) => write!(f, "missing_token:{token}"),
            WrapperError::UnreplacedToken(token) => write!(f, "unreplaced_token:{token}"),
            WrapperError::UnsafeValue(name) => write!(f, "unsafe_value:{name}"),
            WrapperError::Json(message) => write!(f, "json:{message}"),
        }
    }
}

impl Error for WrapperError {}

fn validate(name: &'static str, value: &str) -> Result<(), WrapperError> {
    if value.contains("__TACK_") || value.chars().any(|c| c == '\n' || c == '\r') {
        return Err(WrapperError::UnsafeValue(name));
    }
    Ok(())
}

/// Fill the seven template slots with JSON literals and refuse any template that
/// is not fully and safely substituted.
pub fn render(config: &WrapperConfig) -> Result<String, WrapperError> {
    validate("daemon_bin", config.daemon_bin)?;
    validate("plugin_dir", config.plugin_dir)?;
    for reason in config.deny_reasons {
        validate("deny_reasons", reason)?;
    }

    let manifest = serde_json::to_string(config.manifest)
        .map_err(|error| WrapperError::Json(error.to_string()))?;
    validate("manifest", &manifest)?;

    let values: [(&'static str, String); 7] = [
        (TOKENS[0], manifest),
        (
            TOKENS[1],
            serde_json::to_string(config.daemon_bin)
                .map_err(|error| WrapperError::Json(error.to_string()))?,
        ),
        (
            TOKENS[2],
            serde_json::to_string(config.plugin_dir)
                .map_err(|error| WrapperError::Json(error.to_string()))?,
        ),
        (
            TOKENS[3],
            serde_json::to_string(config.deny_reasons)
                .map_err(|error| WrapperError::Json(error.to_string()))?,
        ),
        (TOKENS[4], config.call_timeout_ms.to_string()),
        (TOKENS[5], config.start_timeout_ms.to_string()),
        (TOKENS[6], config.protocol_version.to_string()),
    ];

    let mut output = TEMPLATE.to_owned();
    for (token, value) in values {
        if !output.contains(token) {
            return Err(WrapperError::MissingToken(token));
        }
        output = output.replace(token, &value);
    }

    for token in TOKENS {
        if output.contains(token) {
            return Err(WrapperError::UnreplacedToken(token));
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tack_protocol::wire::ToolDef;

    use super::*;

    fn manifest() -> PluginManifest {
        PluginManifest {
            name: "safe-push".into(),
            needs: vec!["daemon".into()],
            tools: vec![ToolDef {
                name: "guard_status".into(),
                description: "Reports daemon status".into(),
                input: json!({}),
            }],
        }
    }

    fn config<'a>(manifest: &'a PluginManifest, reasons: &'a [&'a str]) -> WrapperConfig<'a> {
        WrapperConfig {
            manifest,
            daemon_bin: "/opt/tack/tack-daemon",
            plugin_dir: "/plugins/tack",
            protocol_version: 1,
            deny_reasons: reasons,
            call_timeout_ms: 2000,
            start_timeout_ms: 3000,
        }
    }

    #[test]
    fn render_replaces_every_token() {
        let manifest = manifest();
        let reasons = [
            "socket_missing",
            "timeout",
            "socket_closed",
            "malformed_reply",
        ];
        let output = render(&config(&manifest, &reasons)).expect("render succeeds");

        assert!(output.contains(r#""name":"safe-push""#));
        assert!(output.contains(r#""/opt/tack/tack-daemon""#));
        assert!(output.contains(r#""/plugins/tack""#));
        assert!(
            output.contains(r#"["socket_missing","timeout","socket_closed","malformed_reply"]"#)
        );
        assert!(output.contains(" = 2000;"));
        assert!(output.contains(" = 3000;"));
        assert!(output.contains("const PROTOCOL_VERSION = 1;"));
        for token in TOKENS {
            assert!(!output.contains(token), "token {token} survives");
        }
        assert!(!output.contains("__TACK_"));
    }

    #[test]
    fn render_refuses_newlines_and_token_like_values() {
        let manifest = manifest();
        let reasons = ["socket_missing"];

        let mut newline = config(&manifest, &reasons);
        newline.daemon_bin = "/opt/tack\n/tack-daemon";
        assert_eq!(
            render(&newline),
            Err(WrapperError::UnsafeValue("daemon_bin"))
        );

        let mut token_like = config(&manifest, &reasons);
        token_like.plugin_dir = "__TACK_PLUGIN_DIR__";
        assert_eq!(
            render(&token_like),
            Err(WrapperError::UnsafeValue("plugin_dir"))
        );
    }
}
