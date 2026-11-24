//! Values passed between a host and a Luau plugin.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A tool invocation supplied to a hook.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Call {
    /// The tool kind exposed to the plugin.
    pub tool: String,
    /// The invocation's tool name.
    pub name: String,
    /// The tool's arguments.
    pub input: Value,
    /// The host's session identifier, when available.
    pub session_id: Option<String>,
}

/// The verdict returned by a hook.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Outcome {
    /// The invocation can proceed unchanged.
    Allow,
    /// The invocation must not proceed.
    Deny { reason: String },
    /// The invocation can proceed with replacement arguments.
    Rewrite { input: Value },
}

/// A content item returned by a plugin tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Content {
    /// The kind of content carried by this item.
    pub kind: String,
    /// The item's text payload.
    pub text: String,
}

/// A tool that the plugin advertises to its host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolDef {
    /// The tool name.
    pub name: String,
    /// A description for the caller.
    pub description: String,
    /// The plugin's input schema.
    pub input: Value,
}

/// The metadata and tool definitions advertised by a plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    /// The plugin name.
    pub name: String,
    /// The capabilities the plugin requests. This list does not grant them.
    pub needs: Vec<String>,
    /// The tools the plugin advertises.
    pub tools: Vec<ToolDef>,
}
