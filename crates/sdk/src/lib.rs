//! The plugin SDK: the types and helpers a Luau plugin builds against.

pub const TACK_D_LUAU: &str = include_str!("../tack.d.luau");

/// The module name a plugin lists in its manifest needs to opt into the SDK.
pub const SDK_MODULE: &str = "sdk";

/// Major of the SDK contract described by TACK_D_LUAU. A host must refuse
/// a plugin written against another major with a named error.
pub const CONTRACT_MAJOR: u32 = 1;

#[cfg(test)]
mod tests {
    use super::{CONTRACT_MAJOR, TACK_D_LUAU};

    #[test]
    fn declarations_name_the_exported_contract_major() {
        let expected = format!("-- SDK contract major: {CONTRACT_MAJOR}\n");
        assert!(TACK_D_LUAU.contains(&expected));
    }
}
