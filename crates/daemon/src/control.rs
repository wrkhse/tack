//! Control frames carried on barn's host socket.
//!
//! Control frames are raw tack protocol NDJSON interleaved on the same
//! stream barn uses for `host.start` and normal framed calls. tack never
//! initiates one. A frame is recognized only when it arrives as the next line
//! while a host call awaits its reply. Every reply echoes the frame's id and
//! version and is either one control result or one named daemon error.

use std::io::{BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tack_protocol::wire::{
    self as wire, MAX_FRAME_BYTES, PROTOCOL_VERSION, Reply, Request, WireError,
};
use tokio::net::UnixStream as AsyncUnixStream;
use tokio::runtime::Handle;
use tokio::time::timeout;

use crate::grants::Grants;
use crate::host_transport::ControlBroker as ControlBrokerTrait;

/// Environment variable naming the optional socket a harness listens on for
/// granted control calls.
pub const HARNESS_SOCK_ENV: &str = "TACK_HARNESS_SOCK";

/// Whole budget for one harness exchange, including the connect.
const HARNESS_DEADLINE: Duration = Duration::from_secs(2);

const ERR_CONTROL_FRAME: &str = "control_frame_too_large";
const ERR_MALFORMED: &str = "malformed_control_frame";
const ERR_VERSION: &str = "protocol_version_mismatch";
const ERR_GRANT: &str = "grant_denied";
const ERR_SOCKET: &str = "harness_socket_missing";
const ERR_CONNECT: &str = "harness_connect_failed";
const ERR_RUNTIME: &str = "harness_runtime_unavailable";
const ERR_TIMEOUT: &str = "harness_timeout";
const ERR_IO: &str = "harness_io_error";
const ERR_FRAME: &str = "harness_frame_too_large";
const ERR_REPLY: &str = "harness_malformed_reply";
const ERR_HARNESS: &str = "harness_error";

/// The identity barn launched with, and the needs it declared.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchIdentity {
    pub name: String,
    pub needs: Vec<String>,
}

/// Authorizes control frames against the launch identity and host grants,
/// then forwards granted calls to one bounded harness socket.
#[allow(
    clippy::module_name_repetitions,
    reason = "the broker handles control frames; the name is the protocol contract"
)]
pub struct ControlBroker {
    identity: LaunchIdentity,
    grants: Grants,
    harness_socket: Option<PathBuf>,
}

impl ControlBroker {
    /// Bind the launch identity, host grants and optional harness socket.
    #[must_use]
    pub const fn new(
        identity: LaunchIdentity,
        grants: Grants,
        harness_socket: Option<PathBuf>,
    ) -> Self {
        Self {
            identity,
            grants,
            harness_socket,
        }
    }

    /// Recognize one control frame and answer it, or ignore an ordinary line.
    ///
    /// Only a well-formed JSON object tagged `kind: control` is claimed. Once
    /// claimed, a reply is always produced: parse, version and grant failures
    /// become named errors before any socket work is attempted.
    #[must_use]
    pub fn try_handle(&self, line: &[u8], deadline: Instant) -> Option<Vec<u8>> {
        let probe: Value = serde_json::from_slice(line).ok()?;

        if !control_probe(&probe) {
            return None;
        }

        let fallback_id = probe.get("id").and_then(Value::as_u64).unwrap_or_default();

        Some(self.handle_control(fallback_id, line, deadline))
    }

    /// Recognize a control frame without authorizing, forwarding or counting it.
    #[must_use]
    pub fn is_control(&self, line: &[u8]) -> bool {
        let Ok(probe) = serde_json::from_slice::<Value>(line) else {
            return false;
        };

        control_probe(&probe)
    }

    /// Handle a claimed frame without letting any failure escape.
    fn handle_control(&self, fallback_id: u64, line: &[u8], deadline: Instant) -> Vec<u8> {
        if line.len() > MAX_FRAME_BYTES {
            return error_line(fallback_id, ERR_CONTROL_FRAME);
        }

        let Ok(Request::Control {
            id,
            version,
            call,
            input,
        }) = serde_json::from_slice::<Request>(line)
        else {
            return error_line(fallback_id, ERR_MALFORMED);
        };

        if version != PROTOCOL_VERSION {
            return error_line(id, ERR_VERSION);
        }

        if self
            .grants
            .authorize(&self.identity.name, &self.identity.needs, &call)
            .is_err()
        {
            return error_line(id, ERR_GRANT);
        }

        match self.harness_result(&call, &input, deadline) {
            Ok(result) => encode_reply(
                id,
                &Reply::Control {
                    id,
                    version: PROTOCOL_VERSION,
                    result,
                },
            ),
            Err(message) => error_line(id, message),
        }
    }

    /// Exchange exactly one line with the harness inside the caller's budget.
    fn harness_result(
        &self,
        call: &str,
        input: &Value,
        deadline: Instant,
    ) -> Result<Value, &'static str> {
        let socket = self.harness_socket.clone().ok_or(ERR_SOCKET)?;
        let call = call.to_owned();
        let input = input.clone();

        // The host call bounds the whole exchange; the harness budget stays as
        // an extra cap so a generous caller cannot leave the socket open.
        let cap = Instant::now()
            .checked_add(HARNESS_DEADLINE)
            .ok_or(ERR_TIMEOUT)?;
        let deadline = cap.min(deadline);
        let budget = remaining(deadline)?;

        let handle = Handle::try_current().map_err(|_| ERR_RUNTIME)?;
        let joined = handle.block_on(async move {
            let join = tokio::task::spawn_blocking(move || {
                harness_exchange(&socket, &call, &input, deadline)
            });

            timeout(budget, join).await
        });

        joined.map_err(|_| ERR_TIMEOUT)?.map_err(|_| ERR_IO)?
    }
}

/// One blocking harness exchange.
///
/// Socket waits still carry the remaining budget, but a peer that drips
/// bytes renews them; the outer timeout in `harness_result` is the bound
/// that cannot be reset.
fn harness_exchange(
    socket: &Path,
    call: &str,
    input: &Value,
    deadline: Instant,
) -> Result<Value, &'static str> {
    let outgoing =
        wire::encode_line(&json!({ "call": call, "input": input })).map_err(|_| ERR_FRAME)?;
    let mut stream = connect_bounded(socket, deadline)?;

    stream
        .set_write_timeout(Some(remaining(deadline)?))
        .map_err(|_| ERR_IO)?;
    stream.write_all(&outgoing).map_err(|_| ERR_IO)?;

    let mut reader = BufReader::new(stream);
    reader
        .get_mut()
        .set_read_timeout(Some(remaining(deadline)?))
        .map_err(|_| ERR_IO)?;

    let incoming = match wire::read_line(&mut reader) {
        Ok(Some(line)) => line,
        Ok(None) | Err(WireError::Closed) => return Err(ERR_REPLY),
        Err(WireError::TooLarge) => return Err(ERR_FRAME),
        Err(WireError::Io | WireError::Malformed) => return Err(ERR_TIMEOUT),
    };

    let reply: Value = serde_json::from_slice(&incoming).map_err(|_| ERR_REPLY)?;

    if reply.get("error").is_some() {
        return Err(ERR_HARNESS);
    }

    reply.get("result").cloned().ok_or(ERR_REPLY)
}

impl ControlBrokerTrait for ControlBroker {
    fn try_handle(&self, line: &[u8], deadline: Instant) -> Option<Vec<u8>> {
        Self::try_handle(self, line, deadline)
    }

    fn is_control(&self, line: &[u8]) -> bool {
        Self::is_control(self, line)
    }
}

/// The one wire shape a line must have to be claimed as a control frame.
fn control_probe(probe: &Value) -> bool {
    probe.get("kind").and_then(Value::as_str) == Some("control")
}

/// Connect within what is left of the harness deadline, then hand back a
/// blocking stream. Without a runtime there is no bounded connect to run.
fn connect_bounded(path: &Path, deadline: Instant) -> Result<UnixStream, &'static str> {
    let budget = remaining(deadline)?;
    let handle = Handle::try_current().map_err(|_| ERR_RUNTIME)?;
    let connected = handle.block_on(timeout(budget, AsyncUnixStream::connect(path)));
    let stream = connected
        .map_err(|_| ERR_TIMEOUT)?
        .map_err(|_| ERR_CONNECT)?;
    let stream = stream.into_std().map_err(|_| ERR_CONNECT)?;

    stream.set_nonblocking(false).map_err(|_| ERR_CONNECT)?;

    Ok(stream)
}

fn remaining(deadline: Instant) -> Result<Duration, &'static str> {
    let left = deadline
        .checked_duration_since(Instant::now())
        .ok_or(ERR_TIMEOUT)?;

    if left.is_zero() {
        return Err(ERR_TIMEOUT);
    }

    Ok(left)
}

/// One infallible error frame. `encode_line` could only fail on the short
/// static messages used here, so a fixed fallback keeps the reply total.
fn error_line(id: u64, message: &str) -> Vec<u8> {
    let encoded = serde_json::to_string(message).unwrap_or_else(|_| "\"daemon_error\"".to_owned());

    format!(
        "{{\"kind\":\"error\",\"id\":{id},\"version\":{PROTOCOL_VERSION},\"error\":\"daemon_error\",\"message\":{encoded}}}\n"
    )
    .into_bytes()
}

fn encode_reply(id: u64, reply: &Reply) -> Vec<u8> {
    wire::encode_line(reply).unwrap_or_else(|_| error_line(id, ERR_FRAME))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::BufRead;
    use std::os::unix::net::UnixListener;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::SystemTime;

    use tack_protocol::wire::ReplyError;

    use super::*;

    const HARNESS_REPLY: &str = r#"{"result":{"ok":true}}"#;

    fn control_line(id: u64, version: u32, call: &str, input: Value) -> Vec<u8> {
        wire::encode_line(&Request::Control {
            id,
            version,
            call: call.to_owned(),
            input,
        })
        .unwrap()
    }

    fn reply_from(line: &[u8]) -> Reply {
        serde_json::from_slice(line).unwrap()
    }

    fn test_deadline() -> Instant {
        Instant::now()
            .checked_add(Duration::from_secs(5))
            .expect("the test budget is representable")
    }

    // No wire cap here: the oversize proof needs a frame past the cap.
    fn raw_control_line(id: u64, version: u32, call: &str, input: Value) -> Vec<u8> {
        let mut line = serde_json::to_vec(&Request::Control {
            id,
            version,
            call: call.to_owned(),
            input,
        })
        .unwrap();
        line.push(b'\n');
        line
    }

    fn granted_broker(socket: Option<PathBuf>) -> ControlBroker {
        let grants =
            Grants::from_str(r#"{"grants":{"plugin":{"control":{"calls":["navigate"]}}}}"#)
                .unwrap();
        let identity = LaunchIdentity {
            name: "plugin".to_owned(),
            needs: vec!["control.call.navigate".to_owned()],
        };

        ControlBroker::new(identity, grants, socket)
    }

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let seq = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                % 1_000_000_000;
            let path = std::env::temp_dir()
                .join(format!("tack-control-{}-{nanos}-{seq}", std::process::id()));

            fs::create_dir_all(&path).unwrap();

            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // Check the one forwarded line, then answer with a fixed line.
    fn fake_harness(socket: &Path, reply: &str) -> thread::JoinHandle<()> {
        let listener = UnixListener::bind(socket).unwrap();
        let reply = reply.to_owned();

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();

            reader.read_line(&mut line).unwrap();
            let outgoing: Value = serde_json::from_str(line.trim_end()).unwrap();

            assert_eq!(outgoing["call"].as_str(), Some("navigate"));
            assert_eq!(outgoing["input"], json!({ "target": "demo" }));

            writeln!(stream, "{reply}").unwrap();
        })
    }

    fn error(message: &str) -> Reply {
        Reply::Error {
            id: 1,
            version: PROTOCOL_VERSION,
            error: ReplyError::DaemonError,
            message: message.to_owned(),
        }
    }

    #[test]
    fn a_frame_without_a_grant_gets_the_exact_named_pair() {
        let broker = ControlBroker::new(LaunchIdentity::default(), Grants::default(), None);
        let line = control_line(1, PROTOCOL_VERSION, "navigate", json!({}));

        let reply = reply_from(
            &broker
                .try_handle(&line, test_deadline())
                .expect("a control frame gets a reply"),
        );

        assert_eq!(reply, error("grant_denied"));
    }

    #[test]
    fn a_wrong_version_is_refused_before_authorization() {
        let broker = granted_broker(None);
        let line = control_line(1, PROTOCOL_VERSION.saturating_add(1), "navigate", json!({}));

        let reply = reply_from(
            &broker
                .try_handle(&line, test_deadline())
                .expect("a control frame gets a reply"),
        );

        assert_eq!(reply, error("protocol_version_mismatch"));
    }

    #[test]
    fn an_ordinary_line_is_not_claimed() {
        let broker = granted_broker(None);
        let line = wire::encode_line(&json!({ "kind": "hook", "id": 1 })).unwrap();

        assert_eq!(broker.try_handle(&line, test_deadline()), None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_granted_call_returns_the_harness_result() {
        let dir = TempDir::new();
        let socket = dir.0.join("harness.sock");
        let harness = fake_harness(&socket, HARNESS_REPLY);
        let broker = granted_broker(Some(socket));
        let line = control_line(1, PROTOCOL_VERSION, "navigate", json!({ "target": "demo" }));

        let reply = tokio::task::block_in_place(|| {
            reply_from(
                &broker
                    .try_handle(&line, test_deadline())
                    .expect("a control frame gets a reply"),
            )
        });

        assert_eq!(
            reply,
            Reply::Control {
                id: 1,
                version: PROTOCOL_VERSION,
                result: json!({ "ok": true }),
            }
        );
        harness.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_malformed_harness_reply_is_a_named_error() {
        let dir = TempDir::new();
        let socket = dir.0.join("harness.sock");
        let harness = fake_harness(&socket, "not json");
        let broker = granted_broker(Some(socket));
        let line = control_line(1, PROTOCOL_VERSION, "navigate", json!({ "target": "demo" }));

        let reply = tokio::task::block_in_place(|| {
            reply_from(
                &broker
                    .try_handle(&line, test_deadline())
                    .expect("a control frame gets a reply"),
            )
        });

        assert_eq!(reply, error("harness_malformed_reply"));
        harness.join().unwrap();
    }

    #[test]
    fn an_oversize_control_frame_is_refused_not_ignored() {
        let broker = granted_broker(None);
        let pad = "x".repeat(MAX_FRAME_BYTES);
        let line = raw_control_line(1, PROTOCOL_VERSION, "navigate", json!({ "pad": pad }));

        assert!(line.len() > MAX_FRAME_BYTES);
        assert_eq!(
            reply_from(
                &broker
                    .try_handle(&line, test_deadline())
                    .expect("a control frame gets a reply")
            ),
            error("control_frame_too_large")
        );
    }

    #[test]
    fn an_ordinary_line_is_not_a_control_frame() {
        let broker = granted_broker(None);
        let control = control_line(1, PROTOCOL_VERSION, "navigate", json!({}));
        let ordinary = br#"{"type":"hook","id":22,"outcome":"allow"}"#;

        assert!(broker.is_control(&control));
        assert!(!broker.is_control(ordinary));
    }

    #[test]
    fn a_max_size_control_frame_is_not_rejected_as_too_large() {
        let broker = granted_broker(None);
        let empty = raw_control_line(
            1,
            PROTOCOL_VERSION,
            "navigate",
            Value::String(String::new()),
        );
        let pad = MAX_FRAME_BYTES
            .checked_sub(empty.len())
            .expect("the empty frame fits under the cap");
        let line = raw_control_line(
            1,
            PROTOCOL_VERSION,
            "navigate",
            Value::String("x".repeat(pad)),
        );

        assert_eq!(line.len(), MAX_FRAME_BYTES);
        assert!(broker.is_control(&line));
        assert_eq!(
            reply_from(&broker.try_handle(&line, test_deadline()).unwrap()),
            error("harness_socket_missing")
        );
    }

    #[test]
    fn trait_dispatch_recognizes_control_and_ordinary_lines() {
        let broker: std::sync::Arc<dyn ControlBrokerTrait> =
            std::sync::Arc::new(granted_broker(None));
        let control = control_line(1, PROTOCOL_VERSION, "navigate", json!({}));
        let ordinary = br#"{"type":"hook","id":22,"outcome":"allow"}"#;

        assert!(broker.is_control(&control));
        assert!(!broker.is_control(ordinary));
    }

    #[test]
    fn trait_dispatch_returns_the_named_refusal() {
        let broker: std::sync::Arc<dyn ControlBrokerTrait> = std::sync::Arc::new(
            ControlBroker::new(LaunchIdentity::default(), Grants::default(), None),
        );
        let line = control_line(1, PROTOCOL_VERSION, "navigate", json!({}));

        let reply = broker
            .try_handle(&line, test_deadline())
            .expect("a control frame gets a reply");

        assert_eq!(reply_from(&reply), error("grant_denied"));
    }

    // A harness that reads the call, then drips bytes without ending a line
    // until its own write budget runs out. The caller must not wait for it.
    fn slow_drip_harness(socket: &Path) -> thread::JoinHandle<()> {
        let listener = UnixListener::bind(socket).unwrap();

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();

            for _ in 0..40 {
                if stream.write_all(b"x").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_slow_drip_harness_cannot_outlive_the_budget() {
        let dir = TempDir::new();
        let socket = dir.0.join("harness.sock");
        let harness = slow_drip_harness(&socket);
        let broker = granted_broker(Some(socket));
        let line = control_line(1, PROTOCOL_VERSION, "navigate", json!({ "target": "demo" }));
        let budget = Duration::from_millis(150);
        let deadline = Instant::now()
            .checked_add(budget)
            .expect("the test budget is representable");
        let started = Instant::now();

        let reply = tokio::task::block_in_place(|| {
            reply_from(
                &broker
                    .try_handle(&line, deadline)
                    .expect("a control frame gets a reply"),
            )
        });
        let elapsed = started.elapsed();

        assert_eq!(reply, error("harness_timeout"));
        assert!(elapsed < Duration::from_secs(1));
        harness.join().unwrap();
    }
}
