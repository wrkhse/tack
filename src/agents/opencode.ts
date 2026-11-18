import { fileURLToPath } from "node:url";

import { Duration, Effect, Predicate } from "effect";
import type * as oc from "@opencode/plugin";
import type {
  Info as NativeTool,
  Result,
  ToolContext as NativeToolContext,
  ToolEditor,
} from "@opencode/plugin/promise/tool";

import type { HostSlot, Registration } from "../host/host.ts";
import { hostSlot } from "../host/host.ts";
import { runSessionCreated, runSessionEnded } from "../hooks/lifecycle.ts";
import { runPermissionAsked } from "../hooks/permission-asked.ts";
import { runPromptSent } from "../hooks/prompt-sent.ts";
import type { ResponseReason } from "../hooks/response-finished.ts";
import { runResponseFinished } from "../hooks/response-finished.ts";
import { runSessionIdle } from "../hooks/session-idle.ts";
import type { ToolResult } from "../hooks/tool-after.ts";
import { runToolAfter } from "../hooks/tool-after.ts";
import type { HookContext, ShellDialect, ToolCall } from "../hooks/tool-before.ts";
import type { ResolvedPlugin } from "../plugin.ts";
import type { Outcome, SessionPort } from "../session.ts";
import { sessionHandle } from "../session.ts";
import type { ToolPort, ToolRegistry, TakenTool } from "../tools/registry.ts";
import { createToolRegistry } from "../tools/registry.ts";
import type { CompiledTool, ToolCallInput, ToolCallResult, ToolContext } from "../tools/tool.ts";
import { invokeTool } from "../tools/tool.ts";
import { runBefore } from "./chain.ts";
import { joinTextParts } from "./text.ts";

/**
 * The file this adapter was loaded from. Each plugin bundles its own copy of
 * tack, so under a bundle this names that plugin's bundle file.
 */
const SOURCE = fileURLToPath(import.meta.url);

/** An OpenCode 2.3 server plugin: the shape `@opencode/plugin` declares. */
export interface OpenCodePlugin {
  readonly id: string;
  readonly setup: (context: oc.Plugin.Context) => Promise<oc.Plugin.Cleanup>;
}

/** The fields tack reads from an OpenCode tool hook event. */
interface ToolEvent {
  readonly tool: string;
  readonly sessionID: string;
  input: unknown;
}

/** The fields tack reads from OpenCode's `execute.after` event. */
type AfterEvent =
  | (ToolEvent & { readonly status: "completed"; readonly result: Result })
  | (ToolEvent & { readonly status: "error"; readonly error: { readonly message: string } });

/** The fields tack reads from OpenCode's `prompt` event. */
interface PromptEvent {
  readonly sessionID: string;
  readonly prompt: { text: string };
}

/** The only part of an OpenCode hook registration tack uses. */
interface HookRegistration {
  readonly dispose: () => Promise<void>;
}

/** One OpenCode location, as the event stream carries it. */
interface EventLocation {
  readonly directory: string;
  readonly workspaceID?: string | undefined;
}

/** The fields tack reads from OpenCode's session lifecycle and step events. */
interface SessionEvent {
  readonly type:
    | "session.created"
    | "session.deleted"
    | "session.archived"
    | "session.step.ended"
    | "session.step.failed"
    | "session.idle";
  readonly location?: EventLocation;
  readonly data: {
    readonly sessionID: string;
    readonly error?: { readonly type: string } | undefined;
  };
}

/** The fields tack reads from OpenCode's permission evaluation. */
interface PermissionEvent {
  readonly sessionID: string;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  message?: string | undefined;
  effect: "allow" | "ask" | "deny";
}

/** The event subscription and the idle hook's registration share one cleanup. */
interface Watcher {
  readonly dispose: () => Promise<void>;
}

/** OpenCode hands hooks as promise callbacks, so each crossing into Effect is here. */
function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

/**
 * The text the model sees. OpenCode's `Tool.Result` keeps it in `content`; a
 * text part contributes text, a file part contributes nothing. `output` is the
 * structured value for a tool's output schema, not prose.
 */
function resultText(result: Result): string {
  const content = result.content;

  if (content === undefined) {
    return "";
  }

  if (Predicate.isString(content)) {
    return content;
  }

  return joinTextParts(content);
}

/** OpenCode on Windows picks its shell at run time, so tack cannot know it. */
function dialectOf(): ShellDialect {
  return process.platform === "win32" ? "unknown" : "posix";
}

/** tack's view of an OpenCode tool call: a shell command, or the agent's own tool. */
function callOf(event: ToolEvent): ToolCall {
  const input = event.input;

  if (event.tool === "shell" && Predicate.isObject(input) && Predicate.isString(input["command"])) {
    return {
      tool: "shell",
      name: "shell",
      dialect: dialectOf(),
      input: { command: input["command"] },
    };
  }

  return { tool: "other", name: event.tool, input };
}

/** Replaces only the command, keeping OpenCode's other input fields. */
function assignRewrite(event: ToolEvent, call: ToolCall): void {
  const input = event.input;

  if (call.tool !== "shell" || !Predicate.isObject(input)) {
    return;
  }

  event.input = { ...input, command: call.input.command };
}

/** The outcome a native call that resolved reports. */
const ACCEPTED: Outcome = { status: "accepted" };

/** The outcome an action reports once this registration has reported its session ended. */
const ENDED: Outcome = { status: "ended" };

/**
 * Runs one native call unless this registration has reported the session
 * ended; an ended session never reaches the harness again.
 */
function unlessEnded(
  sessionID: string,
  ended: (sessionID: string) => boolean,
  perform: () => Promise<Outcome>,
): Promise<Outcome> {
  if (ended(sessionID)) {
    return Promise.resolve(ENDED);
  }

  return perform();
}

/** Runs a native call whose result tack does not use and reports it as accepted. */
function accepted<A>(call: () => Promise<A>): Promise<Outcome> {
  return call().then(() => ACCEPTED);
}

/**
 * The actions one OpenCode session handle performs. A plugin context is a
 * client, so every action is one client call carrying the session's id; only
 * `wake` resumes, so `now` and `next` never start a turn on an idle session.
 * `interrupt` reports a call that found nothing to stop as refused. An action
 * on a session this registration reported ended resolves `ended` without a
 * call.
 */
function opencodeSessionPort(
  context: oc.Plugin.Context,
  ended: (sessionID: string) => boolean,
): SessionPort {
  return {
    append: (input) =>
      unlessEnded(input.sessionID, ended, () =>
        accepted(() =>
          context.session.synthetic({
            sessionID: input.sessionID,
            text: input.text,
            delivery: input.when === "next" ? "queue" : "steer",
            resume: input.when === "wake",
          }),
        ),
      ),
    compact: (sessionID) =>
      unlessEnded(sessionID, ended, () => accepted(() => context.session.compact({ sessionID }))),
    interrupt: (sessionID) =>
      unlessEnded(sessionID, ended, () =>
        context.session
          .interrupt({ sessionID })
          .then((result): Outcome =>
            result.interrupted ? ACCEPTED : { status: "refused", reason: "nothing to interrupt" },
          ),
      ),
    setModel: (input) =>
      unlessEnded(input.sessionID, ended, () =>
        accepted(() =>
          context.session.switchModel({ sessionID: input.sessionID, model: input.model }),
        ),
      ),
  };
}

/**
 * The scope of one registration: the agent's context, the sessions it reports,
 * and the tools it registered, which every hook and every tool call shares.
 */
interface HookScope {
  readonly context: oc.Plugin.Context;
  readonly sessions: SessionStates;
  readonly tools: ToolRegistry;
}

/** One event's hook context: the session's id, the handle that acts on it, and the tools. */
function contextOf(scope: HookScope, sessionID: string): HookContext {
  return {
    agent: "opencode",
    sessionId: sessionID,
    session: sessionHandle(opencodeSessionPort(scope.context, scope.sessions.hasEnded), sessionID),
    tools: scope.tools,
  };
}

/** The event types one subscription needs, whether or not idle falls back to an event. */
const SESSION_EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.archived",
  "session.step.ended",
  "session.step.failed",
] as const;

/** True only for a location the plugin's own scope produced. */
function isHere(found: EventLocation, location: oc.Location.Info): boolean {
  return (
    found.directory === location.directory &&
    (found.workspaceID ?? null) === (location.workspaceID ?? null)
  );
}

/** Whether this process has already warned about an event with no location. */
let warnedNoLocation = false;

/**
 * Ignores a locationless event for a session this registration has not
 * reported, warning once per process. A stream without a location cannot be
 * scoped, so another location's session may have produced the event; one for a
 * session this registration has already reported can only be that session's,
 * so the caller attributes it to this scope.
 */
function ignoreNoLocation(): Promise<void> {
  if (warnedNoLocation) {
    return Promise.resolve();
  }

  warnedNoLocation = true;

  return run(Effect.logWarning("tack: an OpenCode event carried no location; tack ignores it"));
}

/** One step event's reason: a completed step, an aborted one, or a failure. */
function responseReasonOf(event: SessionEvent): ResponseReason {
  if (event.type === "session.step.ended") {
    return "done";
  }

  return event.data.error?.type === "aborted" ? "aborted" : "error";
}

/** How many ended sessions one registration remembers before forgetting the oldest. */
const ENDED_LIMIT = 1024;

/** What this registration has reported about one session. */
type SessionState = "live" | "ended";

/**
 * The sessions one registration has reported, and whether each has ended.
 *
 * A registration reports a session once and drops every later event for one it
 * reported ended, so an archive that follows a delete, or a step that follows
 * the end, reaches no plugin. The map keeps insertion order, so the oldest
 * ended entry is the one forgotten when the count passes `ENDED_LIMIT`.
 */
interface SessionStates {
  readonly stateOf: (sessionID: string) => SessionState | undefined;
  readonly hasEnded: (sessionID: string) => boolean;
  readonly began: (sessionID: string) => void;
  readonly ended: (sessionID: string) => void;
}

function sessionStates(): SessionStates {
  const states = new Map<string, SessionState>();
  let endedCount = 0;

  const hasEnded = (sessionID: string): boolean => states.get(sessionID) === "ended";

  return {
    stateOf: (sessionID) => states.get(sessionID),
    hasEnded,
    began: (sessionID) => {
      states.set(sessionID, "live");
    },
    ended: (sessionID) => {
      if (hasEnded(sessionID)) {
        return;
      }

      states.set(sessionID, "ended");
      endedCount += 1;

      if (endedCount <= ENDED_LIMIT) {
        return;
      }

      for (const [id, state] of states) {
        if (state !== "ended") {
          continue;
        }

        states.delete(id);
        endedCount -= 1;

        break;
      }
    },
  };
}

/** The observations one registration reports, over the sessions it has seen. */
interface SessionReports {
  readonly event: (event: SessionEvent) => Promise<void>;
  readonly idle: (sessionID: string) => Promise<void>;
}

/** Runs the hook one non-created session event names, and records an end. */
function reportSessionEvent(
  slot: HostSlot,
  registration: Registration,
  scope: HookScope,
  found: SessionEvent,
): Promise<void> {
  const { sessionID } = found.data;
  const ctx = contextOf(scope, sessionID);
  const plugins = slot.plugins(registration.scope);

  if (found.type === "session.deleted" || found.type === "session.archived") {
    return run(runSessionEnded(plugins, { session: ctx.session, reason: "closed" }, ctx)).then(
      () => {
        scope.sessions.ended(sessionID);
      },
    );
  }

  if (found.type === "session.idle") {
    return run(runSessionIdle(plugins, { session: ctx.session }, ctx));
  }

  return run(
    runResponseFinished(plugins, { session: ctx.session, reason: responseReasonOf(found) }, ctx),
  );
}

/**
 * Builds the reporter for one registration.
 *
 * OpenCode replays no `session.created` for a session that existed before
 * setup, so the first event about such a session reports it with `resumed:
 * true`. The subscription starts during setup, and no session is reported
 * before it. A creation report is kept per session until it settles, so
 * nothing about that session runs before its `sessionCreated` handlers.
 */
function reportsFor(slot: HostSlot, registration: Registration, scope: HookScope): SessionReports {
  const { sessions } = scope;
  const creating = new Map<string, Promise<void>>();

  const created = (sessionID: string, resumed: boolean): Promise<void> => {
    sessions.began(sessionID);

    const ctx = contextOf(scope, sessionID);

    const pending = run(
      runSessionCreated(slot.plugins(registration.scope), { session: ctx.session, resumed }, ctx),
    );

    creating.set(sessionID, pending);

    return pending.finally(() => {
      if (creating.get(sessionID) === pending) {
        creating.delete(sessionID);
      }
    });
  };

  const ensure = (sessionID: string): Promise<void> => {
    const state = sessions.stateOf(sessionID);

    if (state === "ended") {
      return Promise.resolve();
    }

    if (state === undefined) {
      return created(sessionID, true);
    }

    return creating.get(sessionID) ?? Promise.resolve();
  };

  /**
   * The experimental idle hook is registered on this location's plugin
   * instance, and OpenCode runs a session's hooks from the plugins of that
   * session's own location, so an idle it delivers is this scope's. The event
   * stream is the connected server's instead, which is why `event` filters on
   * `location` and `idle` does not.
   */
  const idle = (sessionID: string): Promise<void> => {
    if (!slot.isLeader(registration) || sessions.hasEnded(sessionID)) {
      return Promise.resolve();
    }

    return ensure(sessionID).then(() => {
      const ctx = contextOf(scope, sessionID);

      return run(runSessionIdle(slot.plugins(registration.scope), { session: ctx.session }, ctx));
    });
  };

  const event = (found: SessionEvent): Promise<void> => {
    if (!slot.isLeader(registration)) {
      return Promise.resolve();
    }

    const { sessionID } = found.data;

    if (sessions.hasEnded(sessionID)) {
      return Promise.resolve();
    }

    if (found.location !== undefined && !isHere(found.location, scope.context.location)) {
      return Promise.resolve();
    }

    if (found.location === undefined && sessions.stateOf(sessionID) === undefined) {
      return ignoreNoLocation();
    }

    if (found.type === "session.created") {
      return sessions.stateOf(sessionID) === undefined
        ? created(sessionID, false)
        : Promise.resolve();
    }

    return ensure(sessionID).then(() => reportSessionEvent(slot, registration, scope, found));
  };

  return { event, idle };
}

/** A failure's message, whether it is an Error or something thrown. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Completes when the given signal aborts, now or later. */
function aborted(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);

      return Effect.void;
    }

    const abort = (): void => resume(Effect.void);

    signal.addEventListener("abort", abort, { once: true });

    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
}

/** Waits one restart delay, ending early when the watcher is disposed. */
function afterDelay(ms: number, signal: AbortSignal): Promise<void> {
  return run(Effect.raceFirst(Effect.sleep(Duration.millis(ms)), aborted(signal)));
}

/** How many times in a row a failed event subscription is restarted before reporting stops. */
const RESUBSCRIBE_ATTEMPTS = 5;

/** The first restart delay; each later attempt doubles it. */
const RESUBSCRIBE_DELAY_MS = 100;

/**
 * Subscribes to the session events and owns the abort that ends the stream.
 * A report that fails is logged and the pump continues; a subscription that
 * fails `RESUBSCRIBE_ATTEMPTS` times in a row is restarted, counting from
 * zero again after every delivered event, so lifecycle reporting resumes
 * after a transient failure instead of ending silently.
 */
function watchEvents(
  reports: SessionReports,
  context: oc.Plugin.Context,
  idleFallback: boolean,
): Watcher {
  const controller = new AbortController();

  const types: Array<SessionEvent["type"]> = idleFallback
    ? [...SESSION_EVENT_TYPES, "session.idle"]
    : [...SESSION_EVENT_TYPES];

  const subscribe = (): AsyncIterator<SessionEvent> =>
    context.event.subscribe({ types, signal: controller.signal })[Symbol.asyncIterator]();

  let iterator = subscribe();

  function resume(cause: unknown, attempt: number): Promise<void> {
    if (controller.signal.aborted) {
      return Promise.resolve();
    }

    const message = messageOf(cause);

    if (attempt > RESUBSCRIBE_ATTEMPTS) {
      return run(
        Effect.logWarning(
          `tack: OpenCode event subscription failed ${RESUBSCRIBE_ATTEMPTS} times; lifecycle reporting stopped: ${message}`,
        ),
      );
    }

    const delay = RESUBSCRIBE_DELAY_MS * 2 ** (attempt - 1);

    return run(
      Effect.logWarning(
        `tack: OpenCode event subscription failed; retrying in ${delay} ms (attempt ${attempt} of ${RESUBSCRIBE_ATTEMPTS}): ${message}`,
      ),
    )
      .then(() => afterDelay(delay, controller.signal))
      .then(() => {
        if (controller.signal.aborted) {
          return Promise.resolve();
        }

        try {
          iterator = subscribe();
        } catch (failure) {
          return resume(failure, attempt + 1);
        }

        return pump(attempt);
      });
  }

  function pump(attempt: number): Promise<void> {
    return iterator.next().then<void, void>(
      (step): void | Promise<void> => {
        if (step.done || controller.signal.aborted) {
          return;
        }

        // A delivered event proves the subscription healthy again, so a later
        // failure is the first of a new run rather than the next of this one.
        return Promise.resolve()
          .then(() => reports.event(step.value))
          .catch((cause) =>
            run(Effect.logWarning(`tack: OpenCode event handling failed: ${messageOf(cause)}`)),
          )
          .then(() => pump(0));
      },
      (cause): void | Promise<void> => resume(cause, attempt + 1),
    );
  }

  const loop = pump(0);

  return {
    dispose: () => {
      controller.abort();

      return loop;
    },
  };
}

/**
 * Registers the experimental idle hook. A load where the hook is absent
 * returns undefined, and the adapter subscribes to `session.idle` instead.
 */
function registerIdle(
  reports: SessionReports,
  context: oc.Plugin.Context,
): Promise<HookRegistration | undefined> {
  return Promise.resolve()
    .then(() => context.session.hook("experimental.idle", (event) => reports.idle(event.sessionID)))
    .catch(() => undefined);
}

/**
 * Runs `permissionAsked` and folds its answer back into the evaluation: allow
 * skips the person's configured ask, deny refuses with the plugin's reason,
 * and undefined leaves OpenCode's own effect unchanged.
 */
function handlePermission(
  slot: HostSlot,
  registration: Registration,
  scope: HookScope,
  event: PermissionEvent,
): Promise<void> {
  if (!slot.isLeader(registration) || event.effect === "deny") {
    return Promise.resolve();
  }

  const base = {
    sessionId: event.sessionID,
    action: event.action,
    resources: event.resources,
    effect: event.effect,
  };

  const request = event.message === undefined ? base : { ...base, message: event.message };

  return run(
    runPermissionAsked(
      slot.plugins(registration.scope),
      request,
      contextOf(scope, event.sessionID),
    ),
  ).then((result) => {
    if (result === undefined) {
      return;
    }

    if ("allow" in result) {
      event.effect = "allow";

      return;
    }

    event.effect = "deny";
    event.message = result.deny;
  });
}

/** Runs `toolBefore` for a call and throws the reason on a deny. */
function handleBefore(
  slot: HostSlot,
  registration: Registration,
  scope: HookScope,
  event: ToolEvent,
): void | Promise<void> {
  return runBefore(
    slot,
    registration,
    callOf(event),
    contextOf(scope, event.sessionID),
    (reason) => {
      throw new Error(reason);
    },
    (call) => assignRewrite(event, call),
  );
}

/** Runs `toolAfter` with the completed output or the failure message. */
function handleAfter(
  slot: HostSlot,
  registration: Registration,
  scope: HookScope,
  event: AfterEvent,
): void | Promise<void> {
  if (!slot.isLeader(registration)) {
    return;
  }

  const ctx = contextOf(scope, event.sessionID);
  const call = callOf(event);

  const result: ToolResult =
    event.status === "completed"
      ? { output: resultText(event.result), isError: false }
      : { output: event.error.message, isError: true };

  return run(runToolAfter(slot.plugins(registration.scope), call, result, ctx));
}

/** Runs `promptSent` and appends the combined text after a blank line. */
function handlePrompt(
  slot: HostSlot,
  registration: Registration,
  scope: HookScope,
  event: PromptEvent,
): void | Promise<void> {
  if (!slot.isLeader(registration)) {
    return;
  }

  const ctx = contextOf(scope, event.sessionID);

  return run(
    runPromptSent(slot.plugins(registration.scope), { text: event.prompt.text }, ctx),
  ).then((append) => {
    if (append !== undefined) {
      event.prompt.text = `${event.prompt.text}\n\n${append}`;
    }
  });
}

/** OpenCode's view of one tack tool: the header unchanged, and an execute that maps the result. */
function nativeTool(tool: CompiledTool, scope: () => HookScope): NativeTool {
  return {
    name: tool.name,
    description: tool.description,
    input: tool.input,
    execute: (input, context) => runTool(tool, { input }, scope(), context),
  };
}

/** Runs one tool and maps tack's result onto OpenCode's. */
function runTool(
  tool: CompiledTool,
  call: ToolCallInput,
  scope: HookScope,
  context: NativeToolContext,
): Promise<Result> {
  const ctx: ToolContext = {
    callId: String(context.id),
    signal: context.signal,
    session: sessionHandle(
      opencodeSessionPort(scope.context, scope.sessions.hasEnded),
      context.sessionID,
    ),
    tools: scope.tools,
  };

  return Effect.runPromise(invokeTool(tool, call, ctx), { signal: context.signal }).then(
    toNativeResult,
  );
}

/**
 * tack's result in OpenCode's shape: every content string becomes a text part
 * and `details` becomes metadata. An error result leaves through OpenCode's
 * error path, a throw, because `Tool.Result` has no error flag; OpenCode's
 * promise adapter reports the throw as `Tool.Error` carrying this message.
 */
function toNativeResult(result: ToolCallResult): Result {
  if (result.isError === true) {
    throw new Error(result.content.join("\n"));
  }

  const content = result.content.map((text) => ({ type: "text" as const, text }));
  const metadata = result.details;

  return metadata === undefined ? { content } : { content, metadata };
}

/** The port a registry reaches OpenCode's tool namespace through, and its registrations. */
interface NativeToolPort extends ToolPort {
  readonly dispose: () => Promise<void>;
}

/**
 * Builds the port for one registration. OpenCode applies a transform when it
 * is registered, so every install and withdrawal is one transform whose
 * registration the plugin's cleanup disposes.
 */
function openCodeToolPort(context: oc.Plugin.Context, scope: () => HookScope): NativeToolPort {
  const registrations: Array<Promise<HookRegistration>> = [];

  const transform = (callback: (editor: ToolEditor) => void): void => {
    const pending = context.tool.transform(callback);

    registrations.push(pending);

    // A registration made after setup has no caller to report to, so its
    // failure is logged rather than becoming an unhandled rejection.
    pending.catch((cause: unknown) =>
      run(Effect.logWarning(`tack: OpenCode tool registration failed: ${messageOf(cause)}`)),
    );
  };

  return {
    install: (tools) =>
      transform((editor) => {
        for (const tool of tools) {
          editor.add(nativeTool(tool, scope));
        }
      }),
    withdraw: (name) =>
      transform((editor) => {
        editor.remove(name);
      }),
    settled: () => Promise.all(registrations).then(() => undefined),
    dispose: () =>
      Promise.all(
        registrations.map((pending) =>
          pending.then(
            (registration) => registration.dispose(),
            () => undefined,
          ),
        ),
      ).then(() => undefined),
  };
}

/**
 * Every name this location's tool namespace already holds besides the
 * plugin's own: the agent's built-in tools, and those of every other plugin in
 * the scope, which the host slot carries however many copies of tack
 * registered them.
 */
function takenTools(
  slot: HostSlot,
  plugin: ResolvedPlugin,
  scope: string,
  existing: ReadonlyArray<{ readonly id: string }>,
): ReadonlyArray<TakenTool> {
  const fromPlugins = slot
    .plugins(scope)
    .filter((other) => other.name !== plugin.name)
    .flatMap((other) =>
      other.tools.map((tool) => ({ name: tool.name, source: `plugin "${other.name}"` })),
    );

  const fromAgent = existing.map((tool) => ({ name: tool.id, source: "the agent's own tools" }));

  return [...fromPlugins, ...fromAgent];
}

/** Ends the slot registration, every hook registration, the tools and the event stream. */
function disposeAll(
  registration: Registration,
  hooks: ReadonlyArray<HookRegistration>,
  watcher: Watcher,
  tools: NativeToolPort,
): Promise<void> {
  registration.dispose();

  return Promise.all([
    ...hooks.map((hook) => hook.dispose()),
    watcher.dispose(),
    tools.dispose(),
  ]).then(() => undefined);
}

/** Registers each step's hook in order, so a failure can dispose the earlier ones. */
function registerInOrder(
  steps: ReadonlyArray<() => Promise<HookRegistration>>,
  hooks: HookRegistration[],
): Promise<void> {
  return steps.reduce<Promise<void>>(
    (previous, step) =>
      previous
        .then(() => step())
        .then((hook) => {
          hooks.push(hook);
        }),
    Promise.resolve(),
  );
}

/** The agent hooks tack registers, each over the scope the plugin's tools share. */
function hookSteps(
  slot: HostSlot,
  registration: Registration,
  context: oc.Plugin.Context,
  scope: () => HookScope,
): ReadonlyArray<() => Promise<HookRegistration>> {
  return [
    () =>
      context.tool.hook("execute.before", (event) =>
        handleBefore(slot, registration, scope(), event),
      ),
    () =>
      context.tool.hook("execute.after", (event) =>
        handleAfter(slot, registration, scope(), event),
      ),
    () =>
      context.session.hook("prompt", (event) => handlePrompt(slot, registration, scope(), event)),
    () =>
      context.permission.hook("evaluate", (event) =>
        handlePermission(slot, registration, scope(), event),
      ),
  ];
}

/** Starts the idle hook and the event stream, and returns the cleanup that releases them. */
function watchScope(
  slot: HostSlot,
  registration: Registration,
  context: oc.Plugin.Context,
  scope: () => HookScope,
  port: NativeToolPort,
  hooks: HookRegistration[],
): Promise<oc.Plugin.Cleanup> {
  const reports = reportsFor(slot, registration, scope());

  return registerIdle(reports, context).then((idle) => {
    if (idle !== undefined) {
      hooks.push(idle);
    }

    const watcher = watchEvents(reports, context, idle === undefined);

    return () => disposeAll(registration, hooks, watcher, port);
  });
}

/** Registers the plugin's tools, hooks and events, and builds the cleanup that releases them. */
function hookInto(
  plugin: ResolvedPlugin,
  slot: HostSlot,
  registration: Registration,
  context: oc.Plugin.Context,
): Promise<oc.Plugin.Cleanup> {
  const hooks: HookRegistration[] = [];
  const sessions = sessionStates();

  let scope: HookScope | undefined;

  function toolScope(): HookScope {
    if (scope === undefined) {
      throw new Error("tack: a tool call arrived before its registration finished");
    }

    return scope;
  }

  const native = openCodeToolPort(context, toolScope);

  return context.tool
    .list()
    .then((existing) => {
      const tools = createToolRegistry(
        {
          plugin: plugin.name,
          scope: registration.scope,
          source: SOURCE,
          hasSession: true,
          port: native,
          taken: takenTools(slot, plugin, registration.scope, existing),
        },
        plugin.tools,
      );

      scope = { context, sessions, tools };

      return native.settled();
    })
    .then(() => registerInOrder(hookSteps(slot, registration, context, toolScope), hooks))
    .then(() => watchScope(slot, registration, context, toolScope, native, hooks))
    .catch((cause: Error) => {
      registration.dispose();

      return native
        .dispose()
        .catch(() => undefined)
        .then(() => Promise.all(hooks.map((hook) => hook.dispose())))
        .then(() => {
          throw cause;
        });
    });
}

/**
 * Registers the plugin and its hooks in one location's scope. A name already
 * live in the scope fails the load, so the setup rejects with the duplicate's
 * message and the existing registration keeps its hooks.
 */
function setupPlugin(
  plugin: ResolvedPlugin,
  context: oc.Plugin.Context,
  scope: string,
): Promise<oc.Plugin.Cleanup> {
  return run(hostSlot()).then((slot) =>
    run(slot.register(scope, plugin, SOURCE)).then((registration) =>
      hookInto(plugin, slot, registration, context),
    ),
  );
}

/**
 * The scope one OpenCode location gets.
 *
 * OpenCode keys a location by its directory and its workspace, so two
 * workspaces open on one directory are two locations. Keying by the directory
 * alone would let their same-named registrations replace each other and leave
 * one workspace's calls with no guard at all. The pair is JSON encoded, so no
 * directory and workspace ID can spell another pair's key.
 */
export function opencodeScope(location: oc.Location.Info): string {
  return `opencode:${JSON.stringify([location.directory, location.workspaceID ?? null])}`;
}

/** Wraps one resolved definition as an OpenCode server plugin. */
export function opencodePlugin(plugin: ResolvedPlugin): OpenCodePlugin {
  return {
    id: `tack.${plugin.name}`,
    setup: (context) => setupPlugin(plugin, context, opencodeScope(context.location)),
  };
}
