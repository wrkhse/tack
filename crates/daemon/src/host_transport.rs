//! The real Unix-socket host transport.
//!
//! tack authenticates once on barn's `host.sock` with `host.start`, then
//! sends one framed line per call and reads one line back. A failed handshake
//! latches the transport: no boundary failure is ever retried or turned into
//! an allow.

use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::{SocketAddr, UnixStream};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use barn_stall::{
    DEFAULT_MAX_BODY_BYTES, DENIED_CODE, HostStartParams, HostStartResult, MAX_LINE_BYTES,
    PROTOCOL_VERSION, deny, method,
};
use serde_json::Value;

use crate::stall::{StallError, Transport};

/// The two plain values barn supplies at stall start: the path of its host
/// socket and the single-use token tack authenticates with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostEndpoint {
    pub socket_path: PathBuf,
    pub token: String,
}

impl HostEndpoint {
    /// Bind an endpoint to a host socket path and its start token.
    #[must_use]
    pub const fn new(socket_path: PathBuf, token: String) -> Self {
        Self { socket_path, token }
    }
}

/// The id tack puts on its one `host.start` line.
const HOST_START_ID: u64 = 21;

/// One authenticated connection to a stall, or the reason it cannot be used.
pub struct HostTransport {
    endpoint: HostEndpoint,
    stream: Option<BufReader<UnixStream>>,
    next_id: u64,
    failed: bool,
}

impl HostTransport {
    /// Build a transport for the endpoint barn supplied at stall start.
    #[must_use]
    pub const fn new(endpoint: HostEndpoint) -> Self {
        Self {
            endpoint,
            stream: None,
            next_id: HOST_START_ID,
            failed: false,
        }
    }

    /// Connect and finish the single `host.start` exchange.
    ///
    /// The reader is kept only once barn has answered with a matching id and a
    /// stall name. Every failure leaves the transport latched instead.
    fn handshake(&mut self, deadline: Instant) -> Result<(), StallError> {
        let timeout = remaining(deadline)?;
        let address = SocketAddr::from_pathname(&self.endpoint.socket_path)
            .map_err(|error| StallError::Io(format!("host socket address: {error}")))?;
        let connected = UnixStream::connect_addr(&address)
            .map_err(|error| StallError::Io(format!("connecting to host socket: {error}")))?;
        let mut reader = BufReader::new(connected);
        set_timeouts(reader.get_mut(), timeout)?;

        let id = self.next_id;
        self.next_id = id
            .checked_add(1)
            .ok_or_else(|| StallError::Io("host request id exhausted".into()))?;

        let request = host_start_line(id, &self.endpoint.token)?;
        check_line_len(request.len())?;
        write_line(reader.get_mut(), &request)?;

        let mut reply = Vec::new();
        read_line(&mut reader, &mut reply)?;
        let stall = host_start_stall(&reply, id)?;

        if stall.is_empty() {
            return Err(StallError::Malformed);
        }

        self.stream = Some(reader);

        Ok(())
    }
}

impl Transport for HostTransport {
    /// Send one framed line and return its single-line reply before `deadline`.
    ///
    /// # Errors
    ///
    /// Returns a named `StallError` for an oversize frame or reply, a timeout,
    /// a closed socket, a malformed reply, or a denial carrying barn's named
    /// reason. A failed handshake is never retried.
    fn call(&mut self, frame: &str, deadline: Instant) -> Result<String, StallError> {
        if self.failed {
            return Err(StallError::Io("host handshake failed; no retry".into()));
        }

        let mut request = String::with_capacity(frame.len().saturating_add(1));
        request.push_str(frame);
        request.push('\n');

        check_line_len(request.len())?;
        body_within_cap(&request)?;

        if self.stream.is_none()
            && let Err(error) = self.handshake(deadline)
        {
            self.failed = true;

            return Err(error);
        }

        let reader = self.stream.as_mut().ok_or(StallError::Malformed)?;
        let timeout = remaining(deadline)?;
        set_timeouts(reader.get_mut(), timeout)?;
        write_line(reader.get_mut(), &request)?;

        let mut reply = Vec::new();
        read_line(reader, &mut reply)?;
        check_line_len(reply.len())?;
        body_within_cap(std::str::from_utf8(&reply).map_err(|_| StallError::Malformed)?)?;

        let text = std::str::from_utf8(&reply).map_err(|_| StallError::Malformed)?;
        let answer = text.strip_suffix('\n').unwrap_or(text);
        refused_frame(answer)?;

        Ok(answer.to_owned())
    }
}

/// Time left before `deadline`, rejected once none remains.
fn remaining(deadline: Instant) -> Result<Duration, StallError> {
    let left = deadline
        .checked_duration_since(Instant::now())
        .ok_or(StallError::Timeout)?;

    if left.is_zero() {
        return Err(StallError::Timeout);
    }

    Ok(left)
}

fn set_timeouts(stream: &UnixStream, timeout: Duration) -> Result<(), StallError> {
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| StallError::Io(format!("host read timeout: {error}")))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| StallError::Io(format!("host write timeout: {error}")))?;

    Ok(())
}

/// The exact `host.start` line, with the daemon's pid and the injected id.
fn host_start_line(id: u64, token: &str) -> Result<String, StallError> {
    let params = HostStartParams {
        protocol: PROTOCOL_VERSION,
        token: token.to_owned(),
        pid: std::process::id(),
    };
    let params = serde_json::to_string(&params)
        .map_err(|error| StallError::Io(format!("encoding host.start: {error}")))?;
    let method_name = method::HOST_START;

    Ok(format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":{method_name:?},\"params\":{params}}}}}\n"
    ))
}

/// Accept only a version 2.0 reply with the request's id and a `result.stall`.
fn host_start_stall(line: &[u8], id: u64) -> Result<String, StallError> {
    let text = std::str::from_utf8(line).map_err(|_| StallError::Malformed)?;

    if text.lines().count() != 1 {
        return Err(StallError::Malformed);
    }

    let message: Value = serde_json::from_str(text).map_err(|_| StallError::Malformed)?;

    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || message.get("id").and_then(Value::as_u64) != Some(id)
    {
        return Err(StallError::Malformed);
    }

    if let Some(error) = message.get("error") {
        return Err(host_error(error));
    }

    let result = message.get("result").ok_or(StallError::Malformed)?;
    let decoded: HostStartResult =
        serde_json::from_value(result.clone()).map_err(|_| StallError::Malformed)?;

    Ok(decoded.stall)
}

/// Turn a JSON-RPC error into a named failure that keeps barn's reason.
fn host_error(error: &Value) -> StallError {
    if error.get("message").and_then(Value::as_str) != Some("denied")
        || error.get("code").and_then(Value::as_i64) != Some(i64::from(DENIED_CODE))
    {
        return StallError::Io("host.start returned an unknown error".into());
    }

    error
        .get("data")
        .and_then(|data| data.get("reason"))
        .and_then(Value::as_str)
        .map_or(StallError::Malformed, denied)
}

/// Preserve each named denial reason in the error's text; never allow.
fn denied(reason: &str) -> StallError {
    match reason {
        deny::WRONG_PEER_PID
        | deny::WRONG_PEER_UID
        | deny::TOKEN_EXPIRED_OR_SPENT
        | deny::TOKEN_MISMATCH
        | deny::PROTOCOL_MISMATCH
        | deny::OVERSIZE_FRAME
        | deny::CLOSED_SOCKET => StallError::Io(format!("host.start denied: {reason}")),
        other => StallError::Io(format!("host.start denied: unknown reason {other}")),
    }
}

/// A framed line, newline included, must fit the protocol's line cap.
fn check_line_len(length: usize) -> Result<(), StallError> {
    if length > MAX_LINE_BYTES {
        return Err(StallError::Io(format!(
            "line exceeds {MAX_LINE_BYTES} bytes"
        )));
    }

    Ok(())
}

/// Framed lines carry bodies inline; no body may pass the 4 MiB cap.
fn body_within_cap(line: &str) -> Result<(), StallError> {
    let message: Value = serde_json::from_str(line).map_err(|_| StallError::Malformed)?;
    let body = message
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default();

    if body.len() > DEFAULT_MAX_BODY_BYTES {
        return Err(StallError::Io(format!(
            "body exceeds {DEFAULT_MAX_BODY_BYTES} bytes"
        )));
    }

    Ok(())
}

/// Read one bounded line without consuming bytes past its newline.
fn read_line<R: BufRead>(reader: &mut R, into: &mut Vec<u8>) -> Result<(), StallError> {
    into.clear();

    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(read_error(&error)),
        };

        if available.is_empty() {
            return Err(StallError::Closed);
        }

        if let Some(position) = available.iter().position(|byte| *byte == b'\n') {
            let end = position.saturating_add(1);
            let total = into.len().saturating_add(end);
            check_line_len(total)?;
            let bytes = available.get(..end).ok_or(StallError::Malformed)?;

            into.extend_from_slice(bytes);
            reader.consume(end);

            return Ok(());
        }

        let total = into.len().saturating_add(available.len());

        if total >= MAX_LINE_BYTES {
            return Err(StallError::Io(format!(
                "line exceeds {MAX_LINE_BYTES} bytes"
            )));
        }

        into.extend_from_slice(available);
        let consumed = available.len();
        reader.consume(consumed);
    }
}

fn read_error(error: &io::Error) -> StallError {
    match error.kind() {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => StallError::Timeout,
        io::ErrorKind::UnexpectedEof
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::BrokenPipe => StallError::Closed,
        _ => StallError::Io(format!("reading host socket: {error}")),
    }
}

fn write_line(stream: &mut UnixStream, line: &str) -> Result<(), StallError> {
    stream
        .write_all(line.as_bytes())
        .map_err(|error| StallError::Io(format!("writing host socket: {error}")))?;
    stream
        .flush()
        .map_err(|error| StallError::Io(format!("flushing host socket: {error}")))?;

    Ok(())
}

/// A framed reply carrying a denial is a failure, never a pass-through allow.
fn refused_frame(answer: &str) -> Result<(), StallError> {
    let message: Value = match serde_json::from_str(answer) {
        Ok(message) => message,
        Err(_) => return Err(StallError::Malformed),
    };
    let Some(error) = message.get("error") else {
        return Ok(());
    };

    if error.get("code").and_then(Value::as_i64) == Some(i64::from(DENIED_CODE)) {
        return Err(host_error(error));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Cursor;
    use std::os::unix::net::UnixListener;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use super::*;

    const TOKEN: &str = "single-use-token";
    const START_REPLY: &str = r#"{"jsonrpc":"2.0","id":21,"result":{"stall":"sourcefed"}}"#;
    const CALL_FRAME: &str = r#"{"jsonrpc":"2.0","id":22,"method":"stall.call","params":{}}"#;
    const CALL_REPLY: &str = r#"{"jsonrpc":"2.0","id":22,"result":{"ok":true}}"#;

    fn wire(message: &Value) -> Vec<u8> {
        let mut line = message.to_string().into_bytes();
        line.push(b'\n');

        line
    }

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
            let path = std::env::temp_dir()
                .join(format!("tack-host-{}-{nanos}-{seq}", std::process::id()));

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

    // A one-shot fake host: check the start line, answer it, then answer the
    // framed call made on the same connection.
    fn fake_host(socket: &Path, reply: &'static str) -> thread::JoinHandle<()> {
        let listener = UnixListener::bind(socket).unwrap();

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();

            reader.read_line(&mut line).unwrap();
            let start: Value = serde_json::from_str(line.trim_end()).unwrap();

            assert_eq!(start["jsonrpc"].as_str(), Some("2.0"));
            assert_eq!(start["id"].as_u64(), Some(HOST_START_ID));
            assert_eq!(start["method"].as_str(), Some(method::HOST_START));
            assert_eq!(
                start["params"]["pid"].as_u64(),
                Some(u64::from(std::process::id()))
            );
            assert_eq!(start["params"]["token"].as_str(), Some(TOKEN));

            writeln!(stream, "{START_REPLY}").unwrap();

            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            assert_eq!(request.trim_end(), CALL_FRAME);

            writeln!(stream, "{reply}").unwrap();
        })
    }

    #[test]
    fn host_start_line_is_exact() {
        let expected = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":21,\"method\":\"host.start\",\
             \"params\":{{\"protocol\":1,\"token\":\"{TOKEN}\",\
             \"pid\":{}}}}}\n",
            std::process::id()
        );

        assert_eq!(host_start_line(HOST_START_ID, TOKEN), Ok(expected));
    }

    #[test]
    fn each_named_denial_keeps_its_reason() {
        for reason in [
            deny::WRONG_PEER_PID,
            deny::WRONG_PEER_UID,
            deny::TOKEN_EXPIRED_OR_SPENT,
            deny::TOKEN_MISMATCH,
            deny::PROTOCOL_MISMATCH,
            deny::OVERSIZE_FRAME,
            deny::CLOSED_SOCKET,
        ] {
            let line = wire(&json!({
                "jsonrpc": "2.0",
                "id": HOST_START_ID,
                "error": {
                    "code": DENIED_CODE,
                    "message": "denied",
                    "data": { "reason": reason },
                },
            }));

            assert_eq!(
                host_start_stall(&line, HOST_START_ID),
                Err(StallError::Io(format!("host.start denied: {reason}")))
            );
        }
    }

    #[test]
    fn oversize_reply_line_is_rejected() {
        let mut bytes = vec![b'x'; MAX_LINE_BYTES];
        bytes.push(b'\n');
        let mut reader = Cursor::new(bytes);
        let mut line = Vec::new();

        assert_eq!(
            read_line(&mut reader, &mut line),
            Err(StallError::Io(format!(
                "line exceeds {MAX_LINE_BYTES} bytes"
            )))
        );
    }

    #[test]
    fn oversize_frame_is_rejected() {
        let frame = "x".repeat(MAX_LINE_BYTES);

        assert_eq!(
            check_line_len(frame.len().saturating_add(1)),
            Err(StallError::Io(format!(
                "line exceeds {MAX_LINE_BYTES} bytes"
            )))
        );
    }

    #[test]
    fn missing_result_is_rejected() {
        let line = wire(&json!({ "jsonrpc": "2.0", "id": HOST_START_ID }));

        assert_eq!(
            host_start_stall(&line, HOST_START_ID),
            Err(StallError::Malformed)
        );
    }

    #[test]
    fn a_mismatched_id_is_not_accepted() {
        let line = wire(&json!({
            "jsonrpc": "2.0",
            "id": HOST_START_ID.saturating_add(1),
            "result": { "stall": "sourcefed" },
        }));

        assert_eq!(
            host_start_stall(&line, HOST_START_ID),
            Err(StallError::Malformed)
        );
    }

    #[test]
    fn a_matching_result_yields_the_stall_name() {
        let line = wire(&json!({
            "jsonrpc": "2.0",
            "id": HOST_START_ID,
            "result": { "stall": "sourcefed" },
        }));

        assert_eq!(
            host_start_stall(&line, HOST_START_ID),
            Ok("sourcefed".to_owned())
        );
    }

    #[test]
    fn a_call_uses_the_fake_host_endpoint() {
        let dir = TempDir::new();
        let socket = dir.path().join("host.sock");
        let host = fake_host(&socket, CALL_REPLY);

        let endpoint = HostEndpoint::new(socket, TOKEN.to_owned());
        let mut transport = HostTransport::new(endpoint);
        let deadline = Instant::now() + Duration::from_secs(5);

        assert_eq!(
            transport.call(CALL_FRAME, deadline),
            Ok(CALL_REPLY.to_owned())
        );
        host.join().unwrap();
    }
}
