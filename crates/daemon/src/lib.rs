//! The per-user daemon that puts a bounded stall between hooks and plugins.
//!
//! A wrapper sends one framed request. The daemon forwards it to barn's host
//! transport and returns the stall's verdict. A boundary failure becomes a
//! named reply; no request turns into an implicit allow.

pub mod frames;
pub mod grants;
pub mod host_transport;
pub mod pipe;
pub mod stall;
pub mod transport;

use std::path::{Path, PathBuf};

pub const EXIT_USAGE: i32 = 2;
pub const EXIT_LOCK_BUSY: i32 = 3;
pub const EXIT_ENGINE: i32 = 4;

pub const SOCKET_NAME: &str = "tack.sock";
pub const ERR_SOCKET_MISMATCH: &str = "socket_not_in_state_dir";

fn state_dir_from(
    tack_state_dir: Option<&str>,
    xdg_state_home: Option<&str>,
    home: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(dir) = tack_state_dir.filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    if let Some(dir) = xdg_state_home.filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir).join("tack"));
    }

    let home = home
        .filter(|home| !home.is_empty())
        .ok_or_else(|| "cannot determine state dir: set TACK_STATE_DIR or HOME".to_owned())?;

    Ok(PathBuf::from(home).join(".local/state/tack"))
}

/// Resolve the state folder from `TACK_STATE_DIR`, `XDG_STATE_HOME` or `HOME`.
///
/// # Errors
///
/// Returns a message when none of the environment variables supplies a usable
/// home path.
pub fn state_dir() -> Result<PathBuf, String> {
    let tack = std::env::var("TACK_STATE_DIR").ok();
    let xdg = std::env::var("XDG_STATE_HOME").ok();
    let home = std::env::var("HOME").ok();

    state_dir_from(tack.as_deref(), xdg.as_deref(), home.as_deref())
}

#[must_use]
pub fn socket_in_state_dir(state_dir: &Path, socket: &Path) -> bool {
    socket == state_dir.join(SOCKET_NAME)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn state_dir_follows_the_environment_precedence() {
        assert_eq!(
            state_dir_from(Some("/custom"), Some("/xdg"), Some("/home/u")).unwrap(),
            PathBuf::from("/custom")
        );
        assert_eq!(
            state_dir_from(None, Some("/xdg"), Some("/home/u")).unwrap(),
            PathBuf::from("/xdg/tack")
        );
        assert_eq!(
            state_dir_from(None, None, Some("/home/u")).unwrap(),
            PathBuf::from("/home/u/.local/state/tack")
        );
        assert!(state_dir_from(None, None, None).is_err());
    }

    #[test]
    fn empty_environment_values_are_ignored() {
        assert_eq!(
            state_dir_from(Some(""), Some("/xdg"), Some("/home/u")).unwrap(),
            PathBuf::from("/xdg/tack")
        );
        assert_eq!(
            state_dir_from(None, Some(""), Some("/home/u")).unwrap(),
            PathBuf::from("/home/u/.local/state/tack")
        );
    }

    #[test]
    fn socket_must_be_the_state_dir_socket() {
        let state = PathBuf::from("/state");

        assert!(socket_in_state_dir(&state, &state.join("tack.sock")));
        assert!(!socket_in_state_dir(&state, &state.join("other.sock")));
        assert!(!socket_in_state_dir(&state, Path::new("/other/tack.sock")));
    }
}
