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
    Content as StallContent, FRAMED_VERSION, Meta as StallMeta, Outcome as StallOutcome,
    Reply as StallReply, Request as StallRequest, ToolCall as StallToolCall,
};
use tack_protocol::wire::{
    Content, HookKind, Meta as WireMeta, Outcome, PROTOCOL_VERSION, Reply, ReplyError, Request,
    ToolCall, hook_kind,
};

/// A frame the two contracts cannot express for each other.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConvertError {
    /// The reply's id or kind does not answer the request.
    UnsupportedOutcome,
}

impl fmt::Display for ConvertError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::UnsupportedOutcome => "unsupported_outcome",
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
/// The mapping is total: both wire variants have a stall frame, so this
/// returns `Ok` for every request. The `Result` keeps the shape of the reply
/// mapping.
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

    match (hook_kind(hook), outcome) {
        (Some(HookKind::Tool | HookKind::Event), StallOutcome::Allow) => Outcome::Allow,
        (Some(HookKind::Tool | HookKind::Event), StallOutcome::Deny { reason }) => {
            Outcome::Deny { reason }
        }
        (Some(HookKind::Tool | HookKind::Event), StallOutcome::Rewrite { input }) => {
            Outcome::Rewrite { input }
        }
        (Some(HookKind::Event), StallOutcome::Annotate { fields }) => Outcome::Annotate { fields },
        (Some(HookKind::Event), StallOutcome::Drop) => Outcome::Drop,
        (Some(HookKind::Tool), StallOutcome::Annotate { .. } | StallOutcome::Drop) => {
            Outcome::Deny {
                reason: format!("tack: {name} not valid for {hook}"),
            }
        }
        (None, _) => Outcome::Deny {
            reason: format!("tack: unknown hook {hook}"),
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
/// A registered event hook accepts all five outcomes; a registered tool hook
/// denies annotate and drop with the outcome and hook named. An unknown hook
/// denies every outcome, so no reply can turn into an allow.
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

fn wire_meta(meta: &StallMeta) -> WireMeta {
    WireMeta {
        traceparent: meta.traceparent.clone(),
        tracestate: meta.tracestate.clone(),
    }
}

/// Translate a stall request into the wire request the daemon dispatches.
///
/// A hook keeps its id, name, call and trace data. A tool keeps its id, name
/// and input; the stall's tool name and session stay at the stall boundary.
/// Both carry tack's protocol version.
///
/// # Errors
///
/// Returns `UnsupportedOutcome` when a hook name is outside tack's closed
/// registry: no wire verdict can answer a hook the daemon cannot dispatch.
pub fn from_stall_request(request: &StallRequest) -> Result<Request, ConvertError> {
    match request {
        StallRequest::Hook {
            id,
            hook,
            call,
            _meta: meta,
            ..
        } => {
            if hook_kind(hook).is_none() {
                return Err(ConvertError::UnsupportedOutcome);
            }

            Ok(Request::Hook {
                id: *id,
                version: PROTOCOL_VERSION,
                hook: hook.clone(),
                call: ToolCall {
                    tool: call.tool.clone(),
                    name: call.name.clone(),
                    input: call.input.clone(),
                    session_id: call.session_id.clone(),
                },
                _meta: meta.as_ref().map(wire_meta),
            })
        }
        StallRequest::Tool { id, call, .. } => Ok(Request::Tool {
            id: *id,
            version: PROTOCOL_VERSION,
            name: call.name.clone(),
            input: call.input.clone(),
        }),
    }
}

fn stall_outcome(outcome: &Outcome) -> StallOutcome {
    match outcome {
        Outcome::Allow => StallOutcome::Allow,
        Outcome::Deny { reason } => StallOutcome::Deny {
            reason: reason.clone(),
        },
        Outcome::Rewrite { input } => StallOutcome::Rewrite {
            input: input.clone(),
        },
        Outcome::Annotate { fields } => StallOutcome::Annotate {
            fields: fields.clone(),
        },
        Outcome::Drop => StallOutcome::Drop,
    }
}

fn stall_error_name(error: ReplyError) -> Result<String, ConvertError> {
    serde_json::to_value(error)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or(ConvertError::UnsupportedOutcome)
}

/// Translate a wire reply into the frame a stall reads.
///
/// All five hook outcomes have a stall form. Tack's tool verdict carries
/// exactly one content item today, so a stall's tool reply holds one piece
/// of content; an error keeps its wire name and message.
///
/// # Errors
///
/// Returns `UnsupportedOutcome` when a tool reply does not carry exactly one
/// piece of content, or its error kind has no wire name.
pub fn to_stall_reply(reply: &Reply) -> Result<StallReply, ConvertError> {
    match reply {
        Reply::Hook { id, outcome, .. } => Ok(StallReply::Hook {
            id: *id,
            outcome: stall_outcome(outcome),
        }),
        Reply::Tool { id, content, .. } => {
            let [only] = content.as_slice() else {
                return Err(ConvertError::UnsupportedOutcome);
            };

            Ok(StallReply::Tool {
                id: *id,
                content: StallContent {
                    kind: only.kind.clone(),
                    text: only.text.clone(),
                },
            })
        }
        Reply::Error {
            id, error, message, ..
        } => Ok(StallReply::Error {
            id: *id,
            error: stall_error_name(*error)?,
            message: message.clone(),
        }),
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
            .expect("fields fixture is an object")
            .clone()
    }

    #[test]
    fn convert_errors_display_stable_messages() {
        assert_eq!(
            ConvertError::UnsupportedOutcome.to_string(),
            "unsupported_outcome"
        );
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
    fn event_tool_and_unknown_hooks_deny_every_outcome() {
        for (name, reason) in [
            ("eventTool", "tack: unknown hook eventTool"),
            ("unrelatedHook", "tack: unknown hook unrelatedHook"),
        ] {
            for outcome in [
                StallOutcome::Allow,
                StallOutcome::Deny {
                    reason: "push blocked".to_owned(),
                },
                StallOutcome::Rewrite { input: json!({}) },
                StallOutcome::Annotate { fields: fields() },
                StallOutcome::Drop,
            ] {
                assert_eq!(
                    from_stall(&hook(name), StallReply::Hook { id: 7, outcome }),
                    Ok(Reply::Hook {
                        id: 7,
                        version: PROTOCOL_VERSION,
                        outcome: Outcome::Deny {
                            reason: reason.to_owned(),
                        },
                    })
                );
            }
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

    #[test]
    fn a_tool_request_with_a_hook_reply_is_unsupported() {
        assert_eq!(
            from_stall(
                &tool(),
                StallReply::Hook {
                    id: 8,
                    outcome: StallOutcome::Allow,
                }
            ),
            Err(ConvertError::UnsupportedOutcome)
        );
    }

    fn stall_hook() -> StallRequest {
        StallRequest::Hook {
            id: 7,
            version: FRAMED_VERSION,
            hook: "toolBefore".to_owned(),
            call: call(),
            _meta: None,
        }
    }

    fn stall_tool() -> StallRequest {
        StallRequest::Tool {
            id: 8,
            version: FRAMED_VERSION,
            call: StallToolCall {
                tool: "notes".to_owned(),
                name: "read".to_owned(),
                input: json!({ "path": "/tmp/note.txt" }),
                session_id: Some("s-9".to_owned()),
            },
        }
    }

    #[test]
    fn stall_hook_request_maps_every_field() {
        assert_eq!(from_stall_request(&stall_hook()), Ok(hook("toolBefore")));
    }

    #[test]
    fn stall_tool_request_maps_name_and_input_without_session_or_meta() {
        assert_eq!(
            from_stall_request(&stall_tool()),
            Ok(Request::Tool {
                id: 8,
                version: PROTOCOL_VERSION,
                name: "read".to_owned(),
                input: json!({ "path": "/tmp/note.txt" }),
            })
        );
    }

    #[test]
    fn stall_trace_meta_crosses_into_the_wire_request() {
        let mut request = stall_hook();

        if let StallRequest::Hook { _meta: meta, .. } = &mut request {
            *meta = Some(StallMeta {
                traceparent: Some(TRACEPARENT.to_owned()),
                tracestate: Some("congo=t61rcWkgMzE".to_owned()),
            });
        }

        let mut expected = hook("toolBefore");

        if let Request::Hook { _meta: meta, .. } = &mut expected {
            *meta = Some(WireMeta {
                traceparent: Some(TRACEPARENT.to_owned()),
                tracestate: Some("congo=t61rcWkgMzE".to_owned()),
            });
        }

        assert_eq!(from_stall_request(&request), Ok(expected));
    }

    #[test]
    fn stall_partial_trace_meta_stays_partial() {
        let mut request = stall_hook();

        if let StallRequest::Hook { _meta: meta, .. } = &mut request {
            *meta = Some(StallMeta {
                traceparent: Some(TRACEPARENT.to_owned()),
                tracestate: None,
            });
        }

        let mut expected = hook("toolBefore");

        if let Request::Hook { _meta: meta, .. } = &mut expected {
            *meta = Some(WireMeta {
                traceparent: Some(TRACEPARENT.to_owned()),
                tracestate: None,
            });
        }

        assert_eq!(from_stall_request(&request), Ok(expected));
    }

    #[test]
    fn an_unknown_stall_hook_is_unsupported() {
        let mut request = stall_hook();

        if let StallRequest::Hook { hook: name, .. } = &mut request {
            *name = "PreToolUse".to_owned();
        }

        assert_eq!(
            from_stall_request(&request),
            Err(ConvertError::UnsupportedOutcome)
        );
    }

    #[test]
    fn wire_hook_outcomes_map_to_every_stall_outcome() {
        let cases = [
            (Outcome::Allow, StallOutcome::Allow),
            (
                Outcome::Deny {
                    reason: "push blocked".to_owned(),
                },
                StallOutcome::Deny {
                    reason: "push blocked".to_owned(),
                },
            ),
            (
                Outcome::Rewrite {
                    input: json!({ "command": "git push --dry-run" }),
                },
                StallOutcome::Rewrite {
                    input: json!({ "command": "git push --dry-run" }),
                },
            ),
            (
                Outcome::Annotate { fields: fields() },
                StallOutcome::Annotate { fields: fields() },
            ),
            (Outcome::Drop, StallOutcome::Drop),
        ];

        for (outcome, expected) in cases {
            assert_eq!(
                to_stall_reply(&Reply::Hook {
                    id: 7,
                    version: PROTOCOL_VERSION,
                    outcome,
                }),
                Ok(StallReply::Hook {
                    id: 7,
                    outcome: expected,
                })
            );
        }
    }

    #[test]
    fn wire_tool_content_maps_to_stall_content() {
        assert_eq!(
            to_stall_reply(&Reply::Tool {
                id: 8,
                version: PROTOCOL_VERSION,
                content: vec![Content {
                    kind: "text".to_owned(),
                    text: "buy milk".to_owned(),
                }],
            }),
            Ok(StallReply::Tool {
                id: 8,
                content: StallContent {
                    kind: "text".to_owned(),
                    text: "buy milk".to_owned(),
                },
            })
        );
    }

    #[test]
    fn wire_tool_content_that_is_not_one_item_is_unsupported() {
        for content in [
            vec![],
            vec![
                Content {
                    kind: "text".to_owned(),
                    text: "a".to_owned(),
                },
                Content {
                    kind: "text".to_owned(),
                    text: "b".to_owned(),
                },
            ],
        ] {
            assert_eq!(
                to_stall_reply(&Reply::Tool {
                    id: 8,
                    version: PROTOCOL_VERSION,
                    content,
                }),
                Err(ConvertError::UnsupportedOutcome)
            );
        }
    }

    #[test]
    fn two_tool_content_items_are_unsupported() {
        assert_eq!(
            to_stall_reply(&Reply::Tool {
                id: 8,
                version: PROTOCOL_VERSION,
                content: vec![
                    Content {
                        kind: "text".to_owned(),
                        text: "a".to_owned(),
                    },
                    Content {
                        kind: "text".to_owned(),
                        text: "b".to_owned(),
                    },
                ],
            }),
            Err(ConvertError::UnsupportedOutcome)
        );
    }

    #[test]
    fn an_unsupported_reply_kind_is_rejected() {
        assert_eq!(
            from_stall(
                &hook("eventBefore"),
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

    #[test]
    fn a_daemon_error_keeps_its_message_in_the_stall_reply() {
        assert_eq!(
            to_stall_reply(&Reply::Error {
                id: 8,
                version: PROTOCOL_VERSION,
                error: ReplyError::DaemonError,
                message: "tack: stall unavailable".to_owned(),
            }),
            Ok(StallReply::Error {
                id: 8,
                error: "daemon_error".to_owned(),
                message: "tack: stall unavailable".to_owned(),
            })
        );
    }

    #[test]
    fn wire_error_maps_to_a_stall_error_with_its_message() {
        for (error, name) in [
            (ReplyError::DaemonError, "daemon_error"),
            (ReplyError::UnsupportedHook, "unsupported_hook"),
        ] {
            assert_eq!(
                to_stall_reply(&Reply::Error {
                    id: 8,
                    version: PROTOCOL_VERSION,
                    error,
                    message: "stall unavailable".to_owned(),
                }),
                Ok(StallReply::Error {
                    id: 8,
                    error: name.to_owned(),
                    message: "stall unavailable".to_owned(),
                })
            );
        }
    }
}
