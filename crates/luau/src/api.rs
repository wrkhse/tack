//! Values passed between a host and a Luau plugin.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A host invocation supplied to a named hook.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invocation {
    /// The hook's name in the plugin table.
    pub hook: String,
    /// The JSON payload passed as the hook's first argument.
    pub payload: Value,
    /// Host data exposed on `ctx`: object fields, or `ctx.host` for another value.
    pub context: Value,
}

/// The verdict returned by a hook.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum Outcome {
    /// The invocation can proceed unchanged.
    Allow,
    /// The invocation must not proceed.
    Deny { reason: String },
    /// The invocation can proceed with a replacement payload.
    Rewrite { payload: Value },
}
