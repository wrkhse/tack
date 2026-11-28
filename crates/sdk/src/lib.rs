//! The plugin SDK: the types and helpers a Luau plugin builds against.

/// The typed Luau declarations for a plugin, emitted by `tack build` for a
/// plugin that lists the `sdk` module.
pub const TACK_D_LUAU: &str = include_str!("../tack.d.luau");

/// The major version of the plugin contract that [`TACK_D_LUAU`] declares.
pub const CONTRACT_VERSION: u32 = 1;
