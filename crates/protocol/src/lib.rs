//! Wire contracts, serialization and protocol invariants shared by the tack
//! CLI, daemon and generated wrappers.

// Review-gate proof: a small non-docs change.

/// Memory ceiling for one plugin VM.
pub const DEFAULT_MEMORY_BYTES: usize = 16 * 1024 * 1024;

/// Wall-clock budget for one hook or tool call.
pub const DEFAULT_DEADLINE_MS: u64 = 100;

/// Hard cap on one NDJSON frame, newline included.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Upper bound on in-flight calls a daemon admits.
pub const MAX_PENDING: usize = 16;

pub mod wire;
