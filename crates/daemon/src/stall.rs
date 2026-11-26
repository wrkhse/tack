//! Seams for one bounded call to a stall.
//!
//! `Clock` and `Transport` are replaceable: a caller injects the real clock
//! and transport, while tests advance a fake clock and record the frames a
//! fake stall receives. The frames are `barn_stall`'s typed `Request` and
//! `Reply`: tack writes one JSON line and reads one line back. A request's
//! `_meta` is data the stall reads, never a source of grants.

use std::fmt;
use std::time::{Duration, Instant};

use barn_stall::{FRAMED_VERSION, Reply, Request};

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
    /// The reply was not a single line, or did not match the request.
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
    /// Returns `Malformed` when the request's version is not `FRAMED_VERSION`,
    /// the reply is not one line, the reply does not decode, or its id does
    /// not repeat the request's id. Returns `Io` when the request cannot be
    /// encoded, `Timeout` when the clock is at or past the deadline before or
    /// after the call, and the transport's error when the call fails.
    #[expect(
        clippy::needless_pass_by_value,
        reason = "the typed stall API owns the request it sends"
    )]
    pub fn call(&mut self, request: Request) -> Result<Reply, StallError> {
        let (request_id, version) = match &request {
            Request::Hook { id, version, .. } | Request::Tool { id, version, .. } => {
                (*id, *version)
            }
        };

        if version != FRAMED_VERSION {
            return Err(StallError::Malformed);
        }

        let frame =
            serde_json::to_string(&request).map_err(|error| StallError::Io(error.to_string()))?;

        let deadline = self.clock.deadline(self.budget);

        if self.clock.now() >= deadline {
            return Err(StallError::Timeout);
        }

        let wire = self.transport.call(&frame)?;

        if self.clock.now() >= deadline {
            return Err(StallError::Timeout);
        }

        if wire.lines().count() != 1 {
            return Err(StallError::Malformed);
        }

        let reply: Reply = serde_json::from_str(&wire).map_err(|_| StallError::Malformed)?;

        let reply_id = match &reply {
            Reply::Hook { id, .. } | Reply::Tool { id, .. } | Reply::Error { id, .. } => *id,
        };

        if reply_id != request_id {
            return Err(StallError::Malformed);
        }

        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use barn_stall::{Content, Meta, Outcome, ToolCall};
    use serde_json::json;

    use super::*;

    // The pinned examples from barn-stall's `fixtures/frames.jsonl` at rev
    // f301274cc23988f244a06c98ba8ba521b5c31ef7.
    const DENY_REQUEST: &str = r#"{"type":"hook","id":1,"version":1,"hook":"PreToolUse","call":{"tool":"bash","name":"run","input":{"command":"git push"}}}"#;
    const DENY_REPLY: &str =
        r#"{"type":"hook","id":1,"outcome":{"deny":{"reason":"push blocked"}}}"#;
    const TRACEPARENT: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const REWRITE_REQUEST: &str = r#"{"type":"hook","id":2,"version":1,"hook":"PostToolUse","call":{"tool":"github","name":"create_issue","input":{"title":"Fix flaky test"},"session_id":"sess-42"},"_meta":{"traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","tracestate":"congo=t61rcWkgMzE"}}"#;
    const REWRITE_REPLY: &str = r#"{"type":"hook","id":2,"outcome":{"rewrite":{"input":{"title":"Fix flaky test","labels":["bug","p1"]}}}}"#;
    const ANNOTATE_REQUEST: &str = r#"{"type":"hook","id":4,"version":1,"hook":"PostToolUse","call":{"tool":"notes","name":"write","input":{"path":"/tmp/a.txt","text":"hi"}}}"#;
    const ANNOTATE_REPLY: &str =
        r#"{"type":"hook","id":4,"outcome":{"annotate":{"fields":{"chauffeurTriaged":true}}}}"#;
    const TOOL_REQUEST: &str = r#"{"type":"tool","id":6,"version":1,"call":{"tool":"notes","name":"read","input":{"path":"/tmp/note.txt"}}}"#;
    const TOOL_REPLY: &str =
        r#"{"type":"tool","id":6,"content":{"kind":"text","text":"buy milk"}}"#;

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

    fn deny_request() -> Request {
        Request::Hook {
            id: 1,
            version: FRAMED_VERSION,
            hook: "PreToolUse".to_owned(),
            call: ToolCall {
                tool: "bash".to_owned(),
                name: "run".to_owned(),
                input: json!({"command": "git push"}),
                session_id: None,
            },
            _meta: None,
        }
    }

    fn deny_reply() -> Reply {
        Reply::Hook {
            id: 1,
            outcome: Outcome::Deny {
                reason: "push blocked".to_owned(),
            },
        }
    }

    fn rewrite_request() -> Request {
        Request::Hook {
            id: 2,
            version: FRAMED_VERSION,
            hook: "PostToolUse".to_owned(),
            call: ToolCall {
                tool: "github".to_owned(),
                name: "create_issue".to_owned(),
                input: json!({"title": "Fix flaky test"}),
                session_id: Some("sess-42".to_owned()),
            },
            _meta: Some(Meta {
                traceparent: Some(TRACEPARENT.to_owned()),
                tracestate: Some("congo=t61rcWkgMzE".to_owned()),
            }),
        }
    }

    fn rewrite_reply() -> Reply {
        Reply::Hook {
            id: 2,
            outcome: Outcome::Rewrite {
                input: json!({"title": "Fix flaky test", "labels": ["bug", "p1"]}),
            },
        }
    }

    #[test]
    fn reply_inside_budget_is_decoded_and_returned() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), DENY_REPLY);
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));

        let encoded_reply = serde_json::to_string(&deny_reply()).unwrap_or_default();

        assert_eq!(client.call(deny_request()), Ok(deny_reply()));
        assert_eq!(client.transport.frames(), &[DENY_REQUEST.to_owned()]);
        assert_eq!(encoded_reply, DENY_REPLY);
    }

    #[test]
    fn pre_expired_budget_times_out_without_calling() {
        let start = Instant::now();
        let clock = FakeClock::new(start);
        let stall = FakeStall::reply(clock.clone(), DENY_REPLY);
        let mut client = StallClient::new(clock.clone(), stall, Duration::from_secs(1));

        clock.advance(Duration::from_secs(1));

        let no_frames: &[String] = &[];

        assert_eq!(client.call(deny_request()), Err(StallError::Timeout));
        assert_eq!(client.transport.frames(), no_frames);
    }

    #[test]
    fn clock_advanced_during_call_times_out() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), DENY_REPLY).advancing(Duration::from_secs(2));
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));

        assert_eq!(client.call(deny_request()), Err(StallError::Timeout));
        assert_eq!(client.transport.frames(), &[DENY_REQUEST.to_owned()]);
    }

    #[test]
    fn closed_error_passes_through() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::error(clock.clone(), StallError::Closed);
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));

        assert_eq!(client.call(deny_request()), Err(StallError::Closed));
        assert_eq!(client.transport.frames(), &[DENY_REQUEST.to_owned()]);
    }

    #[test]
    fn multi_line_reply_is_malformed() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), "first\nsecond");
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));

        assert_eq!(client.call(deny_request()), Err(StallError::Malformed));
        assert_eq!(client.transport.frames(), &[DENY_REQUEST.to_owned()]);
    }

    #[test]
    fn undecodable_reply_is_malformed() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), "{not json}");
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));

        assert_eq!(client.call(deny_request()), Err(StallError::Malformed));
        assert_eq!(client.transport.frames(), &[DENY_REQUEST.to_owned()]);
    }

    #[test]
    fn reply_with_another_id_is_malformed() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), REWRITE_REPLY);
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));

        assert_eq!(client.call(deny_request()), Err(StallError::Malformed));
        assert_eq!(client.transport.frames(), &[DENY_REQUEST.to_owned()]);
    }

    #[test]
    fn wrong_request_version_is_malformed() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), DENY_REPLY);
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));
        let mut wrong = deny_request();

        if let Request::Hook { version, .. } = &mut wrong {
            *version = FRAMED_VERSION.saturating_add(1);
        }

        let no_frames: &[String] = &[];

        assert_eq!(client.call(wrong), Err(StallError::Malformed));
        assert_eq!(client.transport.frames(), no_frames);
    }

    #[test]
    fn hook_meta_serializes_to_the_pinned_line() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), REWRITE_REPLY);
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));

        assert_eq!(client.call(rewrite_request()), Ok(rewrite_reply()));
        assert_eq!(client.transport.frames(), &[REWRITE_REQUEST.to_owned()]);
    }

    #[test]
    fn rewrite_outcome_round_trips() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), REWRITE_REPLY);
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));

        let encoded_reply = serde_json::to_string(&rewrite_reply()).unwrap_or_default();

        assert_eq!(client.call(rewrite_request()), Ok(rewrite_reply()));
        assert_eq!(client.transport.frames(), &[REWRITE_REQUEST.to_owned()]);
        assert_eq!(encoded_reply, REWRITE_REPLY);
    }

    #[test]
    fn annotate_outcome_round_trips() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), ANNOTATE_REPLY);
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));
        let request = Request::Hook {
            id: 4,
            version: FRAMED_VERSION,
            hook: "PostToolUse".to_owned(),
            call: ToolCall {
                tool: "notes".to_owned(),
                name: "write".to_owned(),
                input: json!({"path": "/tmp/a.txt", "text": "hi"}),
                session_id: None,
            },
            _meta: None,
        };
        let fields = json!({"chauffeurTriaged": true});
        let expected = Reply::Hook {
            id: 4,
            outcome: Outcome::Annotate {
                fields: fields.as_object().cloned().unwrap_or_default(),
            },
        };
        let encoded_reply = serde_json::to_string(&expected).unwrap_or_default();

        assert_eq!(client.call(request), Ok(expected));
        assert_eq!(client.transport.frames(), &[ANNOTATE_REQUEST.to_owned()]);
        assert_eq!(encoded_reply, ANNOTATE_REPLY);
    }

    #[test]
    fn tool_pair_round_trips() {
        let clock = FakeClock::new(Instant::now());
        let stall = FakeStall::reply(clock.clone(), TOOL_REPLY);
        let mut client = StallClient::new(clock, stall, Duration::from_secs(1));
        let request = Request::Tool {
            id: 6,
            version: FRAMED_VERSION,
            call: ToolCall {
                tool: "notes".to_owned(),
                name: "read".to_owned(),
                input: json!({"path": "/tmp/note.txt"}),
                session_id: None,
            },
        };
        let expected = Reply::Tool {
            id: 6,
            content: Content {
                kind: "text".to_owned(),
                text: "buy milk".to_owned(),
            },
        };
        let encoded_reply = serde_json::to_string(&expected).unwrap_or_default();

        assert_eq!(client.call(request), Ok(expected));
        assert_eq!(client.transport.frames(), &[TOOL_REQUEST.to_owned()]);
        assert_eq!(encoded_reply, TOOL_REPLY);
    }
}
