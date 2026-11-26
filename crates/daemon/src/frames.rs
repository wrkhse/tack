//! Mapping tack's wire frames onto barn-stall's framed contract.
//!
//! The daemon translates the request a wrapper sends into the frame a stall
//! reads, then translates the stall's reply into the verdict the wrapper
//! expects. Neither contract is redefined here: this module is the only place
//! the two meet.
//!
//! Trace context in _meta is data. It crosses the boundary unchanged and
//! never grants a tool, a session or a verdict.

use std::fmt;

use barn_stall::{
    FRAMED_VERSION, Meta as StallMeta, Outcome as StallOutcome, Reply as StallReply,
    Request as StallRequest, ToolCall as StallToolCall,
};
use tack_protocol::wire::{
    Content, Meta as WireMeta, Outcome, PROTOCOL_VERSION, Reply, ReplyError, Request, ToolCall,
};

/// A frame the two contracts cannot express for each other.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConvertError {
    /// The reply's id or kind does not answer the request.
    UnsupportedOutcome,
    /// Trace context the request needs is absent.
    MissingMeta,
}

impl fmt::Display for ConvertError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::UnsupportedOutcome => "unsupported_outcome",
            Self::MissingMeta => "missing_meta",
        };

        f.write_str(message)
    }
}

impl std::error::Error for ConvertError {}

fn stall_call(call: &ToolCall) -> StallToolCall {
    StallToolCall {
        tool: call.tool.clone(),
        name: call.name.clone(),
        input: call.input.clone(),
        session_id: call.session_id.clone(),
    }
}

fn stall_meta(meta: &WireMeta) -> StallMeta {
    StallMeta {
        traceparent: meta.traceparent.clone(),
        tracestate: meta.tracestate.clone(),
    }
}

/// Translate a wire request into the frame a stall reads.
///
/// A hook keeps its id, name and call and carries _meta as trace data. A
/// tool runs under the tack tool name with no session and no trace context.
///
/// # Errors
///
/// Returns `UnsupportedOutcome` when the request has no stall frame. Both wire
/// variants have one, so the mapping itself is total.
pub fn to_stall(request: &Request) -> Result<StallRequest, ConvertError> {
    match request {
        Request::Hook {
            id,
            hook,
            call,
            _meta: meta,
            ..
        } => Ok(StallRequest::Hook {
            id: *id,
            version: FRAMED_VERSION,
            hook: hook.clone(),
            call: stall_call(call),
            _meta: meta.as_ref().map(stall_meta),
        }),
        Request::Tool {
            id, name, input, ..
        } => Ok(StallRequest::Tool {
            id: *id,
            version: FRAMED_VERSION,
            call: StallToolCall {
                tool: "tack".to_owned(),
                name: name.clone(),
                input: input.clone(),
                session_id: None,
            },
        }),
    }
}

fn is_event_hook(hook: &str) -> bool {
    hook.starts_with("event")
}

const fn outcome_name(outcome: &StallOutcome) -> &'static str {
    match outcome {
        StallOutcome::Allow => "allow",
        StallOutcome::Deny { .. } => "deny",
        StallOutcome::Rewrite { .. } => "rewrite",
        StallOutcome::Annotate { .. } => "annotate",
        StallOutcome::Drop => "drop",
    }
}

fn wire_outcome(outcome: StallOutcome, hook: &str) -> Outcome {
    let name = outcome_name(&outcome);

    match outcome {
        StallOutcome::Allow => Outcome::Allow,
        StallOutcome::Deny { reason } => Outcome::Deny { reason },
        StallOutcome::Rewrite { input } => Outcome::Rewrite { input },
        StallOutcome::Annotate { fields } if is_event_hook(hook) => Outcome::Annotate { fields },
        StallOutcome::Drop if is_event_hook(hook) => Outcome::Drop,
        StallOutcome::Annotate { .. } | StallOutcome::Drop => Outcome::Deny {
            reason: format!("tack: {name} not valid for {hook}"),
        },
    }
}

const fn reply_id(reply: &StallReply) -> u64 {
    match reply {
        StallReply::Hook { id, .. }
        | StallReply::Tool { id, .. }
        | StallReply::Error { id, .. } => *id,
    }
}

/// Translate a stall reply into the wire verdict for request.
///
/// An event hook accepts all five outcomes. A tool hook that receives
/// annotate or drop gets a deny naming the outcome and the hook, never an
/// allow.
///
/// # Errors
///
/// Returns `UnsupportedOutcome` when the reply's id or kind does not answer the
/// request.
pub fn from_stall(request: &Request, reply: StallReply) -> Result<Reply, ConvertError> {
    let id = reply_id(&reply);

    if id != request.id() {
        return Err(ConvertError::UnsupportedOutcome);
    }

    match (request, reply) {
        (Request::Hook { hook, .. }, StallReply::Hook { outcome, .. }) => Ok(Reply::Hook {
            id,
            version: PROTOCOL_VERSION,
            outcome: wire_outcome(outcome, hook),
        }),
        (Request::Tool { .. }, StallReply::Tool { content, .. }) => Ok(Reply::Tool {
            id,
            version: PROTOCOL_VERSION,
            content: vec![Content {
                kind: content.kind,
                text: content.text,
            }],
        }),
        (_, StallReply::Error { message, .. }) => Ok(Reply::Error {
            id,
            version: PROTOCOL_VERSION,
            error: ReplyError::DaemonError,
            message,
        }),
        _ => Err(ConvertError::UnsupportedOutcome),
    }
}

#[cfg(test)]
mod tests {
    use barn_stall::Content as StallContent;
    use serde_json::{Map, Value, json};

    use super::*;

    const TRACEPARENT: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    fn hook(name: &str) -> Request {
        Request::Hook {
            id: 7,
            version: PROTOCOL_VERSION,
            hook: name.to_owned(),
            call: ToolCall {
                tool: "shell".to_owned(),
                name: "bash".to_owned(),
                input: json!({ "command": "git push" }),
                session_id: Some("s-1".to_owned()),
            },
            _meta: None,
        }
    }

    fn tool() -> Request {
        Request::Tool {
            id: 8,
            version: PROTOCOL_VERSION,
            name: "guard_status".to_owned(),
            input: json!({}),
        }
    }

    fn call() -> StallToolCall {
        StallToolCall {
            tool: "shell".to_owned(),
            name: "bash".to_owned(),
            input: json!({ "command": "git push" }),
            session_id: Some("s-1".to_owned()),
        }
    }

    fn fields() -> Map<String, Value> {
        json!({ "chauffeurTriaged": true })
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    #[test]
    fn convert_errors_display_stable_messages() {
        assert_eq!(
            ConvertError::UnsupportedOutcome.to_string(),
            "unsupported_outcome"
        );
        assert_eq!(ConvertError::MissingMeta.to_string(), "missing_meta");
    }

    #[test]
    fn hook_request_maps_to_a_stall_hook_with_the_call() {
        assert_eq!(
            to_stall(&hook("toolBefore")),
            Ok(StallRequest::Hook {
                id: 7,
                version: FRAMED_VERSION,
                hook: "toolBefore".to_owned(),
                call: call(),
                _meta: None,
            })
        );
    }

    #[test]
    fn tool_request_maps_to_a_tack_tool_call_without_meta() {
        assert_eq!(
            to_stall(&tool()),
            Ok(StallRequest::Tool {
                id: 8,
                version: FRAMED_VERSION,
                call: StallToolCall {
                    tool: "tack".to_owned(),
                    name: "guard_status".to_owned(),
                    input: json!({}),
                    session_id: None,
                },
            })
        );
    }

    #[test]
    fn both_trace_fields_cross_into_the_stall_request() {
        let mut request = hook("eventBefore");

        if let Request::Hook { _meta: meta, .. } = &mut request {
            *meta = Some(WireMeta {
                traceparent: Some(TRACEPARENT.to_owned()),
                tracestate: Some("congo=t61rcWkgMzE".to_owned()),
            });
        }

        assert_eq!(
            to_stall(&request),
            Ok(StallRequest::Hook {
                id: 7,
                version: FRAMED_VERSION,
                hook: "eventBefore".to_owned(),
                call: call(),
                _meta: Some(StallMeta {
                    traceparent: Some(TRACEPARENT.to_owned()),
                    tracestate: Some("congo=t61rcWkgMzE".to_owned()),
                }),
            })
        );
    }

    #[test]
    fn partial_and_absent_trace_meta_stay_that_way() {
        let mut partial = hook("toolBefore");

        if let Request::Hook { _meta: meta, .. } = &mut partial {
            *meta = Some(WireMeta {
                traceparent: Some(TRACEPARENT.to_owned()),
                tracestate: None,
            });
        }

        assert_eq!(
            to_stall(&partial),
            Ok(StallRequest::Hook {
                id: 7,
                version: FRAMED_VERSION,
                hook: "toolBefore".to_owned(),
                call: call(),
                _meta: Some(StallMeta {
                    traceparent: Some(TRACEPARENT.to_owned()),
                    tracestate: None,
                }),
            })
        );
        assert_eq!(
            to_stall(&hook("toolBefore")),
            Ok(StallRequest::Hook {
                id: 7,
                version: FRAMED_VERSION,
                hook: "toolBefore".to_owned(),
                call: call(),
                _meta: None,
            })
        );
    }

    #[test]
    fn event_hook_maps_every_outcome() {
        let request = hook("eventBefore");
        let cases = [
            (StallOutcome::Allow, Outcome::Allow),
            (
                StallOutcome::Deny {
                    reason: "push blocked".to_owned(),
                },
                Outcome::Deny {
                    reason: "push blocked".to_owned(),
                },
            ),
            (
                StallOutcome::Rewrite {
                    input: json!({ "command": "git push --dry-run" }),
                },
                Outcome::Rewrite {
                    input: json!({ "command": "git push --dry-run" }),
                },
            ),
            (
                StallOutcome::Annotate { fields: fields() },
                Outcome::Annotate { fields: fields() },
            ),
            (StallOutcome::Drop, Outcome::Drop),
        ];

        for (outcome, expected) in cases {
            assert_eq!(
                from_stall(&request, StallReply::Hook { id: 7, outcome }),
                Ok(Reply::Hook {
                    id: 7,
                    version: PROTOCOL_VERSION,
                    outcome: expected,
                })
            );
        }
    }

    #[test]
    fn tool_hook_denies_annotate_and_drop() {
        let request = hook("toolBefore");
        let cases = [
            (StallOutcome::Annotate { fields: fields() }, "annotate"),
            (StallOutcome::Drop, "drop"),
        ];

        for (outcome, name) in cases {
            assert_eq!(
                from_stall(&request, StallReply::Hook { id: 7, outcome }),
                Ok(Reply::Hook {
                    id: 7,
                    version: PROTOCOL_VERSION,
                    outcome: Outcome::Deny {
                        reason: format!("tack: {name} not valid for toolBefore"),
                    },
                })
            );
        }
    }

    #[test]
    fn stall_tool_content_maps_to_one_wire_content() {
        assert_eq!(
            from_stall(
                &tool(),
                StallReply::Tool {
                    id: 8,
                    content: StallContent {
                        kind: "text".to_owned(),
                        text: "buy milk".to_owned(),
                    },
                }
            ),
            Ok(Reply::Tool {
                id: 8,
                version: PROTOCOL_VERSION,
                content: vec![Content {
                    kind: "text".to_owned(),
                    text: "buy milk".to_owned(),
                }],
            })
        );
    }

    #[test]
    fn stall_error_maps_to_a_daemon_error() {
        assert_eq!(
            from_stall(
                &tool(),
                StallReply::Error {
                    id: 8,
                    error: "denied".to_owned(),
                    message: "stall unavailable".to_owned(),
                }
            ),
            Ok(Reply::Error {
                id: 8,
                version: PROTOCOL_VERSION,
                error: ReplyError::DaemonError,
                message: "stall unavailable".to_owned(),
            })
        );
    }

    #[test]
    fn mismatched_id_is_rejected() {
        assert_eq!(
            from_stall(
                &hook("toolBefore"),
                StallReply::Hook {
                    id: 9,
                    outcome: StallOutcome::Allow,
                }
            ),
            Err(ConvertError::UnsupportedOutcome)
        );
    }

    #[test]
    fn mismatched_kind_is_rejected() {
        assert_eq!(
            from_stall(
                &hook("toolBefore"),
                StallReply::Tool {
                    id: 7,
                    content: StallContent {
                        kind: "text".to_owned(),
                        text: "buy milk".to_owned(),
                    },
                }
            ),
            Err(ConvertError::UnsupportedOutcome)
        );
    }
}
