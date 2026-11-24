//! The check before every connect: the state folder and the socket in it
//! must be this user's, so no other user can stand in for the daemon.
//!
//! A folder only its owner can enter keeps others from planting or replacing
//! a socket inside it; the socket's owner and mode then show who bound it.

use std::fs::Metadata;
use std::io::ErrorKind;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use rustix::process::geteuid;
use tack_protocol::wire::ReplyError;

use crate::Failure;
use crate::exchange::Attempt;

const FILE_TYPE: u32 = 0o170_000;
const PERMISSIONS: u32 = 0o7777;

/// What one file must be: its type, and the mode bits it may not carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    kind: u32,
    forbidden: u32,
    name: &'static str,
    limit: &'static str,
}

/// The state folder: a directory open to its owner alone, 0700 or stricter.
pub const STATE_DIR: Rule = Rule {
    kind: 0o040_000,
    forbidden: 0o077,
    name: "directory",
    limit: "0700 or stricter",
};

/// The socket: a socket neither its group nor the world can write.
pub const SOCKET: Rule = Rule {
    kind: 0o140_000,
    forbidden: 0o022,
    name: "socket",
    limit: "not group or world writable",
};

/// The owner and mode of one file, as `stat` reports them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stat {
    pub uid: u32,
    pub mode: u32,
}

impl Stat {
    fn of(meta: &Metadata) -> Self {
        Self {
            uid: meta.uid(),
            mode: meta.mode(),
        }
    }
}

/// Why a file fails its rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Distrust {
    WrongType,
    Owner { uid: u32 },
    Mode { mode: u32 },
}

/// Whether `stat` meets `rule` for the effective uid `euid`: the type
/// first, then the owner, then the mode.
pub const fn judge(rule: Rule, euid: u32, stat: Stat) -> Result<(), Distrust> {
    if stat.mode & FILE_TYPE != rule.kind {
        return Err(Distrust::WrongType);
    }

    if stat.uid != euid {
        return Err(Distrust::Owner { uid: stat.uid });
    }

    if stat.mode & rule.forbidden != 0 {
        return Err(Distrust::Mode {
            mode: stat.mode & PERMISSIONS,
        });
    }

    Ok(())
}

/// Check the state folder, then `socket` inside it. A missing folder or
/// socket is absent, so a cold start may follow; any other failure, a stat
/// that fails included, is `socket_untrusted`.
pub fn verify(socket: &Path) -> Result<(), Attempt> {
    let euid = geteuid().as_raw();
    let dir = socket
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

    // The folder is followed through a symlink, as the daemon does; the
    // socket is not, so a symlink in its place is no socket.
    inspect(dir, std::fs::metadata(dir), STATE_DIR, euid)?;
    inspect(socket, std::fs::symlink_metadata(socket), SOCKET, euid)
}

fn inspect(
    path: &Path,
    meta: std::io::Result<Metadata>,
    rule: Rule,
    euid: u32,
) -> Result<(), Attempt> {
    let meta = match meta {
        Ok(meta) => meta,
        Err(error) if error.kind() == ErrorKind::NotFound => return Err(Attempt::Absent(error)),
        Err(error) => {
            return Err(untrusted(format_args!(
                "cannot check {}: {error}",
                path.display()
            )));
        }
    };

    judge(rule, euid, Stat::of(&meta)).map_err(|distrust| {
        let path = path.display();

        match distrust {
            Distrust::WrongType => untrusted(format_args!("{path} is not a {}", rule.name)),
            Distrust::Owner { uid } => {
                untrusted(format_args!("{path} belongs to uid {uid}, not {euid}"))
            }
            Distrust::Mode { mode } => untrusted(format_args!(
                "{path} has mode {mode:04o}, it must be {}",
                rule.limit
            )),
        }
    })
}

fn untrusted(message: impl std::fmt::Display) -> Attempt {
    Attempt::Failed(Failure::new(ReplyError::SocketUntrusted, message))
}

#[cfg(test)]
mod tests {
    use std::fs::Permissions;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    use super::*;

    const EUID: u32 = 501;
    const DIR: u32 = 0o040_000;
    const SOCK: u32 = 0o140_000;
    const FILE: u32 = 0o100_000;

    const fn stat(uid: u32, mode: u32) -> Stat {
        Stat { uid, mode }
    }

    #[test]
    fn the_state_dir_is_the_users_own_and_0700_or_stricter() {
        assert_eq!(judge(STATE_DIR, EUID, stat(EUID, DIR | 0o700)), Ok(()));
        assert_eq!(judge(STATE_DIR, EUID, stat(EUID, DIR | 0o500)), Ok(()));
        assert_eq!(
            judge(STATE_DIR, EUID, stat(EUID, DIR | 0o755)),
            Err(Distrust::Mode { mode: 0o755 })
        );
        assert_eq!(
            judge(STATE_DIR, EUID, stat(EUID, DIR | 0o710)),
            Err(Distrust::Mode { mode: 0o710 })
        );
        assert_eq!(
            judge(STATE_DIR, EUID, stat(EUID, DIR | 0o701)),
            Err(Distrust::Mode { mode: 0o701 })
        );
        assert_eq!(
            judge(STATE_DIR, EUID, stat(0, DIR | 0o700)),
            Err(Distrust::Owner { uid: 0 })
        );
        assert_eq!(
            judge(STATE_DIR, EUID, stat(EUID, FILE | 0o700)),
            Err(Distrust::WrongType)
        );
    }

    #[test]
    fn the_socket_is_the_users_own_and_not_group_or_world_writable() {
        assert_eq!(judge(SOCKET, EUID, stat(EUID, SOCK | 0o600)), Ok(()));
        assert_eq!(judge(SOCKET, EUID, stat(EUID, SOCK | 0o755)), Ok(()));
        assert_eq!(
            judge(SOCKET, EUID, stat(EUID, SOCK | 0o620)),
            Err(Distrust::Mode { mode: 0o620 })
        );
        assert_eq!(
            judge(SOCKET, EUID, stat(EUID, SOCK | 0o602)),
            Err(Distrust::Mode { mode: 0o602 })
        );
        assert_eq!(
            judge(SOCKET, EUID, stat(1000, SOCK | 0o600)),
            Err(Distrust::Owner { uid: 1000 })
        );
        assert_eq!(
            judge(SOCKET, EUID, stat(EUID, FILE | 0o600)),
            Err(Distrust::WrongType)
        );
        assert_eq!(
            judge(SOCKET, EUID, stat(EUID, DIR | 0o700)),
            Err(Distrust::WrongType)
        );
    }

    #[test]
    fn the_type_is_judged_before_the_owner_and_the_owner_before_the_mode() {
        assert_eq!(
            judge(SOCKET, EUID, stat(0, FILE | 0o666)),
            Err(Distrust::WrongType)
        );
        assert_eq!(
            judge(SOCKET, EUID, stat(0, SOCK | 0o666)),
            Err(Distrust::Owner { uid: 0 })
        );
    }

    /// A folder under the temp dir, removed when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("tack-trust-{}-{name}", std::process::id()));

            std::fs::create_dir_all(&path).unwrap();
            std::fs::set_permissions(&path, Permissions::from_mode(0o700)).unwrap();

            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn kind(attempt: Result<(), Attempt>) -> Result<(), Option<ReplyError>> {
        attempt.map_err(|attempt| match attempt {
            Attempt::Absent(_) => None,
            Attempt::Failed(failure) => Some(failure.kind),
        })
    }

    #[test]
    fn a_private_dir_without_a_socket_is_absent_so_a_cold_start_may_follow() {
        let dir = Scratch::new("absent");

        assert_eq!(kind(verify(&dir.0.join("tack.sock"))), Err(None));
    }

    #[test]
    fn a_stat_that_fails_other_than_not_found_is_untrusted() {
        let dir = Scratch::new("not-a-dir");
        let file = dir.0.join("file");
        std::fs::write(&file, b"").unwrap();

        // The state folder lies under a regular file, so its stat fails with
        // "not a directory", which no cold start can fix.
        let socket = file.join("state").join("tack.sock");

        assert_eq!(
            kind(verify(&socket)),
            Err(Some(ReplyError::SocketUntrusted))
        );
    }
}
