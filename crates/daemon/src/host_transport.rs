//! The real Unix-socket host transport.
//!
//! tack authenticates once on barn's `host.sock` with `host.start`, then
//! sends one framed line per call and reads one line back. A failed handshake
//! latches the transport: no boundary failure is ever retried or turned into
//! an allow.

use std::fmt;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use barn_stall::{
    DEFAULT_MAX_BODY_BYTES, DENIED_CODE, HostStartParams, HostStartResult, MAX_LINE_BYTES,
    PROTOCOL_VERSION, deny, method,
};
use serde_json::Value;
use tokio::net::UnixStream as AsyncUnixStream;
use tokio::runtime::Handle;
use tokio::time::timeout;

use crate::stall::{StallError, Transport};

/// The two plain values barn supplies at stall start: the path of its host
/// socket and the single-use token tack authenticates with.
#[derive(Clone, PartialEq, Eq)]
pub struct HostEndpoint {
    pub socket_path: PathBuf,
    pub token: String,
}

impl fmt::Debug for HostEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostEndpoint")
            .field("socket_path", &self.socket_path)
            .field("token", &"[redacted]")
            .finish()
    }
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

    /// Run one validated call on the connection, opening it on first use.
    fn call_once(&mut self, request: &str, deadline: Instant) -> Result<String, StallError> {
        let id = request_id(request)?;

        if self.stream.is_none() {
            self.handshake(deadline)?;
        }

        let reader = self.stream.as_mut().ok_or(StallError::Malformed)?;
        let timeout = remaining(deadline)?;
        set_timeouts(reader.get_mut(), timeout)?;
        write_line(reader.get_mut(), request, deadline)?;

        let mut reply = Vec::new();
        read_line(reader, &mut reply, deadline)?;
        check_line_len(reply.len())?;
        let text = std::str::from_utf8(&reply).map_err(|_| StallError::Malformed)?;
        body_within_cap(text)?;
        let answer = text.strip_suffix('\n').unwrap_or(text);
        refused_frame(answer, id)?;

        Ok(answer.to_owned())
    }

    /// Connect and finish the single `host.start` exchange.
    ///
    /// The reader is kept only once barn has answered with a matching id and a
    /// stall name. `call` latches the transport on any failure.
    fn handshake(&mut self, deadline: Instant) -> Result<(), StallError> {
        let connect_budget = remaining(deadline)?;
        let connected = connect_bounded(&self.endpoint.socket_path, connect_budget)?;
        let mut reader = BufReader::new(connected);

        // The exchange after the connect gets a budget measured from now, so a
        // slow connect cannot consume the whole deadline silently.
        let io_budget = remaining(deadline)?;
        set_timeouts(reader.get_mut(), io_budget)?;

        let id = self.next_id;
        self.next_id = id
            .checked_add(1)
            .ok_or_else(|| StallError::Io("host request id exhausted".into()))?;

        let request = host_start_line(id, &self.endpoint.token)?;
        check_line_len(request.len())?;
        write_line(reader.get_mut(), &request, deadline)?;

        let mut reply = Vec::new();
        read_line(&mut reader, &mut reply, deadline)?;
        let stall = host_start_stall(&reply, id)?;

        if stall.is_empty() {
            return Err(StallError::Malformed);
        }

        self.stream = Some(reader);

        Ok(())
    }
}

/// Connect within `budget` on the current tokio runtime, then return a
/// blocking std stream. Without a runtime there is no bounded connect to run,
/// so the failure is named instead of blocking the caller.
fn connect_bounded(path: &Path, budget: Duration) -> Result<UnixStream, StallError> {
    let handle = Handle::try_current()
        .map_err(|_| StallError::Io("host connect needs a tokio runtime".into()))?;

    let connected =
        handle.block_on(async { timeout(budget, AsyncUnixStream::connect(path)).await });

    let stream = connected.map_err(|_| StallError::Timeout)?;
    let stream = stream
        .map_err(|error| StallError::Io(format!("connecting to host socket: {error}")))?
        .into_std()
        .map_err(|error| StallError::Io(format!("host socket conversion: {error}")))?;

    stream
        .set_nonblocking(false)
        .map_err(|error| StallError::Io(format!("host socket blocking mode: {error}")))?;

    Ok(stream)
}

impl Transport for HostTransport {
    /// Send one framed line and return its single-line reply before `deadline`.
    ///
    /// Local frame checks run before the latching boundary: an oversize line
    /// or body returns its named error and leaves the connection usable. A
    /// handshake, connect, or socket I/O failure latches the transport: the
    /// socket is dropped and no later call reconnects or reuses it.
    ///
    /// # Errors
    ///
    /// Returns a named `StallError` for an oversize frame or reply, a timeout,
    /// a closed socket, a malformed reply, or a denial carrying barn's named
    /// reason. Once latched, every call returns the no-retry error.
    fn call(&mut self, frame: &str, deadline: Instant) -> Result<String, StallError> {
        if self.failed {
            return Err(StallError::Io("host handshake failed; no retry".into()));
        }

        let mut request = String::with_capacity(frame.len().saturating_add(1));
        request.push_str(frame);
        request.push('\n');

        check_line_len(request.len())?;
        body_within_cap(&request)?;

        match self.call_once(&request, deadline) {
            Ok(answer) => Ok(answer),
            Err(error) => {
                self.failed = true;
                drop(self.stream.take());

                Err(error)
            }
        }
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

/// The two blocking waits a host socket applies to each exchange.
trait SocketTimeouts {
    fn set_read_timeout(&mut self, timeout: Duration) -> Result<(), StallError>;
    fn set_write_timeout(&mut self, timeout: Duration) -> Result<(), StallError>;
}

impl SocketTimeouts for UnixStream {
    fn set_read_timeout(&mut self, timeout: Duration) -> Result<(), StallError> {
        Self::set_read_timeout(self, Some(timeout))
            .map_err(|error| StallError::Io(format!("host read timeout: {error}")))
    }

    fn set_write_timeout(&mut self, timeout: Duration) -> Result<(), StallError> {
        Self::set_write_timeout(self, Some(timeout))
            .map_err(|error| StallError::Io(format!("host write timeout: {error}")))
    }
}

fn set_timeouts<S: SocketTimeouts>(stream: &mut S, timeout: Duration) -> Result<(), StallError> {
    stream.set_read_timeout(timeout)?;
    stream.set_write_timeout(timeout)?;

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
        "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":{method_name:?},\"params\":{params}}}\n"
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
    if error.get("message").and_then(Value::as_str) == Some("denied")
        && error.get("code").and_then(Value::as_i64) == Some(i64::from(DENIED_CODE))
    {
        return error
            .get("data")
            .and_then(|data| data.get("reason"))
            .and_then(Value::as_str)
            .map_or(StallError::Malformed, denied);
    }

    unknown_error(error)
}

/// Name a non-denial error by its code and message, never as an answer.
fn unknown_error(error: &Value) -> StallError {
    let code = error.get("code").and_then(Value::as_i64);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("missing message");

    code.map_or_else(
        || StallError::Io(format!("host error: {message}")),
        |code| StallError::Io(format!("host error {code}: {message}")),
    )
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
    let bodies = [
        message.get("body"),
        message.get("call").and_then(|call| call.get("input")),
        message.get("result"),
        message.get("result").and_then(|result| result.get("body")),
    ];

    for body in bodies.into_iter().flatten() {
        if serialized_len(body)? > DEFAULT_MAX_BODY_BYTES {
            return Err(StallError::Io(format!(
                "body exceeds {DEFAULT_MAX_BODY_BYTES} bytes"
            )));
        }
    }

    Ok(())
}

/// Measure a body's serialized JSON, whatever shape its value has.
fn serialized_len(body: &Value) -> Result<usize, StallError> {
    let encoded = serde_json::to_string(body)
        .map_err(|error| StallError::Io(format!("encoding body: {error}")))?;

    Ok(encoded.len())
}

/// A reader whose blocking waits can be capped to the time left in a call.
trait ReadTimeout {
    fn set_read_timeout(&mut self, timeout: Duration) -> Result<(), StallError>;
}

impl<S: Read + SocketTimeouts> ReadTimeout for BufReader<S> {
    fn set_read_timeout(&mut self, timeout: Duration) -> Result<(), StallError> {
        SocketTimeouts::set_read_timeout(self.get_mut(), timeout)
    }
}

/// Read one bounded line without consuming bytes past its newline. The wait
/// for each chunk is capped by the time left in the whole call, so a peer that
/// drips bytes cannot outlive the deadline.
fn read_line<R: BufRead + ReadTimeout>(
    reader: &mut R,
    into: &mut Vec<u8>,
    deadline: Instant,
) -> Result<(), StallError> {
    into.clear();

    loop {
        reader.set_read_timeout(remaining(deadline)?)?;

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

/// Write one whole line inside the call's deadline. Every chunk gets a write
/// timeout sized to the time left, so a slow-draining host cannot hold the
/// caller past the deadline.
fn write_line<S: Write + SocketTimeouts>(
    stream: &mut S,
    line: &str,
    deadline: Instant,
) -> Result<(), StallError> {
    let bytes = line.as_bytes();
    let mut written = 0;

    while written < bytes.len() {
        SocketTimeouts::set_write_timeout(stream, remaining(deadline)?)?;

        let chunk = bytes.get(written..).ok_or(StallError::Malformed)?;
        let count = match stream.write(chunk) {
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(write_error(&error)),
        };

        if count == 0 {
            return Err(StallError::Closed);
        }

        written = written.saturating_add(count);
    }

    Ok(())
}

fn write_error(error: &io::Error) -> StallError {
    match error.kind() {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => StallError::Timeout,
        _ => StallError::Io(format!("writing host socket: {error}")),
    }
}

/// The id a framed request expects on its reply. Requests are checked before
/// this point, so an unreadable id is a boundary failure.
fn request_id(request: &str) -> Result<u64, StallError> {
    let message: Value = serde_json::from_str(request).map_err(|_| StallError::Malformed)?;

    message
        .get("id")
        .and_then(Value::as_u64)
        .ok_or(StallError::Malformed)
}

/// A reply succeeds only with the request's id and an explicit `result`. An
/// error reply keeps its named failure, never a pass-through allow.
fn refused_frame(answer: &str, id: u64) -> Result<(), StallError> {
    let message: Value = match serde_json::from_str(answer) {
        Ok(message) => message,
        Err(_) => return Err(StallError::Malformed),
    };

    if message.get("id").and_then(Value::as_u64) != Some(id) {
        return Err(StallError::Malformed);
    }

    if let Some(error) = message.get("error") {
        return Err(host_error(error));
    }

    if message.get("result").is_none() {
        return Err(StallError::Malformed);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Cursor;
    use std::io::Read;
    use std::os::unix::net::UnixListener;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use super::*;

    const TOKEN: &str = "single-use-token";
    const START_REPLY: &str = r#"{"jsonrpc":"2.0","id":21,"result":{"stall":"sourcefed"}}"#;
    const BAD_START_REPLY: &str = r#"{"jsonrpc":"2.0","id":99,"result":{"stall":"sourcefed"}}"#;
    const CALL_FRAME: &str = r#"{"jsonrpc":"2.0","id":22,"method":"stall.call","params":{}}"#;
    const CALL_REPLY: &str = r#"{"jsonrpc":"2.0","id":22,"result":{"ok":true}}"#;

    fn wire(message: &Value) -> Vec<u8> {
        let mut line = message.to_string().into_bytes();
        line.push(b'\n');

        line
    }

    impl ReadTimeout for Cursor<Vec<u8>> {
        fn set_read_timeout(&mut self, _timeout: Duration) -> Result<(), StallError> {
            Ok(())
        }
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
    fn fake_host(socket: &Path, reply: impl Into<String>) -> thread::JoinHandle<()> {
        let reply = reply.into();
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
    fn host_endpoint_debug_hides_the_token_but_shows_the_path() {
        let path = "/tmp/tack-host-redaction.sock";
        let endpoint = HostEndpoint::new(PathBuf::from(path), TOKEN.to_owned());

        let debug = format!("{endpoint:?}");

        assert!(!debug.contains(TOKEN));
        assert!(debug.contains(path));
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
        let deadline = Instant::now() + Duration::from_secs(5);

        assert_eq!(
            read_line(&mut reader, &mut line, deadline),
            Err(StallError::Io(format!(
                "line exceeds {MAX_LINE_BYTES} bytes"
            )))
        );
    }

    // A peer that hands out one byte per fill, pausing long enough that more
    // bytes remain when the deadline expires. Each fill records the timeout
    // it was given.
    struct DripReader {
        bytes: Vec<u8>,
        index: usize,
        timeouts: Vec<Duration>,
    }

    impl DripReader {
        fn new(bytes: Vec<u8>) -> Self {
            Self {
                bytes,
                index: 0,
                timeouts: Vec::new(),
            }
        }
    }

    impl ReadTimeout for DripReader {
        fn set_read_timeout(&mut self, timeout: Duration) -> Result<(), StallError> {
            self.timeouts.push(timeout);

            Ok(())
        }
    }

    impl Read for DripReader {
        fn read(&mut self, _into: &mut [u8]) -> io::Result<usize> {
            Ok(0)
        }
    }

    impl BufRead for DripReader {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            if self.index >= self.bytes.len() {
                return Err(io::ErrorKind::WouldBlock.into());
            }

            thread::sleep(Duration::from_millis(200));

            Ok(&self.bytes[self.index..self.index.saturating_add(1)])
        }

        fn consume(&mut self, amount: usize) {
            self.index = self.index.saturating_add(amount);
        }
    }

    fn drip_deadline_proof() {
        let started = Instant::now();
        let deadline = started
            .checked_add(Duration::from_secs(1))
            .unwrap_or(started);
        let upper = Duration::from_secs(3);
        let mut reader = DripReader::new(vec![b'x'; 20]);
        let mut line = Vec::new();

        let outcome = read_line(&mut reader, &mut line, deadline);
        let elapsed = started.elapsed();

        assert_eq!(outcome, Err(StallError::Timeout));
        assert!(elapsed >= Duration::from_secs(1));
        assert!(elapsed < upper);
        assert!(reader.timeouts.len() >= 2);
        assert!(
            reader
                .timeouts
                .iter()
                .all(|applied| !applied.is_zero() && *applied <= Duration::from_secs(1))
        );
        assert!(reader.timeouts.windows(2).all(|pair| pair[1] < pair[0]));
    }

    #[test]
    fn a_dripping_peer_cannot_outlive_the_deadline() {
        drip_deadline_proof();
    }

    // A socket stand-in that records every timeout the transport applies.
    struct RecordingSocket {
        waits: Vec<(bool, Duration)>,
    }

    impl RecordingSocket {
        fn new() -> Self {
            Self { waits: Vec::new() }
        }
    }

    impl Read for RecordingSocket {
        fn read(&mut self, _into: &mut [u8]) -> io::Result<usize> {
            Ok(0)
        }
    }

    impl SocketTimeouts for RecordingSocket {
        fn set_read_timeout(&mut self, timeout: Duration) -> Result<(), StallError> {
            self.waits.push((true, timeout));

            Ok(())
        }

        fn set_write_timeout(&mut self, timeout: Duration) -> Result<(), StallError> {
            self.waits.push((false, timeout));

            Ok(())
        }
    }

    #[test]
    fn both_socket_waits_are_bounded_on_every_exchange() {
        let timeout = Duration::from_secs(3);
        let mut reader = BufReader::new(RecordingSocket::new());

        set_timeouts(reader.get_mut(), timeout).unwrap();
        ReadTimeout::set_read_timeout(&mut reader, timeout).unwrap();

        assert_eq!(
            reader.get_mut().waits,
            vec![(true, timeout), (false, timeout), (true, timeout)]
        );
        assert!(
            reader
                .get_mut()
                .waits
                .iter()
                .all(|(_, applied)| !applied.is_zero())
        );
    }

    #[test]
    fn set_timeouts_applies_both_waits_to_a_real_socket() {
        let (_peer, mut client) = UnixStream::pair().unwrap();
        let timeout = Duration::from_millis(50);

        set_timeouts(&mut client, timeout).unwrap();

        assert_eq!(client.read_timeout().unwrap(), Some(timeout));
        assert_eq!(client.write_timeout().unwrap(), Some(timeout));
    }

    #[test]
    fn a_real_socket_read_obeys_the_configured_timeout() {
        let (peer, mut client) = UnixStream::pair().unwrap();
        set_timeouts(&mut client, Duration::from_millis(50)).unwrap();

        let (release_tx, release_rx) = mpsc::channel();
        let holder = thread::spawn(move || {
            let _ = release_rx.recv();
            drop(peer);
        });

        let (result_tx, result_rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut byte = [0u8; 1];
            let outcome = client.read(&mut byte).map_err(|error| read_error(&error));
            let _ = result_tx.send(outcome);
        });

        let outcome = result_rx.recv_timeout(Duration::from_secs(5));

        let _ = release_tx.send(());
        holder.join().unwrap();
        let _ = reader.join();

        assert_eq!(outcome, Ok(Err(StallError::Timeout)));
    }

    fn write_timeout_proof() {
        let (peer, client) = UnixStream::pair().unwrap();
        let (hold_tx, hold_rx) = mpsc::channel();
        let holder = thread::spawn(move || {
            let _ = hold_rx.recv();
            drop(peer);
        });

        let endpoint = HostEndpoint::new(PathBuf::from("unused.sock"), TOKEN.to_owned());
        let mut transport = HostTransport::new(endpoint);
        transport.stream = Some(BufReader::new(client));

        let frame = json!({
            "jsonrpc": "2.0",
            "id": 22,
            "method": "stall.call",
            "params": { "pad": "x".repeat(DEFAULT_MAX_BODY_BYTES) },
        })
        .to_string();
        let started = Instant::now();
        let deadline = started
            .checked_add(Duration::from_millis(250))
            .unwrap_or(started);
        // A 2 s wait separates the supplied 250 ms deadline from the old
        // 5 s single socket timeout, without matching 250 ms tightly.
        let upper = Duration::from_secs(2);

        let (result_tx, result_rx) = mpsc::channel();
        let caller = thread::spawn(move || {
            let outcome = transport.call(&frame, deadline);
            let _ = result_tx.send(outcome);
        });

        let outcome = result_rx.recv_timeout(upper);
        let elapsed = started.elapsed();

        let _ = hold_tx.send(());
        holder.join().unwrap();
        caller.join().unwrap();

        assert_eq!(outcome, Ok(Err(StallError::Timeout)));
        assert!(elapsed >= Duration::from_millis(250));
        assert!(elapsed < upper);
    }

    #[test]
    fn a_write_that_cannot_finish_returns_timeout() {
        write_timeout_proof();
    }

    #[test]
    #[ignore = "run in CI"]
    fn timing_proofs_hold_across_fifty_runs_in_ci() {
        for _ in 0..50 {
            write_timeout_proof();
            drip_deadline_proof();
        }
    }

    // A writer that pauses briefly, fails its first write with a scripted
    // kind, records each deadline-derived write timeout, then accepts the
    // rest of the line.
    struct FailingWriter {
        written: Vec<u8>,
        first_error: Option<io::ErrorKind>,
        timeouts: Vec<Duration>,
    }

    impl FailingWriter {
        fn new(first_error: io::ErrorKind) -> Self {
            Self {
                written: Vec::new(),
                first_error: Some(first_error),
                timeouts: Vec::new(),
            }
        }
    }

    impl Write for FailingWriter {
        fn write(&mut self, chunk: &[u8]) -> io::Result<usize> {
            if let Some(kind) = self.first_error.take() {
                thread::sleep(Duration::from_millis(10));

                return Err(kind.into());
            }

            self.written.extend_from_slice(chunk);

            Ok(chunk.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl SocketTimeouts for FailingWriter {
        fn set_read_timeout(&mut self, _timeout: Duration) -> Result<(), StallError> {
            Ok(())
        }

        fn set_write_timeout(&mut self, timeout: Duration) -> Result<(), StallError> {
            self.timeouts.push(timeout);

            Ok(())
        }
    }

    #[test]
    fn an_interrupted_write_is_retried_with_a_fresh_deadline_budget() {
        let line = "{\"jsonrpc\":\"2.0\",\"id\":22,\"result\":{}}\n";
        let mut writer = FailingWriter::new(io::ErrorKind::Interrupted);
        let deadline = Instant::now() + Duration::from_secs(5);

        assert_eq!(write_line(&mut writer, line, deadline), Ok(()));
        assert_eq!(writer.written.as_slice(), line.as_bytes());
        assert_eq!(writer.timeouts.len(), 2);
        assert!(
            writer
                .timeouts
                .iter()
                .all(|applied| !applied.is_zero() && *applied <= Duration::from_secs(5))
        );
        assert!(writer.timeouts.windows(2).all(|pair| pair[1] < pair[0]));
    }

    #[test]
    fn a_timed_out_write_is_a_named_timeout() {
        let line = "call\n";
        let mut writer = FailingWriter::new(io::ErrorKind::TimedOut);
        let deadline = Instant::now() + Duration::from_secs(5);

        assert_eq!(
            write_line(&mut writer, line, deadline),
            Err(StallError::Timeout)
        );
    }

    #[test]
    fn a_would_block_write_is_a_named_timeout() {
        let line = "call\n";
        let mut writer = FailingWriter::new(io::ErrorKind::WouldBlock);
        let deadline = Instant::now() + Duration::from_secs(5);

        assert_eq!(
            write_line(&mut writer, line, deadline),
            Err(StallError::Timeout)
        );
    }

    // A reader that fails one fill with Interrupted, then yields a full line.
    struct InterruptedOnce {
        remaining: Cursor<Vec<u8>>,
        interrupted: bool,
    }

    impl InterruptedOnce {
        fn new(bytes: Vec<u8>) -> Self {
            Self {
                remaining: Cursor::new(bytes),
                interrupted: false,
            }
        }
    }

    impl ReadTimeout for InterruptedOnce {
        fn set_read_timeout(&mut self, _timeout: Duration) -> Result<(), StallError> {
            Ok(())
        }
    }

    impl Read for InterruptedOnce {
        fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
            self.remaining.read(into)
        }
    }

    impl BufRead for InterruptedOnce {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            if !self.interrupted {
                self.interrupted = true;

                return Err(io::ErrorKind::Interrupted.into());
            }

            self.remaining.fill_buf()
        }

        fn consume(&mut self, amount: usize) {
            self.remaining.consume(amount);
        }
    }

    #[test]
    fn an_interrupted_fill_is_retried_and_the_line_is_read() {
        let line = wire(&json!({ "ok": true }));
        let mut reader = InterruptedOnce::new(line.clone());
        let mut into = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);

        assert_eq!(read_line(&mut reader, &mut into, deadline), Ok(()));
        assert_eq!(into, line);
    }

    #[test]
    fn closed_socket_kinds_are_named_closed() {
        for kind in [
            io::ErrorKind::UnexpectedEof,
            io::ErrorKind::ConnectionReset,
            io::ErrorKind::BrokenPipe,
        ] {
            assert_eq!(read_error(&io::Error::from(kind)), StallError::Closed);
        }
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
    fn a_frame_at_the_line_cap_is_accepted() {
        let frame = "x".repeat(MAX_LINE_BYTES);

        assert_eq!(check_line_len(frame.len()), Ok(()));
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

    #[tokio::test(flavor = "multi_thread")]
    async fn a_call_uses_the_fake_host_endpoint() {
        let dir = TempDir::new();
        let socket = dir.path().join("host.sock");
        let host = fake_host(&socket, CALL_REPLY);

        let endpoint = HostEndpoint::new(socket, TOKEN.to_owned());
        let mut transport = HostTransport::new(endpoint);
        let deadline = Instant::now() + Duration::from_secs(5);

        assert_eq!(
            tokio::task::block_in_place(|| transport.call(CALL_FRAME, deadline)),
            Ok(CALL_REPLY.to_owned())
        );
        host.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_reply_without_a_result_is_not_an_answer() {
        let dir = TempDir::new();
        let socket = dir.path().join("host.sock");
        let host = fake_host(&socket, "{}");
        let endpoint = HostEndpoint::new(socket, TOKEN.to_owned());
        let mut transport = HostTransport::new(endpoint);
        let deadline = Instant::now() + Duration::from_secs(5);

        assert_eq!(
            tokio::task::block_in_place(|| transport.call(CALL_FRAME, deadline)),
            Err(StallError::Malformed)
        );
        host.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_matching_id_without_a_result_is_not_an_answer() {
        let dir = TempDir::new();
        let socket = dir.path().join("host.sock");
        let reply = r#"{"jsonrpc":"2.0","id":22}"#;
        let host = fake_host(&socket, reply);
        let endpoint = HostEndpoint::new(socket, TOKEN.to_owned());
        let mut transport = HostTransport::new(endpoint);
        let deadline = Instant::now() + Duration::from_secs(5);

        assert_eq!(
            tokio::task::block_in_place(|| transport.call(CALL_FRAME, deadline)),
            Err(StallError::Malformed)
        );
        host.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_reply_with_a_foreign_id_is_not_an_answer() {
        let dir = TempDir::new();
        let socket = dir.path().join("host.sock");
        let reply = r#"{"jsonrpc":"2.0","id":99,"result":{"ok":true}}"#;
        let host = fake_host(&socket, reply);
        let endpoint = HostEndpoint::new(socket, TOKEN.to_owned());
        let mut transport = HostTransport::new(endpoint);
        let deadline = Instant::now() + Duration::from_secs(5);

        assert_eq!(
            tokio::task::block_in_place(|| transport.call(CALL_FRAME, deadline)),
            Err(StallError::Malformed)
        );
        host.join().unwrap();
    }

    // A fake host that answers host.start with a mismatched id, then checks
    // that a latched transport opens no second connection.
    fn bad_handshake_host(socket: &Path, checked: mpsc::Receiver<()>) -> thread::JoinHandle<()> {
        let listener = UnixListener::bind(socket).unwrap();

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();

            reader.read_line(&mut line).unwrap();
            writeln!(stream, "{BAD_START_REPLY}").unwrap();

            checked.recv().unwrap();
            listener.set_nonblocking(true).unwrap();

            assert_eq!(
                listener.accept().map(|_| ()).map_err(|error| error.kind()),
                Err(io::ErrorKind::WouldBlock)
            );
        })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_oversize_local_frame_does_not_latch_the_connection() {
        let dir = TempDir::new();
        let socket = dir.path().join("host.sock");
        let host = fake_host(&socket, CALL_REPLY);

        let endpoint = HostEndpoint::new(socket, TOKEN.to_owned());
        let mut transport = HostTransport::new(endpoint);
        let deadline = Instant::now() + Duration::from_secs(5);
        let oversize = "x".repeat(MAX_LINE_BYTES);

        assert_eq!(
            tokio::task::block_in_place(|| transport.call(&oversize, deadline)),
            Err(StallError::Io(format!(
                "line exceeds {MAX_LINE_BYTES} bytes"
            )))
        );
        assert_eq!(
            tokio::task::block_in_place(|| transport.call(CALL_FRAME, deadline)),
            Ok(CALL_REPLY.to_owned())
        );
        host.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_handshake_latches_and_never_reconnects() {
        let dir = TempDir::new();
        let socket = dir.path().join("host.sock");
        let (signal, checked) = mpsc::channel();
        let host = bad_handshake_host(&socket, checked);
        let endpoint = HostEndpoint::new(socket, TOKEN.to_owned());
        let mut transport = HostTransport::new(endpoint);
        let deadline = Instant::now() + Duration::from_secs(5);

        assert_eq!(
            tokio::task::block_in_place(|| transport.call(CALL_FRAME, deadline)),
            Err(StallError::Malformed)
        );
        assert_eq!(
            tokio::task::block_in_place(|| transport.call(CALL_FRAME, deadline)),
            Err(StallError::Io("host handshake failed; no retry".into()))
        );

        signal.send(()).unwrap();
        host.join().unwrap();
    }

    // A fake host that finishes host.start, then closes before answering the
    // call, and checks that a latched transport opens no second connection.
    fn mid_call_failure_host(socket: &Path, checked: mpsc::Receiver<()>) -> thread::JoinHandle<()> {
        let listener = UnixListener::bind(socket).unwrap();

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();

            reader.read_line(&mut line).unwrap();
            writeln!(stream, "{START_REPLY}").unwrap();

            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            assert_eq!(request.trim_end(), CALL_FRAME);

            drop(reader);
            drop(stream);

            checked.recv().unwrap();
            listener.set_nonblocking(true).unwrap();

            assert_eq!(
                listener.accept().map(|_| ()).map_err(|error| error.kind()),
                Err(io::ErrorKind::WouldBlock)
            );
        })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_mid_call_failure_drops_the_stream_and_never_reuses_it() {
        let dir = TempDir::new();
        let socket = dir.path().join("host.sock");
        let (signal, checked) = mpsc::channel();
        let host = mid_call_failure_host(&socket, checked);
        let endpoint = HostEndpoint::new(socket, TOKEN.to_owned());
        let mut transport = HostTransport::new(endpoint);
        let deadline = Instant::now() + Duration::from_secs(5);

        assert_eq!(
            tokio::task::block_in_place(|| transport.call(CALL_FRAME, deadline)),
            Err(StallError::Closed)
        );
        assert!(transport.stream.is_none());
        assert_eq!(
            tokio::task::block_in_place(|| transport.call(CALL_FRAME, deadline)),
            Err(StallError::Io("host handshake failed; no retry".into()))
        );

        signal.send(()).unwrap();
        host.join().unwrap();
    }

    fn framed_input(bytes: usize) -> String {
        json!({
            "type": "hook",
            "id": 22,
            "version": 1,
            "hook": "PreToolUse",
            "call": {
                "tool": "bash",
                "name": "run",
                "input": "x".repeat(bytes),
            },
        })
        .to_string()
    }

    #[test]
    fn framed_input_at_the_body_cap_is_accepted() {
        let input = "x".repeat(DEFAULT_MAX_BODY_BYTES.saturating_sub(2));
        assert_eq!(
            serde_json::to_string(&input).unwrap().len(),
            DEFAULT_MAX_BODY_BYTES
        );

        assert_eq!(body_within_cap(&framed_input(input.len())), Ok(()));
    }

    #[test]
    fn framed_input_over_the_body_cap_is_rejected() {
        let input = "x".repeat(DEFAULT_MAX_BODY_BYTES.saturating_sub(1));
        assert_eq!(
            serde_json::to_string(&input).unwrap().len(),
            DEFAULT_MAX_BODY_BYTES.saturating_add(1)
        );

        assert_eq!(
            body_within_cap(&framed_input(input.len())),
            Err(StallError::Io(format!(
                "body exceeds {DEFAULT_MAX_BODY_BYTES} bytes"
            )))
        );
    }

    #[test]
    fn an_object_body_at_the_cap_is_accepted() {
        let empty = json!({ "k": "" });
        let padding = DEFAULT_MAX_BODY_BYTES.saturating_sub(serialized_len(&empty).unwrap());
        let body = json!({ "k": "x".repeat(padding) });
        let measured = serialized_len(&body);
        let line = json!({ "body": body }).to_string();

        assert_eq!(measured, Ok(DEFAULT_MAX_BODY_BYTES));
        assert_eq!(body_within_cap(&line), Ok(()));
    }

    #[test]
    fn an_object_body_over_the_cap_is_rejected() {
        let empty = json!({ "k": "" });
        let padding = DEFAULT_MAX_BODY_BYTES
            .saturating_add(1)
            .saturating_sub(serialized_len(&empty).unwrap());
        let body = json!({ "k": "x".repeat(padding) });
        let measured = serialized_len(&body);
        let line = json!({ "body": body }).to_string();

        assert_eq!(measured, Ok(DEFAULT_MAX_BODY_BYTES.saturating_add(1)));
        assert_eq!(
            body_within_cap(&line),
            Err(StallError::Io(format!(
                "body exceeds {DEFAULT_MAX_BODY_BYTES} bytes"
            )))
        );
    }

    #[test]
    fn a_non_denial_error_reply_is_not_an_answer() {
        let answer = json!({
            "jsonrpc": "2.0",
            "id": 22,
            "error": {
                "code": -32_600,
                "message": "Method not found",
            },
        })
        .to_string();

        assert_eq!(
            refused_frame(&answer, 22),
            Err(StallError::Io("host error -32600: Method not found".into()))
        );
    }

    #[test]
    fn a_denied_message_alone_is_a_named_unknown_error() {
        let error = json!({
            "code": -32_600,
            "message": "denied",
            "data": { "reason": deny::TOKEN_MISMATCH },
        });

        assert_eq!(
            host_error(&error),
            StallError::Io("host error -32600: denied".into())
        );
    }

    #[test]
    fn the_denial_code_alone_is_a_named_unknown_error() {
        let error = json!({
            "code": DENIED_CODE,
            "message": "other",
            "data": { "reason": deny::TOKEN_MISMATCH },
        });

        assert_eq!(
            host_error(&error),
            StallError::Io(format!("host error {DENIED_CODE}: other"))
        );
    }

    #[test]
    fn a_denial_error_reply_keeps_its_named_reason() {
        let answer = json!({
            "jsonrpc": "2.0",
            "id": 22,
            "error": {
                "code": DENIED_CODE,
                "message": "denied",
                "data": { "reason": deny::TOKEN_MISMATCH },
            },
        })
        .to_string();

        assert_eq!(
            refused_frame(&answer, 22),
            Err(StallError::Io(format!(
                "host.start denied: {}",
                deny::TOKEN_MISMATCH
            )))
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_oversize_nested_reply_body_is_refused_by_call() {
        let dir = TempDir::new();
        let socket = dir.path().join("host.sock");
        let text = "x".repeat(DEFAULT_MAX_BODY_BYTES.saturating_add(1));
        let reply = json!({
            "jsonrpc": "2.0",
            "id": 22,
            "result": {
                "type": "tool",
                "id": 22,
                "content": { "kind": "text", "text": text },
            },
        })
        .to_string();
        let host = fake_host(&socket, reply);
        let endpoint = HostEndpoint::new(socket, TOKEN.to_owned());
        let mut transport = HostTransport::new(endpoint);
        let deadline = Instant::now() + Duration::from_secs(10);

        assert_eq!(
            tokio::task::block_in_place(|| transport.call(CALL_FRAME, deadline)),
            Err(StallError::Io(format!(
                "body exceeds {DEFAULT_MAX_BODY_BYTES} bytes"
            )))
        );
        host.join().unwrap();
    }
}
