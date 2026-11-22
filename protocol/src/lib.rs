//! Wire contracts, serialization and protocol invariants shared by the tack
//! CLI, daemon and generated wrappers.

/// Reasons a wrapper denies a call when it cannot obtain a verdict.
pub const DENY_REASONS: [&str; 4] = [
    "socket_missing",
    "timeout",
    "socket_closed",
    "malformed_reply",
];
