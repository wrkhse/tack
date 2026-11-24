//! A Luau sandbox with a scoped module loader and host-supplied capabilities.

pub mod api;
mod require;
mod sandbox;

pub use require::RequireCause;
pub use sandbox::{Capabilities, EngineError, LimitCause, Limits, LoadCause, Sandbox};
