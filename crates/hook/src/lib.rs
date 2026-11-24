//! `tack-hook`: a thin native client for the per-user tack daemon.
//!
//! It reads one request line, reaches the daemon on its owner-only socket,
//! starting it once when it is absent, forwards the line and returns the
//! daemon's one reply line unchanged. Every failure becomes a `Reply::Error`
//! line with a named kind, so the caller always reads a verdict. No plugin
//! code runs here.

pub mod failure;
pub mod locate;
pub mod start;

mod exchange;

use std::ffi::OsString;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use exchange::Attempt;
use tack_protocol::wire::{MAX_FRAME_BYTES, ReplyError, Request};
use tokio::time::Instant;

pub use failure::Failure;

/// Waits the hook bounds itself by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// The whole run, from process start to the verdict: stdin, any start
    /// wait, and every connect, send and read.
    pub total: Duration,
    /// The longest wait for a started daemon's socket, within `total`.
    pub start: Duration,
}

impl Limits {
    pub const DEFAULT: Self = Self {
        total: Duration::from_millis(9000),
        start: Duration::from_millis(3000),
    };
}

/// The one deadline every wait shares, fixed when the run starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    deadline: Instant,
    limits: Limits,
}

impl Budget {
    /// A budget of `limits.total` from now.
    #[must_use]
    pub fn from_now(limits: Limits) -> Self {
        let now = Instant::now();

        Self {
            deadline: now.checked_add(limits.total).unwrap_or(now),
            limits,
        }
    }

    #[must_use]
    pub const fn deadline(&self) -> Instant {
        self.deadline
    }

    /// The start sub-limit, cut to what is left of the budget.
    fn start_wait(&self) -> Duration {
        let left = self.deadline.saturating_duration_since(Instant::now());

        self.limits.start.min(left)
    }

    /// The failure when the deadline passes before a verdict.
    #[must_use]
    pub fn timed_out(&self, waiting_for: &str) -> Failure {
        Failure::new(
            ReplyError::Timeout,
            format_args!(
                "no {waiting_for} within {} ms",
                self.limits.total.as_millis()
            ),
        )
    }
}

/// The read cap for one frame: one byte past the limit tells an oversize
/// frame from one exactly at it.
fn frame_cap() -> u64 {
    u64::try_from(MAX_FRAME_BYTES)
        .unwrap_or(u64::MAX)
        .saturating_add(1)
}

/// The plugin folder from `--plugin <dir>`, the only argument. Without it
/// the hook never starts a daemon.
///
/// # Errors
///
/// Returns a `malformed` failure for any other argument or a missing dir.
pub fn plugin_dir(args: impl IntoIterator<Item = OsString>) -> Result<Option<PathBuf>, Failure> {
    let mut args = args.into_iter();
    let mut plugin = None;

    while let Some(arg) = args.next() {
        if arg != "--plugin" {
            return Err(Failure::new(
                ReplyError::Malformed,
                format_args!("unknown argument {}", arg.to_string_lossy()),
            ));
        }

        let dir = args
            .next()
            .ok_or_else(|| Failure::new(ReplyError::Malformed, "--plugin needs a dir"))?;
        plugin = Some(PathBuf::from(dir));
    }

    Ok(plugin)
}

/// Read the first line of `reader`, at most 1 MiB with its newline. A last
/// line without a newline is accepted.
///
/// # Errors
///
/// Returns `too_large` for an oversize line, `malformed` for no line and
/// `aborted` when reading fails.
pub fn read_request<R: BufRead>(reader: &mut R) -> Result<Vec<u8>, Failure> {
    let mut line = Vec::new();

    reader
        .take(frame_cap())
        .read_until(b'\n', &mut line)
        .map_err(|error| {
            Failure::new(
                ReplyError::Aborted,
                format_args!("cannot read stdin: {error}"),
            )
        })?;

    if line.is_empty() {
        return Err(Failure::new(ReplyError::Malformed, "no request on stdin"));
    }

    if line.last() != Some(&b'\n') {
        line.push(b'\n');
    }

    if line.len() > MAX_FRAME_BYTES {
        return Err(Failure::new(
            ReplyError::TooLarge,
            "the request exceeds 1 MiB",
        ));
    }

    Ok(line)
}

/// One request line and the request it holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    line: Vec<u8>,
    request: Request,
}

impl Call {
    /// Parse a newline-terminated request line, as `read_request` returns.
    ///
    /// # Errors
    ///
    /// Returns a `malformed` failure when the line is not a tack request.
    pub fn parse(line: Vec<u8>) -> Result<Self, Failure> {
        let request = serde_json::from_slice(&line).map_err(|error| {
            Failure::new(
                ReplyError::Malformed,
                format_args!("stdin is not a tack request: {error}"),
            )
        })?;

        Ok(Self { line, request })
    }

    #[must_use]
    pub const fn id(&self) -> u64 {
        self.request.id()
    }
}

/// Forward `call` to the daemon at `socket` and return its reply line
/// unchanged.
///
/// When no daemon listens and `start` is given, run it once and connect at
/// most once more. Every wait ends by `budget`'s deadline: the retry gets
/// only what the start wait left.
///
/// # Errors
///
/// Returns the failure that ended the call, named by its `ReplyError` kind.
pub async fn forward<S>(
    call: &Call,
    socket: &Path,
    start: Option<S>,
    budget: Budget,
) -> Result<Vec<u8>, Failure>
where
    S: FnOnce() -> Result<(), Failure> + Send,
{
    let reply = match (exchange::attempt(socket, &call.line, &budget).await, start) {
        (Ok(reply), _) => reply,
        (Err(Attempt::Absent(_)), Some(start)) => {
            start::cold_start(socket, start, budget.start_wait()).await?;

            // A spent budget still makes this one attempt: a missing socket
            // fails as socket_missing at once, a silent one as timeout.
            exchange::attempt(socket, &call.line, &budget)
                .await
                .map_err(|attempt| attempt.into_failure(socket))?
        }
        (Err(attempt), _) => return Err(attempt.into_failure(socket)),
    };

    exchange::check(&reply, &call.request)?;

    Ok(reply)
}
