//! Public-trait conformance for the real host transport.
//!
//! A fake host answers the start line and one framed call on the same
//! socket. Replies that do not match the request are denied, never taken
//! as an answer, when driven through the public Transport seam.

#![cfg(test)]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tack_daemon::host_transport::{HostEndpoint, HostTransport};
use tack_daemon::stall::{Clock, StallError, SystemClock, Transport};

const TOKEN: &str = "conformance-token";
const START_REPLY: &str = r#"{"jsonrpc":"2.0","id":21,"result":{"stall":"sourcefed"}}"#;
const CALL_FRAME: &str = r#"{"jsonrpc":"2.0","id":22,"method":"stall.call","params":{}}"#;

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let seq = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            % 1_000_000_000;
        let path = std::env::temp_dir().join(format!(
            "tack-conformance-{}-{nanos}-{seq}",
            std::process::id()
        ));

        fs::create_dir_all(&path).unwrap();

        Self(path)
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

// Answer host.start with a matching id, read one framed call, then write the
// supplied reply on the same connection.
fn fake_host(socket: &Path, reply: &str) -> thread::JoinHandle<()> {
    let reply = reply.to_owned();
    let listener = UnixListener::bind(socket).unwrap();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();

        reader.read_line(&mut line).unwrap();
        writeln!(stream, "{START_REPLY}").unwrap();

        line.clear();
        reader.read_line(&mut line).unwrap();
        writeln!(stream, "{reply}").unwrap();
    })
}

fn call_with_reply(reply: &str) -> Result<String, StallError> {
    let dir = TempDir::new();
    let socket = dir.path().join("host.sock");
    let host = fake_host(&socket, reply);

    let endpoint = HostEndpoint::new(socket, TOKEN.to_owned());
    let mut transport = HostTransport::new(endpoint);
    let deadline = SystemClock.deadline(Duration::from_secs(5));

    let outcome = tokio::task::block_in_place(|| transport.call(CALL_FRAME, deadline));

    host.join().unwrap();

    outcome
}

#[tokio::test(flavor = "multi_thread")]
async fn an_empty_object_reply_is_malformed_through_the_public_transport() {
    assert_eq!(call_with_reply("{}"), Err(StallError::Malformed));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_foreign_result_id_is_malformed_through_the_public_transport() {
    let reply = r#"{"jsonrpc":"2.0","id":99,"result":{"ok":true}}"#;

    assert_eq!(call_with_reply(reply), Err(StallError::Malformed));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_matching_result_is_returned_through_the_public_transport() {
    let reply = r#"{"jsonrpc":"2.0","id":22,"result":{"ok":true}}"#;

    assert_eq!(call_with_reply(reply), Ok(reply.to_owned()));
}
