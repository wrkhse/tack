//! Bounded runtime services: the plugin sandbox and the scoped module loader.
//! NDJSON framing over the owner-only Unix socket lives in the daemon.

mod require;
pub mod sandbox;

pub use sandbox::{EngineError, Sandbox};
