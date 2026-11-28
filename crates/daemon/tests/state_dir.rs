//! Proof that the daemon reads its state dir from `TACK_STATE_DIR`.
//!
//! A socket outside that folder is refused before anything is bound or launched.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> std::io::Result<Self> {
        let seq = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            % 1_000_000_000;
        let path = std::env::temp_dir().join(format!(
            "tack-state-dir-{}-{nanos}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&path)?;

        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn assert_socket_mismatch(state: &Path, socket: &Path, status: Option<i32>, stderr: &str) {
    assert_eq!(status, Some(2));
    assert_eq!(
        stderr,
        format!(
            "tack-daemon: socket_not_in_state_dir: expected {} got {}\n",
            state.join("tack.sock").display(),
            socket.display()
        )
    );
}

#[test]
fn the_state_dir_comes_from_tack_state_dir() -> Result<(), Box<dyn std::error::Error>> {
    let dir = TempDir::new()?;
    let state = dir.path().join("state");
    let wrong = dir.path().join("elsewhere.sock");

    let launched = Command::new(env!("CARGO_BIN_EXE_tack-daemon"))
        .arg("--socket")
        .arg(&wrong)
        .arg("--plugin")
        .arg(dir.path())
        .arg("--plugin-name")
        .arg("state-proof")
        .env("TACK_STATE_DIR", &state)
        .env_remove("TACK_GRANTS")
        .env_remove("TACK_HARNESS_SOCK")
        .stdin(Stdio::null())
        .output();

    let out = launched?;

    let stderr = String::from_utf8(out.stderr)?;

    assert_socket_mismatch(&state, &wrong, out.status.code(), &stderr);

    Ok(())
}
