//! Where the daemon lives: the state folder, its socket and the daemon binary.
//!
//! The state folder rule matches the daemon and the `OpenCode` wrapper, so
//! every client reaches the same socket.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use tack_protocol::wire::ReplyError;

use crate::Failure;

pub const SOCKET_NAME: &str = "tack.sock";
pub const DAEMON_NAME: &str = "tack-daemon";
pub const DAEMON_LOG: &str = "daemon.log";

fn state_dir_from(
    tack_state_dir: Option<&str>,
    xdg_state_home: Option<&str>,
    home: Option<&str>,
) -> Result<PathBuf, Failure> {
    if let Some(dir) = tack_state_dir.filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir));
    }

    if let Some(dir) = xdg_state_home.filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir).join("tack"));
    }

    let home = home.filter(|home| !home.is_empty()).ok_or_else(|| {
        Failure::new(
            ReplyError::SocketMissing,
            "cannot determine the state dir: set TACK_STATE_DIR or HOME",
        )
    })?;

    Ok(PathBuf::from(home).join(".local/state/tack"))
}

/// The state folder: `TACK_STATE_DIR` as-is, else `XDG_STATE_HOME/tack`,
/// else `HOME/.local/state/tack`. Empty values count as unset.
///
/// # Errors
///
/// Returns a `socket_missing` failure when none of them is set.
pub fn state_dir() -> Result<PathBuf, Failure> {
    let tack = std::env::var("TACK_STATE_DIR").ok();
    let xdg = std::env::var("XDG_STATE_HOME").ok();
    let home = std::env::var("HOME").ok();

    state_dir_from(tack.as_deref(), xdg.as_deref(), home.as_deref())
}

/// The daemon binary: `explicit` when set, else a `tack-daemon` beside
/// `exe` that `exists`, else the bare name for a `PATH` lookup.
pub fn daemon_bin_from(
    explicit: Option<OsString>,
    exe: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> PathBuf {
    if let Some(bin) = explicit.filter(|bin| !bin.is_empty()) {
        return PathBuf::from(bin);
    }

    let sibling = exe
        .and_then(Path::parent)
        .map(|dir| dir.join(DAEMON_NAME))
        .filter(|sibling| exists(sibling));

    sibling.unwrap_or_else(|| PathBuf::from(DAEMON_NAME))
}

/// The daemon binary from `TACK_DAEMON_BIN`, a sibling of this executable,
/// or `PATH`.
#[must_use]
pub fn daemon_bin() -> PathBuf {
    let exe = std::env::current_exe().ok();

    daemon_bin_from(
        std::env::var_os("TACK_DAEMON_BIN"),
        exe.as_deref(),
        Path::is_file,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_dir_follows_the_environment_precedence() {
        assert_eq!(
            state_dir_from(Some("/custom"), Some("/xdg"), Some("/home/u")),
            Ok(PathBuf::from("/custom"))
        );
        assert_eq!(
            state_dir_from(None, Some("/xdg"), Some("/home/u")),
            Ok(PathBuf::from("/xdg/tack"))
        );
        assert_eq!(
            state_dir_from(Some(""), Some(""), Some("/home/u")),
            Ok(PathBuf::from("/home/u/.local/state/tack"))
        );
        assert_eq!(
            state_dir_from(None, None, Some("")),
            Err(Failure::new(
                ReplyError::SocketMissing,
                "cannot determine the state dir: set TACK_STATE_DIR or HOME",
            ))
        );
    }

    #[test]
    fn daemon_bin_prefers_the_variable_then_the_sibling_then_path() {
        let exe = Path::new("/opt/tack/bin/tack-hook");
        let sibling = PathBuf::from("/opt/tack/bin/tack-daemon");

        assert_eq!(
            daemon_bin_from(Some("/x/daemon".into()), Some(exe), |_| true),
            PathBuf::from("/x/daemon")
        );
        assert_eq!(
            daemon_bin_from(Some(OsString::new()), Some(exe), |path| path == sibling),
            sibling
        );
        assert_eq!(
            daemon_bin_from(None, Some(exe), |_| false),
            PathBuf::from(DAEMON_NAME)
        );
        assert_eq!(
            daemon_bin_from(None, None, |_| true),
            PathBuf::from(DAEMON_NAME)
        );
    }
}
