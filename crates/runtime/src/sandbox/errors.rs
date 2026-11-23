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
            Self::Deadline => f.write_str("tack: script deadline exceeded"),
            Self::Memory => f.write_str("tack: memory limit exceeded"),
            Self::TooManyEntries { limit } => {
                write!(f, "tack: too many table entries: {limit}")
            }
            Self::TooDeep { limit } => write!(f, "tack: nesting deeper than {limit}"),
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
            Self::Require(cause) => cause.fmt(f),
            Self::Message(message) => f.write_str(message),
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
            Self::Load(cause) => cause.fmt(f),
            Self::Script(message) | Self::InvalidResult(message) => f.write_str(message),
            Self::Limit(cause) => cause.fmt(f),
            Self::UnknownTool(name) => write!(f, "tack: unknown tool: {name}"),
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
        match &error {
            mlua::Error::MemoryError(_) => Self::Limit(LimitCause::Memory),
            _ => Self::Script(error.to_string()),
        }
    }
}
