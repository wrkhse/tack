use std::fmt;

use crate::require::RequireCause;

pub(super) const MAX_DEPTH: usize = 16;
pub(super) const MAX_ENTRIES: usize = 1024;

/// Why a bounded engine operation was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LimitCause {
    Deadline,
    Memory,
    TooManyEntries { limit: usize },
    TooDeep { limit: usize },
}

impl fmt::Display for LimitCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LimitCause::Deadline => f.write_str("tack: script deadline exceeded"),
            LimitCause::Memory => f.write_str("tack: memory limit exceeded"),
            LimitCause::TooManyEntries { limit } => {
                write!(f, "tack: too many table entries: {limit}")
            }
            LimitCause::TooDeep { limit } => write!(f, "tack: nesting deeper than {limit}"),
        }
    }
}

impl std::error::Error for LimitCause {}

/// Why a plugin could not be loaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadCause {
    Require(RequireCause),
    Message(String),
}

impl fmt::Display for LoadCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LoadCause::Require(cause) => cause.fmt(f),
            LoadCause::Message(message) => f.write_str(message),
        }
    }
}

/// A refused load, script call, limit or malformed plugin result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    Load(LoadCause),
    Script(String),
    Limit(LimitCause),
    UnknownTool(String),
    InvalidResult(String),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::Load(cause) => cause.fmt(f),
            EngineError::Script(message) | EngineError::InvalidResult(message) => {
                f.write_str(message)
            }
            EngineError::Limit(cause) => cause.fmt(f),
            EngineError::UnknownTool(name) => write!(f, "tack: unknown tool: {name}"),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<mlua::Error> for EngineError {
    fn from(error: mlua::Error) -> Self {
        if let Some(cause) = error.downcast_ref::<LimitCause>() {
            return EngineError::Limit(cause.clone());
        }
        if let Some(cause) = error.downcast_ref::<RequireCause>() {
            return EngineError::Load(LoadCause::Require(cause.clone()));
        }
        match &error {
            mlua::Error::MemoryError(_) => EngineError::Limit(LimitCause::Memory),
            _ => EngineError::Script(error.to_string()),
        }
    }
}
