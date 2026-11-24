use std::fmt;

use crate::require::RequireCause;

pub(super) const MAX_DEPTH: usize = 16;
pub(super) const MAX_ENTRIES: usize = 1024;

/// Why a bounded engine operation was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum LimitCause {
    Deadline,
    Memory,
    TooManyEntries { limit: usize },
    TooDeep { limit: usize },
}

impl fmt::Display for LimitCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Deadline => f.write_str("script deadline exceeded"),
            Self::Memory => f.write_str("memory limit exceeded"),
            Self::TooManyEntries { limit } => {
                write!(f, "too many table entries: {limit}")
            }
            Self::TooDeep { limit } => write!(f, "nesting deeper than {limit}"),
        }
    }
}

impl std::error::Error for LimitCause {}

/// Why a plugin could not be loaded.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum LoadCause {
    Require(RequireCause),
    Message(String),
}

impl fmt::Display for LoadCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Require(cause) => cause.fmt(f),
            Self::Message(message) => f.write_str(message),
        }
    }
}

/// A refused load, script call, limit or malformed plugin result.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum EngineError {
    Load(LoadCause),
    Script(String),
    Capability { name: String, reason: String },
    Limit(LimitCause),
    UnknownTool(String),
    InvalidResult(String),
    Poisoned,
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Load(cause) => cause.fmt(f),
            Self::Script(message) | Self::InvalidResult(message) => f.write_str(message),
            Self::Capability { name, reason } => write!(f, "capability {name}: {reason}"),
            Self::Limit(cause) => cause.fmt(f),
            Self::UnknownTool(name) => write!(f, "unknown tool: {name}"),
            Self::Poisoned => f.write_str("engine call lock poisoned"),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<mlua::Error> for EngineError {
    fn from(error: mlua::Error) -> Self {
        if let Some(cause) = error.downcast_ref::<LimitCause>() {
            return Self::Limit(cause.clone());
        }
        if let Some(cause) = error.downcast_ref::<RequireCause>() {
            return Self::Load(LoadCause::Require(cause.clone()));
        }
        if let Some(cause) = error.downcast_ref::<Self>() {
            return cause.clone();
        }
        // A memory error raised inside a callback, such as the require loader
        // running the entry chunk, arrives wrapped in a CallbackError.
        let out_of_memory = error.chain().any(|link| {
            matches!(
                link.downcast_ref::<mlua::Error>(),
                Some(mlua::Error::MemoryError(_))
            )
        });
        if out_of_memory {
            return Self::Limit(LimitCause::Memory);
        }
        Self::Script(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_causes_display_their_messages() {
        for (cause, expected) in [
            (LimitCause::Deadline, "script deadline exceeded".to_owned()),
            (LimitCause::Memory, "memory limit exceeded".to_owned()),
            (
                LimitCause::TooManyEntries { limit: MAX_ENTRIES },
                format!("too many table entries: {MAX_ENTRIES}"),
            ),
            (
                LimitCause::TooDeep { limit: MAX_DEPTH },
                format!("nesting deeper than {MAX_DEPTH}"),
            ),
        ] {
            assert_eq!(cause.to_string(), expected);
        }
    }

    #[test]
    fn load_causes_display_their_messages() {
        assert_eq!(
            LoadCause::Require(RequireCause::Missing("./x".into())).to_string(),
            "require module not found: ./x"
        );
        assert_eq!(
            LoadCause::Message("plugin folder unavailable".into()).to_string(),
            "plugin folder unavailable"
        );
    }

    #[test]
    fn engine_errors_display_their_messages() {
        for (error, expected) in [
            (
                EngineError::Load(LoadCause::Message("load fail".into())),
                "load fail".to_owned(),
            ),
            (
                EngineError::Script("script fail".into()),
                "script fail".to_owned(),
            ),
            (
                EngineError::Limit(LimitCause::Deadline),
                "script deadline exceeded".to_owned(),
            ),
            (
                EngineError::Capability {
                    name: "lookup".into(),
                    reason: "not found".into(),
                },
                "capability lookup: not found".to_owned(),
            ),
            (
                EngineError::UnknownTool("nope".into()),
                "unknown tool: nope".to_owned(),
            ),
            (
                EngineError::InvalidResult("bad result".into()),
                "bad result".to_owned(),
            ),
            (
                EngineError::Poisoned,
                "engine call lock poisoned".to_owned(),
            ),
        ] {
            assert_eq!(error.to_string(), expected);
        }
    }
}
