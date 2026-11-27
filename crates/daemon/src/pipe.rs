//! The one bounded line barn writes to stdout when a stall starts.
//!
//! barn writes the endpoint before the stall runs and sends its logs to
//! stderr. tack reads that line once, with a deadline, and never retries: a
//! line that is absent, malformed, oversized, out of date or carrying barn's
//! own error becomes a named `plugin unavailable` denial. The daemon stays up.
//!
//! This module bounds bytes only: 8192 including the newline, exact fields,
//! and no further read after the newline. A generic `Read` can block forever,
//! so bounding the wait in time is the caller's responsibility. In tack#104
//! the caller runs the read on a worker thread and enforces the deadline with
//! a bounded receive. Do not reuse this parser expecting a read timeout.

use std::fmt;
use std::io::{self, BufRead, BufReader, Read};
use std::path::PathBuf;
use std::time::Instant;

use barn_stall::{LAUNCH_PROTOCOL, MAX_LAUNCH_LINE_BYTES};
use serde::Deserialize;

use crate::host_transport::HostEndpoint;

/// The one success line barn writes on stdout.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct EndpointLine {
    protocol: u32,
    socket_path: PathBuf,
    token: String,
}

/// The one line barn writes when it cannot start the stall.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorLine {
    protocol: u32,
    error: String,
}

/// Either line barn may write; no third shape is accepted.
#[derive(Deserialize)]
#[serde(untagged)]
enum StartLine {
    Endpoint(EndpointLine),
    Error(ErrorLine),
}

/// Why barn did not yield a usable endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipeError {
    /// barn wrote no line.
    Missing,
    /// The line was not exactly one valid object of a known shape.
    Malformed,
    /// The line would pass the byte cap.
    Oversize,
    /// The line named another protocol version.
    Protocol,
    /// barn named the reason it could not start the stall.
    Error(String),
}

impl fmt::Display for PipeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => f.write_str("tack: plugin unavailable: missing endpoint"),
            Self::Malformed => f.write_str("tack: plugin unavailable: malformed endpoint"),
            Self::Oversize => f.write_str("tack: plugin unavailable: oversize endpoint"),
            Self::Protocol => f.write_str("tack: plugin unavailable: protocol mismatch"),
            Self::Error(reason) => {
                f.write_str("tack: plugin unavailable: ")?;

                for character in reason.chars() {
                    if character.is_control() {
                        write!(f, "\\u{{{:x}}}", u32::from(character))?;
                    } else {
                        write!(f, "{character}")?;
                    }
                }

                Ok(())
            }
        }
    }
}

impl std::error::Error for PipeError {}

/// Read barn's single start line and turn it into a host endpoint.
///
/// The reader is a `BufReader` so bytes waiting behind the newline are read
/// from its buffer. Once the newline is seen no further read happens, so a
/// child that keeps stdout open cannot hold the daemon past its deadline. A
/// line over `MAX_LAUNCH_LINE_BYTES`, counted with its newline, is
/// refused; the byte cap and the no-read-after-newline rule are enforced
/// here.
///
/// `deadline` is checked between chunks only: it cannot interrupt a blocking
/// `fill_buf` and is not a read timeout. The wait is bounded by the caller
/// (tack#104's reader thread), and nothing is retried.
///
/// # Errors
///
/// Returns `Missing` when the reader ends before a line, `Oversize` when a
/// line passes the byte cap, `Malformed` when the line is not exactly one
/// known object with an absolute socket path and a non-empty token,
/// `Protocol` when its version differs from `LAUNCH_PROTOCOL`, and `Error`
/// carrying barn's reason when barn could not start the stall.
pub fn read_endpoint<R: Read>(
    reader: &mut BufReader<R>,
    deadline: Instant,
) -> Result<HostEndpoint, PipeError> {
    before(deadline)?;

    let line = take_line(reader, deadline)?;
    let body = line.strip_suffix(b"\n").ok_or(PipeError::Malformed)?;
    let text = std::str::from_utf8(body).map_err(|_| PipeError::Malformed)?;
    let start: StartLine = serde_json::from_str(text).map_err(|_| PipeError::Malformed)?;

    match start {
        StartLine::Endpoint(endpoint) => {
            if endpoint.protocol != LAUNCH_PROTOCOL {
                return Err(PipeError::Protocol);
            }
            if !endpoint.socket_path.is_absolute() || endpoint.token.is_empty() {
                return Err(PipeError::Malformed);
            }

            Ok(HostEndpoint::new(endpoint.socket_path, endpoint.token))
        }
        StartLine::Error(error) => {
            if error.protocol != LAUNCH_PROTOCOL {
                return Err(PipeError::Protocol);
            }

            Err(PipeError::Error(error.error))
        }
    }
}

/// Collect one newline-terminated line and reject any byte already buffered
/// behind it. The newline is the last read: the peer may hold stdout open.
/// `deadline` is only checked between chunks; a silent or blocking reader is
/// bounded by the caller, not by this function.
fn take_line<R: Read>(reader: &mut BufReader<R>, deadline: Instant) -> Result<Vec<u8>, PipeError> {
    let mut line = Vec::new();

    loop {
        before(deadline)?;

        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(PipeError::Malformed),
        };
        if available.is_empty() {
            break;
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |at| at.saturating_add(1));

        if line.len().saturating_add(count) > MAX_LAUNCH_LINE_BYTES {
            return Err(PipeError::Oversize);
        }

        let bytes = available.get(..count).ok_or(PipeError::Malformed)?;
        line.extend_from_slice(bytes);
        reader.consume(count);

        if newline.is_some() {
            break;
        }
    }

    if line.is_empty() {
        return Err(PipeError::Missing);
    }
    if !reader.buffer().is_empty() {
        return Err(PipeError::Malformed);
    }

    Ok(line)
}

/// Reject a call with no time left before it waits for another chunk.
fn before(deadline: Instant) -> Result<(), PipeError> {
    let left = deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero());

    if left.is_none() {
        return Err(PipeError::Missing);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};
    use std::time::Duration;

    use super::*;

    fn line(json: &str) -> BufReader<Cursor<Vec<u8>>> {
        let mut bytes = json.as_bytes().to_vec();
        bytes.push(b'\n');

        BufReader::new(Cursor::new(bytes))
    }

    fn deadline() -> Instant {
        Instant::now()
            .checked_add(Duration::from_secs(5))
            .expect("the test budget is representable")
    }

    struct InterruptedOnce {
        spent: bool,
        bytes: Cursor<Vec<u8>>,
    }

    impl Read for InterruptedOnce {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if !self.spent {
                self.spent = true;

                return Err(io::Error::from(io::ErrorKind::Interrupted));
            }

            self.bytes.read(buffer)
        }
    }

    struct BrokenRead;

    impl Read for BrokenRead {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("barn stdout failed"))
        }
    }

    #[test]
    fn an_exact_endpoint_line_yields_the_host_endpoint() {
        let mut reader = line(
            r#"{"protocol":1,"socket_path":"/tmp/barn-host.sock","token":"single-use-token"}"#,
        );

        assert_eq!(
            read_endpoint(&mut reader, deadline()),
            Ok(HostEndpoint::new(
                PathBuf::from("/tmp/barn-host.sock"),
                "single-use-token".to_owned()
            ))
        );
    }

    #[test]
    fn an_error_line_keeps_barns_reason() {
        let mut reader = line(r#"{"protocol":1,"error":"stall already running"}"#);

        assert_eq!(
            read_endpoint(&mut reader, deadline()),
            Err(PipeError::Error("stall already running".to_owned()))
        );
    }

    #[test]
    fn an_unknown_field_is_malformed() {
        let mut reader =
            line(r#"{"protocol":1,"socket_path":"/tmp/host.sock","token":"t","extra":true}"#);

        assert_eq!(
            read_endpoint(&mut reader, deadline()),
            Err(PipeError::Malformed)
        );
    }

    #[test]
    fn a_wrong_protocol_is_rejected() {
        let mut reader = line(r#"{"protocol":2,"socket_path":"/tmp/host.sock","token":"t"}"#);

        assert_eq!(
            read_endpoint(&mut reader, deadline()),
            Err(PipeError::Protocol)
        );
    }

    #[test]
    fn a_relative_socket_path_is_malformed() {
        let mut reader = line(r#"{"protocol":1,"socket_path":"host.sock","token":"t"}"#);

        assert_eq!(
            read_endpoint(&mut reader, deadline()),
            Err(PipeError::Malformed)
        );
    }

    #[test]
    fn an_empty_token_is_malformed() {
        let mut reader = line(r#"{"protocol":1,"socket_path":"/tmp/host.sock","token":""}"#);

        assert_eq!(
            read_endpoint(&mut reader, deadline()),
            Err(PipeError::Malformed)
        );
    }

    #[test]
    fn an_oversize_line_is_rejected() {
        let token = "x".repeat(MAX_LAUNCH_LINE_BYTES);
        let json =
            format!("{{\"protocol\":1,\"socket_path\":\"/tmp/host.sock\",\"token\":\"{token}\"}}");
        let mut reader = line(&json);

        assert_eq!(
            read_endpoint(&mut reader, deadline()),
            Err(PipeError::Oversize)
        );
    }

    #[test]
    fn an_interrupted_read_is_retried() {
        let endpoint = br#"{"protocol":1,"socket_path":"/tmp/host.sock","token":"t"}"#;
        let mut bytes = endpoint.to_vec();
        bytes.push(b'\x0a');
        let mut reader = BufReader::new(InterruptedOnce {
            spent: false,
            bytes: Cursor::new(bytes),
        });

        assert_eq!(
            read_endpoint(&mut reader, deadline()),
            Ok(HostEndpoint::new(
                PathBuf::from("/tmp/host.sock"),
                "t".to_owned()
            ))
        );
    }

    #[test]
    fn a_non_interrupted_read_error_is_malformed() {
        let mut reader = BufReader::new(BrokenRead);
        let soon = Instant::now()
            .checked_add(Duration::from_millis(250))
            .expect("the test budget is representable");

        assert_eq!(read_endpoint(&mut reader, soon), Err(PipeError::Malformed));
    }

    #[test]
    fn a_valid_line_at_the_launch_byte_cap_is_accepted() {
        let frame = r#"{"protocol":1,"socket_path":"/tmp/host.sock","token":""#;
        // The closing quote, brace and newline are the other three bytes.
        let token = "x".repeat(MAX_LAUNCH_LINE_BYTES.saturating_sub(frame.len().saturating_add(3)));
        let json = format!("{frame}{token}\"}}");
        let mut reader = line(&json);

        assert_eq!(
            json.len().saturating_add(1),
            MAX_LAUNCH_LINE_BYTES,
            "the line includes the newline"
        );
        assert_eq!(
            read_endpoint(&mut reader, deadline()),
            Ok(HostEndpoint::new(PathBuf::from("/tmp/host.sock"), token))
        );
    }

    #[test]
    fn a_newline_less_line_above_the_launch_byte_cap_is_oversize() {
        let bytes = "x"
            .repeat(MAX_LAUNCH_LINE_BYTES.saturating_add(1))
            .into_bytes();
        let mut reader = BufReader::new(Cursor::new(bytes));

        assert_eq!(
            read_endpoint(&mut reader, deadline()),
            Err(PipeError::Oversize)
        );
    }

    #[test]
    fn an_absent_line_is_missing() {
        let mut reader = BufReader::new(Cursor::new(Vec::new()));

        assert_eq!(
            read_endpoint(&mut reader, deadline()),
            Err(PipeError::Missing)
        );
    }

    #[test]
    fn a_trailing_second_line_is_rejected() {
        let mut reader = line(r#"{"protocol":1,"socket_path":"/tmp/host.sock","token":"t"}"#);
        reader
            .get_mut()
            .get_mut()
            .extend_from_slice(b"{\"protocol\":1,\"error\":\"late\"}\n");

        assert_eq!(
            read_endpoint(&mut reader, deadline()),
            Err(PipeError::Malformed)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_live_writer_after_the_newline_does_not_delay_the_endpoint() {
        use std::os::unix::net::UnixStream;
        use std::sync::mpsc;
        use std::thread;

        let (mut writer, reader) = UnixStream::pair().expect("a socket pair");
        let bytes = br#"{"protocol":1,"socket_path":"/tmp/host.sock","token":"t"}"#;
        writer.write_all(bytes).expect("the line reaches the pipe");
        writer
            .write_all(b"\x0a")
            .expect("the newline reaches the pipe");

        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            let mut buffered = BufReader::new(reader);
            let outcome = read_endpoint(&mut buffered, deadline()).map(|_| ());
            let _ = sender.send(outcome);
        });

        let outcome = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("the reader returns while the writer stays open");
        worker.join().expect("the reader thread ends");

        assert_eq!(outcome, Ok(()));
    }

    #[test]
    fn an_expired_deadline_is_missing() {
        let mut reader = line(r#"{"protocol":1,"socket_path":"/tmp/host.sock","token":"t"}"#);
        let expired = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .expect("the clock is far from the epoch");

        assert_eq!(read_endpoint(&mut reader, expired), Err(PipeError::Missing));
    }

    #[test]
    fn every_denial_has_a_stable_reason() {
        assert_eq!(
            PipeError::Missing.to_string(),
            "tack: plugin unavailable: missing endpoint"
        );
        assert_eq!(
            PipeError::Malformed.to_string(),
            "tack: plugin unavailable: malformed endpoint"
        );
        assert_eq!(
            PipeError::Oversize.to_string(),
            "tack: plugin unavailable: oversize endpoint"
        );
        assert_eq!(
            PipeError::Protocol.to_string(),
            "tack: plugin unavailable: protocol mismatch"
        );
        assert_eq!(
            PipeError::Error("stall already running".to_owned()).to_string(),
            "tack: plugin unavailable: stall already running"
        );
    }
}
