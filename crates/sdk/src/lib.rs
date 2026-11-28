//! The plugin SDK: the types and helpers a Luau plugin builds against.

pub const TACK_D_LUAU: &str = include_str!("../tack.d.luau");

/// The module name a plugin lists in its manifest needs to opt into the SDK.
pub const SDK_MODULE: &str = "sdk";

/// Major of the SDK contract that TACK_D_LUAU declares.
pub const CONTRACT_MAJOR: u32 = 1;

#[cfg(test)]
mod tests {
    use super::{CONTRACT_MAJOR, TACK_D_LUAU};

    #[test]
    fn declarations_name_the_exported_contract_major() {
        let expected = format!("-- SDK contract major: {CONTRACT_MAJOR}");
        assert_eq!(TACK_D_LUAU.lines().nth(1), Some(expected.as_str()));
    }
}
