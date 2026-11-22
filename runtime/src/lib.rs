//! Bounded runtime services: the plugin sandbox, the scoped module loader and
//! JSON-RPC framing over the owner-only Unix socket.

mod require;
pub mod sandbox;
pub mod transport;

pub use sandbox::{EngineError, Sandbox};
