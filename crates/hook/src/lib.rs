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
mod trust;

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
    /// The total stays under the harness mod's 9000 ms timeout, so the
    /// hook's own verdict arrives before the mod gives up on it.
    pub const DEFAULT: Self = Self {
        total: Duration::from_millis(8500),
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

/// The largest number of needs the hook will carry to a daemon.
const MAX_NEEDS: usize = 64;

/// The largest plugin name or need, in bytes.
const MAX_IDENTITY_BYTES: usize = 128;

/// The launch arguments an adapter passes to the hook. The plugin folder
/// decides whether a daemon is cold-started; the name and needs are the
/// plugin's identity, forwarded unchanged on that start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookArgs {
    pub plugin: Option<PathBuf>,
    pub name: Option<String>,
    pub needs: Vec<String>,
}

/// Parse the hook's arguments in any order.
///
/// Names and needs are non-empty ASCII `[a-z0-9_.-]` strings of at most
/// `MAX_IDENTITY_BYTES` bytes, so the daemon can adopt them without escaping;
/// at most `MAX_NEEDS` needs are kept.
///
/// # Errors
///
/// Returns a `malformed` failure for an unknown argument, a missing value,
/// a second `--plugin-name`, or an invalid name or need.
pub fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<HookArgs, Failure> {
    let mut args = args.into_iter();
    let mut plugin = None;
    let mut name = None;
    let mut needs = Vec::new();

    let malformed = |message: &'static str| Failure::new(ReplyError::Malformed, message);

    while let Some(arg) = args.next() {
        if arg == "--plugin" {
            let dir = args
                .next()
                .ok_or_else(|| malformed("--plugin needs a dir"))?;
            plugin = Some(PathBuf::from(dir));
        } else if arg == "--plugin-name" {
            if name.is_some() {
                return Err(malformed("duplicate --plugin-name"));
            }

            let value = args
                .next()
                .ok_or_else(|| malformed("--plugin-name needs a name"))?;
            let value = value
                .to_str()
                .ok_or_else(|| malformed("malformed --plugin-name"))?;

            if !valid_identity(value) {
                return Err(malformed("malformed --plugin-name"));
            }
            name = Some(value.to_owned());
        } else if arg == "--need" {
            let value = args
                .next()
                .ok_or_else(|| malformed("--need needs a capability"))?;
            let value = value
                .to_str()
                .ok_or_else(|| malformed("malformed --need"))?;

            if !valid_identity(value) {
                return Err(malformed("malformed --need"));
            }
            if needs.len() >= MAX_NEEDS {
                return Err(malformed("too many --need"));
            }
            needs.push(value.to_owned());
        } else {
            return Err(Failure::new(
                ReplyError::Malformed,
                format_args!("unknown argument {}", arg.to_string_lossy()),
            ));
        }
    }

    Ok(HookArgs {
        plugin,
        name,
        needs,
    })
}

/// Names are non-empty ASCII `[a-z0-9_.-]`, matching the daemon's grant names.
fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTITY_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'-')
        })
}

/// The plugin folder from `--plugin <dir>`.
///
/// Without it the hook never starts a daemon. The other launch arguments are
/// parsed and validated here too, so a caller that cold-starts a daemon uses
/// [`parse_args`] to forward them.
///
/// # Errors
///
/// Returns a `malformed` failure for any other argument or a missing dir.
pub fn plugin_dir(args: impl IntoIterator<Item = OsString>) -> Result<Option<PathBuf>, Failure> {
    Ok(parse_args(args)?.plugin)
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
/// Before each connect the state folder and the socket must be this user's;
/// otherwise the call fails `socket_untrusted` and nothing starts. When no
/// daemon listens and `start` is given, run it once and connect at most
/// once more. Every wait ends by `budget`'s deadline: the retry gets
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

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(Into::into).collect()
    }

    #[test]
    fn identity_is_returned_in_the_exact_order_given() {
        let parsed = parse_args(args(&[
            "--need",
            "sdk.barn",
            "--plugin-name",
            "safe-push",
            "--plugin",
            "/plugins/safe-push",
            "--need",
            "control.call.push",
        ]));

        assert_eq!(
            parsed,
            Ok(HookArgs {
                plugin: Some(PathBuf::from("/plugins/safe-push")),
                name: Some("safe-push".into()),
                needs: vec!["sdk.barn".into(), "control.call.push".into()],
            })
        );
    }

    #[test]
    fn a_second_plugin_name_is_malformed() {
        let parsed = parse_args(args(&["--plugin-name", "one", "--plugin-name", "two"]));

        assert_eq!(
            parsed,
            Err(Failure::new(
                ReplyError::Malformed,
                "duplicate --plugin-name"
            ))
        );
    }

    #[test]
    fn malformed_names_and_needs_are_rejected() {
        let too_long = "a".repeat(MAX_IDENTITY_BYTES + 1);
        let caps: Vec<String> = (0..=MAX_NEEDS).map(|i| format!("cap-{i}")).collect();
        let mut too_many = vec!["--plugin-name", "safe-push"];
        for cap in &caps {
            too_many.push("--need");
            too_many.push(cap);
        }

        let cases: &[&[&str]] = &[
            &["--plugin-name"],
            &["--plugin-name", ""],
            &["--plugin-name", "Bad"],
            &["--plugin-name", "has space"],
            &["--plugin-name", "a/b"],
            &["--plugin-name", too_long.as_str()],
            &["--need"],
            &["--need", ""],
            &["--need", "Bad-Name"],
            &["--need", too_long.as_str()],
            &too_many,
        ];

        for &case in cases {
            assert_eq!(
                parse_args(args(case)).map_err(|failure| failure.kind),
                Err(ReplyError::Malformed),
                "case {case:?}"
            );
        }
    }

    #[test]
    fn absent_identity_still_parses() {
        let empty = HookArgs {
            plugin: None,
            name: None,
            needs: Vec::new(),
        };

        assert_eq!(parse_args(args(&[])), Ok(empty.clone()));
        assert_eq!(
            parse_args(args(&["--plugin", "/plugins/safe-push"])),
            Ok(HookArgs {
                plugin: Some(PathBuf::from("/plugins/safe-push")),
                ..empty
            })
        );
    }
}
