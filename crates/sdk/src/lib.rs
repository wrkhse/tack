//! The plugin SDK: the types and helpers a Luau plugin builds against.

use std::fmt;

pub const TACK_D_LUAU: &str = include_str!("../tack.d.luau");

/// The manifest need that opts a tool into the SDK module.
pub const SDK_NEED: &str = "sdk";

/// The contract major this SDK emits declarations for.
pub const SDK_CONTRACT_MAJOR: u32 = 1;

/// The plugin declares a contract major this SDK does not support.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ContractError {
    WrongMajor { found: u32 },
}

impl fmt::Display for ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongMajor { found } => write!(
                f,
                "contract_major_mismatch: found {found}, expected {SDK_CONTRACT_MAJOR}"
            ),
        }
    }
}

impl std::error::Error for ContractError {}

/// Accept `found` only when it matches this SDK's contract major.
///
/// # Errors
///
/// Returns `ContractError::WrongMajor` when `found` differs from this SDK's
/// contract major.
pub const fn check_contract_major(found: u32) -> Result<(), ContractError> {
    if found == SDK_CONTRACT_MAJOR {
        Ok(())
    } else {
        Err(ContractError::WrongMajor { found })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WRONG_MAJOR: u32 = 2;

    #[test]
    fn the_current_contract_major_is_accepted() {
        assert_eq!(check_contract_major(SDK_CONTRACT_MAJOR), Ok(()));
    }

    #[test]
    fn a_different_contract_major_is_refused_by_name() {
        let found = WRONG_MAJOR;
        let error = check_contract_major(found).expect_err("a different major is refused");

        assert_eq!(
            check_contract_major(WRONG_MAJOR),
            Err(ContractError::WrongMajor { found: WRONG_MAJOR })
        );
        assert_eq!(
            error.to_string(),
            "contract_major_mismatch: found 2, expected 1"
        );
    }
}
