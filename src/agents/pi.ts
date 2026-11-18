import { fileURLToPath } from "node:url";

import { Cause, Duration, Effect, Exit, Option, Predicate } from "effect";
import type {
  BashToolCallEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  PowerShellToolCallEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import type { HostSlot, Registration } from "../host/host.ts";
import { hostSlot } from "../host/host.ts";
import { runSessionCreated, runSessionEnded } from "../hooks/lifecycle.ts";
import { runPromptSent } from "../hooks/prompt-sent.ts";
import type { ResponseReason } from "../hooks/response-finished.ts";
import { runResponseFinished } from "../hooks/response-finished.ts";
import { runSessionIdle } from "../hooks/session-idle.ts";
import type { ToolResult } from "../hooks/tool-after.ts";
import { runToolAfter } from "../hooks/tool-after.ts";
import type { HookContext, ToolCall } from "../hooks/tool-before.ts";
import type { ResolvedPlugin } from "../plugin.ts";
import type { AppendWhen, ModelRef, Outcome, SessionPort } from "../session.ts";
import { sessionHandle } from "../session.ts";
import { runBefore } from "./chain.ts";
import { joinTextParts } from "./text.ts";

/** The scope every Pi extension in one process shares. */
const PI_SCOPE = "pi";

/**
 * The file this adapter was loaded from. Each plugin bundles its own copy of
 * tack, so under a bundle this names that plugin's bundle file.
 */
const SOURCE = fileURLToPath(import.meta.url);

/** A Pi 1.5 extension factory. */
export type PiExtension = (pi: ExtensionAPI) => void;

/** Bash and PowerShell both carry their command in `input.command`. */
type ShellToolCallEvent = BashToolCallEvent | PowerShellToolCallEvent;

/**
 * One live extension instance: its slot registration, the API it acts
 * through, and whether it has shut down. Pi rebinds the extension for each
 * session, so an instance that shut down acts on a session that has ended.
 */
interface Attachment {
  readonly slot: HostSlot;
  readonly registration: Registration;
  readonly pi: ExtensionAPI;
  readonly isEnded: () => boolean;
}

/** Pi hands hooks as promise callbacks, so each crossing into Effect is here. */
function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

/** True when the call's tool is a shell and its input carries a command. */
function isShellCall(event: ToolCallEvent): event is ShellToolCallEvent {
  return (
    (event.toolName === "bash" || event.toolName === "powershell") &&
    Predicate.isObject(event.input) &&
    Predicate.isString(event.input["command"])
  );
}

/** tack's view of a Pi tool call or result: a shell command, or the agent's own tool. */
function callOf(event: ToolCallEvent | ToolResultEvent): ToolCall {
  const name = event.toolName;
  const input = event.input;

  if (
    (name === "bash" || name === "powershell") &&
    Predicate.hasProperty("command")(input) &&
    Predicate.isString(input["command"])
  ) {
    return {
      tool: "shell",
      name,
      dialect: name === "bash" ? "posix" : "powershell",
      input: { command: input["command"] },
    };
  }

  return { tool: "other", name, input };
}

/** Pi requires rewrites in place; no validation runs after the mutation. */
function assignRewrite(event: ToolCallEvent, call: ToolCall): void {
  if (call.tool !== "shell" || !isShellCall(event)) {
    return;
  }

  event.input.command = call.input.command;
}

/** The outcome a native call that resolved reports. */
const ACCEPTED: Outcome = { status: "accepted" };

/** The outcome an action reports once its extension instance shut down or went stale. */
const ENDED: Outcome = { status: "ended" };

/**
 * The custom message type every append carries. Pi admits a `sendMessage`
 * message as a custom message without running its `input` hook, so an append
 * is never transformed again; `input` runs only for `sendUserMessage`, whose
 * source `extension` the adapter skips.
 */
const APPEND_TYPE = "tack.append";

/** A refusal naming what the agent would not do. */
function refused(reason: string): Outcome {
  return { status: "refused", reason };
}

/** The `sendMessage` options one delivery takes; only `wake` starts a turn. */
interface Delivery {
  readonly deliverAs: "steer" | "followUp";
  readonly triggerTurn?: true;
}

/**
 * The options one `when` sends with. `triggerTurn` is present only for
 * `wake`: Pi's `agent-session.js` tests `triggerTurn !== false` before it
 * reads `deliverAs`, so an explicit `false` would queue `now` and `next`
 * for the `turn_end` flush, and `next` would behave as `now`. Leaving the
 * key out delivers each by its mode, and an idle session stores the message
 * without starting a run.
 */
function deliveryOf(when: AppendWhen): Delivery {
  if (when === "wake") {
    return { deliverAs: "steer", triggerTurn: true };
  }

  if (when === "next") {
    return { deliverAs: "followUp" };
  }

  return { deliverAs: "steer" };
}

/**
 * Appends text as a synthetic message nobody typed. Only `wake` starts a
 * turn, so an idle session stores the other two without running the agent.
 */
function appendTo(pi: ExtensionAPI, text: string, when: AppendWhen): void {
  pi.sendMessage(
    { customType: APPEND_TYPE, content: [{ type: "text", text }], display: false, details: {} },
    deliveryOf(when),
  );
}

/** The message Pi rejects a captured instance with once its session was replaced. */
const STALE_PREFIX = "This extension ctx is stale";

/** True when Pi refused a call because the captured instance no longer serves a session. */
function isStale(cause: unknown): boolean {
  return cause instanceof Error && cause.message.startsWith(STALE_PREFIX);
}

/** The outcome a throw or rejection names: a stale instance has ended, anything else is refused. */
function failureOf(cause: unknown): Outcome {
  if (isStale(cause)) {
    return ENDED;
  }

  return refused(cause instanceof Error ? cause.message : String(cause));
}

/** Runs one action, reporting `ended` once its instance shut down or went stale. */
function act(attachment: Attachment, perform: () => void | Promise<void>): Promise<Outcome> {
  if (attachment.isEnded()) {
    return Promise.resolve(ENDED);
  }

  return Promise.resolve()
    .then(perform)
    .then(
      () => ACCEPTED,
      (cause): Outcome => failureOf(cause),
    );
}

/** Switches the model, refusing one this agent does not have or cannot authenticate. */
function switchModel(
  attachment: Attachment,
  context: ExtensionContext,
  model: ModelRef,
): Promise<Outcome> {
  if (attachment.isEnded()) {
    return Promise.resolve(ENDED);
  }

  const found = context.modelRegistry.find(model.providerID, model.id);

  if (found === undefined) {
    return Promise.resolve(refused(`no model ${model.providerID}/${model.id} for this agent`));
  }

  return Promise.resolve()
    .then(() => attachment.pi.setModel(found))
    .then(
      (applied): Outcome =>
        applied ? ACCEPTED : refused(`no credentials for ${model.providerID}/${model.id}`),
      (cause): Outcome => failureOf(cause),
    );
}

/** How long Pi gets to report a requested compaction before tack stops waiting. */
const COMPACT_REPORT_MS = 60_000;

/**
 * Requests compaction and reports Pi's own outcome. Pi returns from `compact`
 * before compaction runs, so its callbacks are the only report: completing
 * accepts, failing refuses with its message, and an attempt that reports
 * neither within the bound refuses. A stale instance has ended.
 */
function compactIn(attachment: Attachment, context: ExtensionContext): Promise<Outcome> {
  if (attachment.isEnded()) {
    return Promise.resolve(ENDED);
  }

  const request = Effect.callback<Outcome>((resume) => {
    try {
      context.compact({
        onComplete: () => resume(Effect.succeed(ACCEPTED)),
        onError: (error) => resume(Effect.succeed(failureOf(error))),
      });
    } catch (cause) {
      resume(Effect.succeed(failureOf(cause)));
    }
  });

  const timeout = Effect.sleep(Duration.millis(COMPACT_REPORT_MS)).pipe(
    Effect.as(refused("compaction did not report")),
  );

  return run(Effect.raceFirst(request, timeout));
}

/**
 * The actions one Pi session handle performs, through the extension context
 * the action was reached from. Pi's API acts on that context's session, so the
 * port ignores the session id every action carries.
 */
function piSessionPort(attachment: Attachment, context: ExtensionContext): SessionPort {
  return {
    append: (input) => act(attachment, () => appendTo(attachment.pi, input.text, input.when)),
    compact: () => compactIn(attachment, context),
    interrupt: () => act(attachment, () => context.abort()),
    setModel: (input) => switchModel(attachment, context, input.model),
  };
}

/** One event's hook context: the session's id and the handle that acts on it. */
function contextOf(attachment: Attachment, context: ExtensionContext): HookContext {
  const sessionId = context.sessionManager.getSessionId();

  return {
    agent: "pi",
    sessionId,
    session: sessionHandle(piSessionPort(attachment, context), sessionId),
  };
}

/** A session Pi started from an existing one is the session tack inherited. */
function wasResumed(reason: SessionStartEvent["reason"]): boolean {
  return reason === "resume" || reason === "fork";
}

/** `quit` ends the whole agent; every other shutdown replaces the session. */
function endReasonOf(reason: SessionShutdownEvent["reason"]): "shutdown" | "replaced" {
  return reason === "quit" ? "shutdown" : "replaced";
}

/** Pi's turn outcome maps straight onto tack's response reasons. */
function responseReasonOf(outcome: TurnEndEvent["outcome"]): ResponseReason {
  if (outcome === "completed") {
    return "done";
  }

  return outcome;
}

/** Reports the session Pi has just started. */
function handleSessionStart(
  attachment: Attachment,
  event: SessionStartEvent,
  context: ExtensionContext,
): void | Promise<void> {
  if (!attachment.slot.isLeader(attachment.registration)) {
    return;
  }

  const ctx = contextOf(attachment, context);

  return run(
    runSessionCreated(
      attachment.slot.plugins(attachment.registration.scope),
      { session: ctx.session, resumed: wasResumed(event.reason) },
      ctx,
    ),
  );
}

/** Reports the session Pi is shutting down, before its registrations are disposed. */
function handleSessionShutdown(
  attachment: Attachment,
  event: SessionShutdownEvent,
  context: ExtensionContext,
): Promise<void> {
  if (!attachment.slot.isLeader(attachment.registration)) {
    return Promise.resolve();
  }

  const ctx = contextOf(attachment, context);

  return run(
    runSessionEnded(
      attachment.slot.plugins(attachment.registration.scope),
      { session: ctx.session, reason: endReasonOf(event.reason) },
      ctx,
    ),
  );
}

/** Reports one finished model request from its turn outcome. */
function handleTurnEnd(
  attachment: Attachment,
  event: TurnEndEvent,
  context: ExtensionContext,
): void | Promise<void> {
  if (!attachment.slot.isLeader(attachment.registration)) {
    return;
  }

  const ctx = contextOf(attachment, context);

  return run(
    runResponseFinished(
      attachment.slot.plugins(attachment.registration.scope),
      { session: ctx.session, reason: responseReasonOf(event.outcome) },
      ctx,
    ),
  );
}

/** Reports the final idle signal Pi leaves after a settled run. */
function handleAgentSettled(
  attachment: Attachment,
  context: ExtensionContext,
): void | Promise<void> {
  if (!attachment.slot.isLeader(attachment.registration)) {
    return;
  }

  const ctx = contextOf(attachment, context);

  return run(
    runSessionIdle(
      attachment.slot.plugins(attachment.registration.scope),
      { session: ctx.session },
      ctx,
    ),
  );
}

/** Runs `toolBefore` and returns Pi's block result for a deny. */
function handleToolCall(
  attachment: Attachment,
  event: ToolCallEvent,
  context: ExtensionContext,
): ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined> {
  return runBefore(
    attachment.slot,
    attachment.registration,
    callOf(event),
    contextOf(attachment, context),
    (reason) => ({ block: true, reason }),
    (call) => assignRewrite(event, call),
  );
}

/** Runs `toolAfter` with the joined result text and its error flag. */
function handleToolResult(
  attachment: Attachment,
  event: ToolResultEvent,
  context: ExtensionContext,
): void | Promise<void> {
  if (!attachment.slot.isLeader(attachment.registration)) {
    return;
  }

  const call = callOf(event);
  const result: ToolResult = { output: joinTextParts(event.content), isError: event.isError };

  return run(
    runToolAfter(
      attachment.slot.plugins(attachment.registration.scope),
      call,
      result,
      contextOf(attachment, context),
    ),
  );
}

/** Runs `promptSent` for user input; text tack produced is never transformed again. */
function handleInput(
  attachment: Attachment,
  event: InputEvent,
  context: ExtensionContext,
): InputEventResult | undefined | Promise<InputEventResult | undefined> {
  if (event.source === "extension" || !attachment.slot.isLeader(attachment.registration)) {
    return undefined;
  }

  const plugins = attachment.slot.plugins(attachment.registration.scope);
  const ctx = contextOf(attachment, context);

  return run(runPromptSent(plugins, { text: event.text }, ctx)).then((append) =>
    append === undefined ? undefined : { action: "transform", text: `${event.text}\n\n${append}` },
  );
}

/** Registers in the process scope, throwing the duplicate's message instead. */
function registeredIn(slot: HostSlot, plugin: ResolvedPlugin): Registration {
  const exit = Effect.runSyncExit(slot.register(PI_SCOPE, plugin, SOURCE));

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  throw new Error(
    Option.match(Cause.findErrorOption(exit.cause), {
      onNone: () => "tack: plugin registration failed",
      onSome: (error) => error.message,
    }),
  );
}

/**
 * Registers one plugin's hooks for the process scope. Pi's factory is
 * synchronous, so the slot lookup and registration run here; a name already
 * live in the scope throws with the duplicate's message.
 */
function attach(plugin: ResolvedPlugin, pi: ExtensionAPI): void {
  const slot: HostSlot = Effect.runSync(hostSlot());
  const registration = registeredIn(slot, plugin);
  let ended = false;

  const attachment: Attachment = { slot, registration, pi, isEnded: () => ended };

  // Pi has no permission layer, so nothing is registered for permissionAsked:
  // its fidelity row is `unsupported`.
  const offs: Array<() => void> = [
    pi.on("tool_call", (event, ctx) => handleToolCall(attachment, event, ctx)),
    pi.on("tool_result", (event, ctx) => handleToolResult(attachment, event, ctx)),
    pi.on("input", (event, ctx) => handleInput(attachment, event, ctx)),
    pi.on("session_start", (event, ctx) => handleSessionStart(attachment, event, ctx)),
    pi.on("turn_end", (event, ctx) => handleTurnEnd(attachment, event, ctx)),
    pi.on("agent_settled", (_event, ctx) => handleAgentSettled(attachment, ctx)),
  ];

  offs.push(
    pi.on("session_shutdown", (event, ctx) => {
      ended = true;

      return handleSessionShutdown(attachment, event, ctx).finally(() => {
        registration.dispose();

        for (const off of offs) {
          off();
        }
      });
    }),
  );
}

/** Wraps one resolved definition as a Pi extension factory. */
export function piExtension(plugin: ResolvedPlugin): PiExtension {
  return (pi) => attach(plugin, pi);
}
