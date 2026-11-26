//! Seams for a bounded call to a stall.
//!
//! `Clock` and `Transport` are replaceable: a caller injects the real clock
//! and transport, while tests advance a fake clock and record the frames a
//! fake stall receives. No request or reply contract is defined here. Frames
//! are opaque single lines — `&str` in, `String` out — and mapping them to a
//! wire protocol belongs to the caller once that contract is settled.

use std::fmt;
use std::time::{Duration, Instant};

/// A source of the current time and of deadlines derived from it.
pub trait Clock {
    /// The current instant.
    fn now(&self) -> Instant;

    /// The instant `after` from now, or now when the sum is not representable.
    fn deadline(&self, after: Duration) -> Instant;
}

/// The clock used outside tests: `Instant::now()` with a checked deadline.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn deadline(&self, after: Duration) -> Instant {
        let now = Instant::now();

        now.checked_add(after).unwrap_or(now)
    }
}

/// Errors from a call to a stall.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StallError {
    /// The stall closed the connection before replying.
    Closed,
    /// The budget ran out before or during the call.
    Timeout,
    /// The reply was not a single line.
    Malformed,
    /// An I/O failure, carrying its message.
    Io(String),
}

impl fmt::Display for StallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => write!(f, "closed"),
            Self::Timeout => write!(f, "timeout"),
            Self::Malformed => write!(f, "malformed"),
            Self::Io(context) => write!(f, "io({context})"),
        }
    }
}

impl std::error::Error for StallError {}

/// One line in, one line out. The real transport is supplied by the caller.
pub trait Transport {
    /// Send `frame` and return the single-line reply.
    ///
    /// # Errors
    ///
    /// Returns the stall's error when the call fails.
    fn call(&mut self, frame: &str) -> Result<String, StallError>;
}

/// One call to a stall under a fixed budget, with no retries.
pub struct StallClient<C, T> {
    clock: C,
    transport: T,
    budget: Duration,
}

impl<C: Clock, T: Transport> StallClient<C, T> {
    /// Build a client that gives each call `budget` from the injected clock.
    #[must_use]
    pub const fn new(clock: C, transport: T, budget: Duration) -> Self {
        Self {
            clock,
            transport,
            budget,
        }
    }

    /// Call the stall once and return its reply when it fits the budget.
    ///
    /// # Errors
    ///
    /// Returns `Timeout` when the clock is at or past the deadline before or
    /// after the call, the transport's error when the call fails, and
    /// `Malformed` when the reply is not exactly one line.
    pub fn call(&mut self, frame: &str) -> Result<String, StallError> {
        let deadline = self.clock.deadline(self.budget);

        if self.clock.now() >= deadline {
            return Err(StallError::Timeout);
        }

        let reply = self.transport.call(frame)?;

        if self.clock.now() >= deadline {
            return Err(StallError::Timeout);
        }

        if reply.lines().count() != 1 {
            return Err(StallError::Malformed);
        }

        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::*;

    /// A clock whose instant advances by a handle shared with the fake stall.
    #[derive(Clone)]
    struct FakeClock {
        now: Rc<RefCell<Instant>>,
        start: Instant,
    }

    impl FakeClock {
        fn new(start: Instant) -> Self {
            Self {
                now: Rc::new(RefCell::new(start)),
                start,
            }
        }

        fn advance(&self, by: Duration) {
            let mut now = self.now.borrow_mut();

            *now = now.checked_add(by).unwrap_or(*now);
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            *self.now.borrow()
        }

        fn deadline(&self, after: Duration) -> Instant {
            self.start.checked_add(after).unwrap_or(self.start)
        }
    }

    /// A stall that records frames and returns a canned reply or error.
    struct FakeStall {
        clock: FakeClock,
        frames: Vec<String>,
        reply: Result<String, StallError>,
        advance: Option<Duration>,
    }

    impl FakeStall {
        fn reply(clock: FakeClock, reply: &str) -> Self {
            Self {
                clock,
                frames: Vec::new(),
                reply: Ok(reply.to_owned()),
                advance: None,
            }
        }

        fn error(clock: FakeClock, error: StallError) -> Self {
            Self {
                clock,
                frames: Vec::new(),
                reply: Err(error),
                advance: None,
            }
        }

        fn advancing(mut self, by: Duration) -> Self {
            self.advance = Some(by);

            self
        }

        fn frames(&self) -> &[String] {
            &self.frames
        }
    }

    impl Transport for FakeStall {
        fn call(&mut self, frame: &str) -> Result<String, StallError> {
            self.frames.push(frame.to_owned());

            if let Some(by) = self.advance {
                self.clock.advance(by);
            }

            self.reply.clone()
        }
    }

    #[test]
    fn reply_inside_budget_is_returned_byte_identically() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), "{\"ok\":true,\"note\":\"héllo\"}  ");
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));

        assert_eq!(
            client.call("{\"id\":1}"),
            Ok("{\"ok\":true,\"note\":\"héllo\"}  ".to_owned())
        );
        assert_eq!(client.transport.frames(), &["{\"id\":1}".to_owned()]);
    }

    #[test]
    fn pre_expired_budget_times_out_without_calling() {
        let start = Instant::now();
        let clock = FakeClock::new(start);
        let stall = FakeStall::reply(clock.clone(), "ok");
        let mut client = StallClient::new(clock.clone(), stall, Duration::from_secs(1));

        clock.advance(Duration::from_secs(1));

        let no_frames: &[String] = &[];

        assert_eq!(client.call("frame"), Err(StallError::Timeout));
        assert_eq!(client.transport.frames(), no_frames);
    }

    #[test]
    fn clock_advanced_during_call_times_out() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), "ok").advancing(Duration::from_secs(2));
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));

        assert_eq!(client.call("frame"), Err(StallError::Timeout));
        assert_eq!(client.transport.frames(), &["frame".to_owned()]);
    }

    #[test]
    fn closed_error_passes_through() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::error(clock.clone(), StallError::Closed);
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));

        assert_eq!(client.call("frame"), Err(StallError::Closed));
        assert_eq!(client.transport.frames(), &["frame".to_owned()]);
    }

    #[test]
    fn multi_line_reply_is_malformed() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), "first\nsecond");
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));

        assert_eq!(client.call("frame"), Err(StallError::Malformed));
        assert_eq!(client.transport.frames(), &["frame".to_owned()]);
    }
}
