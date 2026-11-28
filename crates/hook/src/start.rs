//! Cold start: spawn a detached daemon and wait, bounded, for its socket.
//!
//! The hook never removes a socket. A daemon unlinks a stale one only after
//! it holds the kernel lock, so a live daemon's socket always survives.

use std::ffi::OsString;
use std::fs::{DirBuilder, OpenOptions};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use tack_protocol::wire::ReplyError;

use crate::Failure;
use crate::locate::DAEMON_LOG;

const POLL: Duration = Duration::from_millis(25);

/// What a detached daemon starts with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub bin: PathBuf,
    pub socket: PathBuf,
    pub plugin: PathBuf,
    pub state: PathBuf,
    pub name: Option<String>,
    pub needs: Vec<String>,
}

impl Launch {
    /// The daemon arguments after its program: the socket and plugin first,
    /// then the plugin identity when a name was supplied. With no name, no
    /// identity arguments are sent and the daemon denies control calls.
    fn argv(&self) -> Vec<OsString> {
        let mut args = vec![
            OsString::from("--socket"),
            self.socket.as_os_str().to_os_string(),
            OsString::from("--plugin"),
            self.plugin.as_os_str().to_os_string(),
        ];

        if let Some(name) = &self.name {
            args.push(OsString::from("--plugin-name"));
            args.push(OsString::from(name.as_str()));

            for need in &self.needs {
                args.push(OsString::from("--need"));
                args.push(OsString::from(need.as_str()));
            }
        }

        args
    }

    /// Spawn the daemon in its own process group, its output appended to
    /// `daemon.log` in the state folder. A missing state folder is created
    /// owner-only; an existing one is left as it is.
    ///
    /// # Errors
    ///
    /// Returns a `daemon_error` failure when the folder, the log or the
    /// process cannot be created.
    pub fn spawn(&self) -> Result<(), Failure> {
        let failed = |what: &str, error: std::io::Error| {
            Failure::new(ReplyError::DaemonError, format_args!("{what}: {error}"))
        };

        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.state)
            .map_err(|error| failed("cannot create the state dir", error))?;

        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(self.state.join(DAEMON_LOG))
            .map_err(|error| failed("cannot open the daemon log", error))?;
        let errors = log
            .try_clone()
            .map_err(|error| failed("cannot open the daemon log", error))?;

        // The daemon outlives this short-lived client by design, so the child
        // is never waited on; init reaps it.
        Command::new(&self.bin)
            .args(self.argv())
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(errors)
            .process_group(0)
            .spawn()
            .map_err(|error| failed(&format!("cannot start {}", self.bin.display()), error))?;

        Ok(())
    }
}

/// The identity of the socket file, so a rebind reads as a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    dev: u64,
    ino: u64,
    mtime: i64,
    mtime_nsec: i64,
}

impl Stamp {
    fn read(socket: &Path) -> Option<Self> {
        let meta = std::fs::symlink_metadata(socket).ok()?;

        Some(Self {
            dev: meta.dev(),
            ino: meta.ino(),
            mtime: meta.mtime(),
            mtime_nsec: meta.mtime_nsec(),
        })
    }
}

/// Run `start` once, then wait at most `limit` for a socket file that was
/// not there before. Readiness is a hint: the caller's one connect retry is
/// the proof.
///
/// # Errors
///
/// Returns the failure `start` reports.
pub async fn cold_start<S>(socket: &Path, start: S, limit: Duration) -> Result<(), Failure>
where
    S: FnOnce() -> Result<(), Failure> + Send,
{
    let before = Stamp::read(socket);

    start()?;

    let ready = async {
        while Stamp::read(socket).is_none_or(|now| Some(now) == before) {
            tokio::time::sleep(POLL).await;
        }
    };

    // Past the limit the retry still runs and names the failure.
    let _ = tokio::time::timeout(limit, ready).await;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_state_path_that_is_a_file_fails_before_any_process_starts() {
        let file =
            std::env::temp_dir().join(format!("tack-hook-start-{}.file", std::process::id()));
        std::fs::write(&file, b"").unwrap();

        // The bin does not exist either, so no process could start even if
        // spawn reached the command.
        let launch = Launch {
            bin: file.with_extension("missing-bin"),
            socket: file.with_extension("sock"),
            plugin: file.with_extension("plugin"),
            state: file.clone(),
            name: None,
            needs: Vec::new(),
        };

        let result = launch.spawn();
        let _ = std::fs::remove_file(&file);

        assert_eq!(
            result.map_err(|failure| failure.kind),
            Err(ReplyError::DaemonError)
        );
    }

    #[test]
    fn argv_forwards_the_identity_after_the_socket_and_plugin_args() {
        let launch = Launch {
            bin: PathBuf::from("/bin/tack-daemon"),
            socket: PathBuf::from("/state/tack.sock"),
            plugin: PathBuf::from("/plugins/safe-push"),
            state: PathBuf::from("/state"),
            name: Some("safe-push".into()),
            needs: vec!["control.call.push".into(), "sdk.barn".into()],
        };

        assert_eq!(
            launch.argv(),
            vec![
                OsString::from("--socket"),
                OsString::from("/state/tack.sock"),
                OsString::from("--plugin"),
                OsString::from("/plugins/safe-push"),
                OsString::from("--plugin-name"),
                OsString::from("safe-push"),
                OsString::from("--need"),
                OsString::from("control.call.push"),
                OsString::from("--need"),
                OsString::from("sdk.barn"),
            ]
        );
    }

    #[test]
    fn argv_forwards_nothing_when_there_is_no_name() {
        let launch = Launch {
            bin: PathBuf::from("/bin/tack-daemon"),
            socket: PathBuf::from("/state/tack.sock"),
            plugin: PathBuf::from("/plugins/safe-push"),
            state: PathBuf::from("/state"),
            name: None,
            needs: vec!["control.call.push".into()],
        };

        assert_eq!(
            launch.argv(),
            vec![
                OsString::from("--socket"),
                OsString::from("/state/tack.sock"),
                OsString::from("--plugin"),
                OsString::from("/plugins/safe-push"),
            ]
        );
    }
}
