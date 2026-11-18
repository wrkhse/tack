import { fileURLToPath } from "node:url";

import { afterEach, expect, it, vi } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import type * as oc from "@opencode/plugin";

import { opencodeScope } from "../../src/agents/opencode.ts";
import { hostSlot } from "../../src/host/host.ts";
import type { AgentPlugin, Session, ToolCall, ToolResult } from "../../src/index.ts";
import { createAgentPlugin } from "../../src/index.ts";
import { quietConsole } from "../helpers.ts";

const DIRECTORY = "/work/app";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface FakeToolEvent {
  readonly tool: string;
  readonly sessionID: string;
  input: unknown;
}

interface FakePromptEvent {
  readonly sessionID: string;
  readonly prompt: { text: string };
}

type FakeToolCallback = (event: FakeToolEvent) => void | Promise<void>;

type FakePromptCallback = (event: FakePromptEvent) => void | Promise<void>;

/** The synthetic message the adapter asks OpenCode to admit. */
interface FakeSynthetic {
  readonly sessionID: string;
  readonly text: string;
  readonly delivery?: "steer" | "queue";
  readonly resume?: boolean;
}

interface FakeSwitchModel {
  readonly sessionID: string;
  readonly model: { readonly providerID: string; readonly id: string };
}

/** One session action the adapter performed, as OpenCode received it. */
type FakeSessionCall =
  | { readonly method: "synthetic"; readonly input: FakeSynthetic }
  | { readonly method: "compact"; readonly input: { readonly sessionID: string } }
  | { readonly method: "interrupt"; readonly input: { readonly sessionID: string } }
  | { readonly method: "switchModel"; readonly input: FakeSwitchModel };

/** One session lifecycle event the fake subscription delivers. */
interface FakeLifecycleEvent {
  readonly type:
    | "session.created"
    | "session.deleted"
    | "session.archived"
    | "session.step.ended"
    | "session.step.failed"
    | "session.idle";
  readonly location?: {
    readonly directory: string;
    readonly workspaceID?: string | undefined;
  };
  readonly data: {
    readonly sessionID: string;
    readonly error?: { readonly type: string } | undefined;
  };
}

interface FakeSubscribeOptions {
  readonly types?: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
}

/** The options one subscription received and when it has consumed its events. */
interface FakeEventStream {
  readonly options: FakeSubscribeOptions | undefined;
  readonly settled: Promise<void>;
}

interface FakePermissionEvent {
  readonly sessionID: string;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  readonly message?: string | undefined;
  effect: "allow" | "ask" | "deny";
}

interface FakeIdleEvent {
  readonly sessionID: string;
}

type FakePermissionCallback = (event: FakePermissionEvent) => void | Promise<void>;

type FakeIdleCallback = (event: FakeIdleEvent) => void | Promise<void>;

/** The session hook's two callbacks, discriminated by the hook's name. */
type FakeSessionHookArgs =
  | [name: "prompt", callback: FakePromptCallback]
  | [name: "experimental.idle", callback: FakeIdleCallback];

interface FakeHandlers {
  "execute.before"?: FakeToolCallback;
  "execute.after"?: FakeToolCallback;
  prompt?: FakePromptCallback;
  evaluate?: FakePermissionCallback;
  idle?: FakeIdleCallback;
}

interface FakeContext {
  readonly context: oc.Plugin.Context;
  readonly handlers: FakeHandlers;
  readonly disposed: string[];
  readonly calls: FakeSessionCall[];
  readonly events: FakeLifecycleEvent[];
  readonly subscriptions: FakeEventStream[];
  /** What `session.interrupt` reports; the next subscription fails while it counts down. */
  readonly interruptResult: { interrupted: boolean };
  readonly subscriptionFailures: { remaining: number };
}

interface FakeRegistration {
  readonly dispose: () => Promise<void>;
}

/** The fake's shape, which the Context members the adapter reads cover. */
interface FakeCandidate {
  readonly location: {
    readonly directory: string;
    readonly workspaceID?: string | undefined;
  };
  readonly tool: {
    readonly hook: (...args: never[]) => Promise<FakeRegistration>;
  };
  readonly session: {
    readonly hook: unknown;
  };
  readonly permission: {
    readonly hook: (...args: never[]) => Promise<FakeRegistration>;
  };
  readonly event: {
    readonly subscribe: unknown;
  };
}

function registration(name: string, disposed: string[]): Promise<FakeRegistration> {
  return Promise.resolve({
    dispose: () => {
      disposed.push(name);

      return Promise.resolve();
    },
  });
}

/** The fake implements every Context member the adapter reads. */
function isOpenCodeContext(value: FakeCandidate): value is oc.Plugin.Context {
  const { location } = value;

  return (
    Predicate.isString(location.directory) &&
    (location.workspaceID === undefined || Predicate.isString(location.workspaceID)) &&
    Predicate.isFunction(value.tool.hook) &&
    Predicate.isFunction(value.session.hook) &&
    Predicate.isFunction(value.permission.hook) &&
    Predicate.isFunction(value.event.subscribe)
  );
}

/** One subscription over the events queued at subscribe time, then an abort wait. */
function subscribeTo(
  events: ReadonlyArray<FakeLifecycleEvent>,
  options: FakeSubscribeOptions | undefined,
  subscriptions: FakeEventStream[],
  failures: { remaining: number },
): AsyncIterable<FakeLifecycleEvent> {
  const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
  const queued = [...events];
  let index = 0;

  subscriptions.push({ options, settled });

  const iterator: AsyncIterator<FakeLifecycleEvent> = {
    next: () => {
      if (failures.remaining > 0) {
        failures.remaining -= 1;

        return Promise.reject(new Error("the stream dropped"));
      }

      const value = queued[index];

      if (value === undefined) {
        settle();

        return Promise.resolve({ done: true, value: undefined });
      }

      index += 1;

      return Promise.resolve({ done: false, value });
    },
  };

  return { [Symbol.asyncIterator]: () => iterator };
}

/** The session hook a fake context offers: prompt, and idle unless the hook is absent. */
function sessionHook(
  handlers: FakeHandlers,
  disposed: string[],
  failIdle: boolean,
): (...args: FakeSessionHookArgs) => Promise<FakeRegistration> {
  return (...args) => {
    if (args[0] === "prompt") {
      const [name, callback] = args;

      handlers.prompt = callback;

      return registration(name, disposed);
    }

    if (failIdle) {
      throw new Error("no experimental.idle in this OpenCode");
    }

    const [name, callback] = args;

    handlers.idle = callback;

    return registration(name, disposed);
  };
}

function fakeContext(
  directory: string,
  workspaceID?: string,
  failure?: Error,
  failIdle = false,
): FakeContext {
  const disposed: string[] = [];
  const handlers: FakeHandlers = {};
  const calls: FakeSessionCall[] = [];
  const events: FakeLifecycleEvent[] = [];
  const subscriptions: FakeEventStream[] = [];
  const interruptResult = { interrupted: true };
  const subscriptionFailures = { remaining: 0 };

  const answer = (call: FakeSessionCall) => {
    calls.push(call);

    return failure === undefined ? Promise.resolve(undefined) : Promise.reject(failure);
  };

  const fake = {
    location: { directory, workspaceID },
    tool: {
      hook: (name: "execute.before" | "execute.after", callback: FakeToolCallback) => {
        handlers[name] = callback;

        return registration(name, disposed);
      },
    },
    permission: {
      hook: (name: "evaluate", callback: FakePermissionCallback) => {
        handlers.evaluate = callback;

        return registration(name, disposed);
      },
    },
    event: {
      subscribe: (options?: FakeSubscribeOptions) =>
        subscribeTo(events, options, subscriptions, subscriptionFailures),
    },
    session: {
      hook: sessionHook(handlers, disposed, failIdle),
      synthetic: (input: FakeSynthetic) => answer({ method: "synthetic", input }),
      compact: (input: { readonly sessionID: string }) => answer({ method: "compact", input }),
      interrupt: (input: { readonly sessionID: string }) =>
        answer({ method: "interrupt", input }).then(() => ({
          interrupted: interruptResult.interrupted,
        })),
      switchModel: (input: FakeSwitchModel) => answer({ method: "switchModel", input }),
    },
  };

  if (!isOpenCodeContext(fake)) {
    throw new Error("the test fake is not an OpenCode context");
  }

  return {
    context: fake,
    handlers,
    disposed,
    calls,
    events,
    subscriptions,
    interruptResult,
    subscriptionFailures,
  };
}

function hookOf<T>(hook: T | undefined): T {
  if (hook === undefined) {
    throw new Error("the adapter registered no such hook");
  }

  return hook;
}

/** Runs a promise-land hook inside the test's Effect. */
function runHook<A>(hook: () => A | Promise<A>): Effect.Effect<A> {
  return Effect.promise(() => Promise.resolve(hook()));
}

/** Runs a hook that must fail and returns the thrown error. */
function runHookFailure(hook: () => void | Promise<void>): Effect.Effect<Error | undefined> {
  return Effect.promise(() =>
    Promise.resolve(hook()).then(
      () => undefined,
      (cause: Error) => cause,
    ),
  );
}

function attach(plugin: AgentPlugin<void>, fake: FakeContext): Effect.Effect<oc.Plugin.Cleanup> {
  return Effect.promise(() => plugin.opencode().setup(fake.context));
}

/** Runs a setup that must fail and returns the rejection. */
function setupFailure(
  plugin: AgentPlugin<void>,
  fake: FakeContext,
): Effect.Effect<Error | undefined> {
  return Effect.promise(() =>
    plugin
      .opencode()
      .setup(fake.context)
      .then(
        () => undefined,
        (cause: Error) => cause,
      ),
  );
}

function release(cleanup: oc.Plugin.Cleanup): Effect.Effect<void> {
  return Effect.promise(() => Promise.resolve(cleanup()));
}

/** Loads a plugin that keeps the handle its hook receives, and returns that handle. */
function handleOf(fake: FakeContext): Effect.Effect<Session> {
  return Effect.gen(function* () {
    let captured: Session | undefined;

    const capture = createAgentPlugin(() => ({
      name: "capture",

      promptSent: (_prompt, ctx) => {
        captured = ctx.session;

        return undefined;
      },
    }));

    yield* attach(capture, fake);

    const event: FakePromptEvent = { sessionID: "s1", prompt: { text: "hi" } };

    yield* runHook(() => hookOf(fake.handlers.prompt)(event));

    if (captured === undefined) {
      throw new Error("the adapter gave the hook no session handle");
    }

    return captured;
  });
}

/** Loads two plugins in one scope and returns the event their chain rewrites. */
function combined(
  first: AgentPlugin<void>,
  second: AgentPlugin<void>,
  directory: string,
): Effect.Effect<FakeToolEvent> {
  return Effect.gen(function* () {
    const firstFake = fakeContext(directory);
    const secondFake = fakeContext(directory);

    yield* attach(first, firstFake);
    yield* attach(second, secondFake);

    const event: FakeToolEvent = {
      tool: "shell",
      sessionID: "s1",
      input: { command: "git push origin main" },
    };

    yield* runHook(() => hookOf(firstFake.handlers["execute.before"])(event));

    return event;
  });
}

const safePush = createAgentPlugin(() => ({
  name: "safe-push",
  priority: 10,

  toolBefore: (call) =>
    call.tool === "shell" ? { rewrite: { command: `${call.input.command} --dry-run` } } : undefined,
}));

const signedPush = createAgentPlugin(() => ({
  name: "signed-push",
  priority: 20,

  toolBefore: (call) =>
    call.tool === "shell" ? { rewrite: { command: `${call.input.command} --signed` } } : undefined,
}));

const denyPush = createAgentPlugin(() => ({
  name: "deny-push",

  toolBefore: (call) => (call.tool === "shell" ? { deny: "blocked by test" } : undefined),
}));

it.effect("throws the deny reason and leaves the input untouched", () =>
  Effect.gen(function* () {
    const fake = fakeContext("/work/deny");

    const event: FakeToolEvent = {
      tool: "shell",
      sessionID: "s1",
      input: { command: "git push origin main" },
    };

    yield* attach(denyPush, fake);

    const failure = yield* runHookFailure(() => hookOf(fake.handlers["execute.before"])(event));

    expect(failure?.message).toBe("blocked by test");
    expect(event.input).toEqual({ command: "git push origin main" });
  }),
);

it.effect("rewrites the command and keeps the other input fields", () =>
  Effect.gen(function* () {
    const fake = fakeContext("/work/rewrite");

    const event: FakeToolEvent = {
      tool: "shell",
      sessionID: "s1",
      input: { command: "git push origin main", background: true },
    };

    yield* attach(safePush, fake);
    yield* runHook(() => hookOf(fake.handlers["execute.before"])(event));

    expect(event.input).toEqual({
      command: "git push origin main --dry-run",
      background: true,
    });
  }),
);

it.effect("appends prompt text after a blank line", () =>
  Effect.gen(function* () {
    const note = createAgentPlugin(() => ({
      name: "push-note",
      promptSent: () => ({ append: "dry runs only." }),
    }));

    const fake = fakeContext("/work/prompt");
    const event: FakePromptEvent = { sessionID: "s1", prompt: { text: "push it" } };

    yield* attach(note, fake);
    yield* runHook(() => hookOf(fake.handlers.prompt)(event));

    expect(event.prompt.text).toBe("push it\n\ndry runs only.");
  }),
);

it.effect("passes completed output and failures to toolAfter", () =>
  Effect.gen(function* () {
    const observed: Array<{ call: ToolCall; result: ToolResult }> = [];

    const observe = createAgentPlugin(() => ({
      name: "observe",

      toolAfter: (call, result) => {
        observed.push({ call, result });
      },
    }));

    const fake = fakeContext("/work/after");

    yield* attach(observe, fake);

    const completed = {
      tool: "shell",
      sessionID: "s1",
      input: { command: "git push origin main" },
      status: "completed",
      result: {
        content: [
          { type: "text", text: "the output" },
          { type: "file", uri: "file:///notes.txt", mime: "text/plain" },
        ],
      },
    };

    yield* runHook(() => hookOf(fake.handlers["execute.after"])(completed));

    expect(observed[0]?.result).toEqual({ output: "the output", isError: false });

    const plain = {
      tool: "shell",
      sessionID: "s1",
      input: { command: "git push origin main" },
      status: "completed",
      result: { content: "plain output" },
    };

    yield* runHook(() => hookOf(fake.handlers["execute.after"])(plain));

    expect(observed[1]?.result).toEqual({ output: "plain output", isError: false });

    const failed = {
      tool: "shell",
      sessionID: "s1",
      input: { command: "git push origin main" },
      status: "error",
      error: { message: "boom" },
    };

    yield* runHook(() => hookOf(fake.handlers["execute.after"])(failed));

    expect(observed[2]?.result).toEqual({ output: "boom", isError: true });
    expect(observed[2]?.call).toMatchObject({ tool: "shell", dialect: "posix" });
  }),
);

it.effect("combines rewrites in one scope whatever the load order", () =>
  Effect.gen(function* () {
    const forward = yield* combined(safePush, signedPush, "/work/forward");
    const reversed = yield* combined(signedPush, safePush, "/work/reverse");

    expect(forward.input).toEqual({ command: "git push origin main --dry-run --signed" });
    expect(reversed.input).toEqual({ command: "git push origin main --dry-run --signed" });
  }),
);

it.effect("keeps two workspaces at one directory in separate scopes", () =>
  Effect.gen(function* () {
    const first = fakeContext(DIRECTORY, "ws-one");
    const second = fakeContext(DIRECTORY, "ws-two");
    const slot = yield* hostSlot();

    yield* attach(denyPush, first);
    yield* attach(denyPush, second);

    const firstScope = opencodeScope(first.context.location);
    const secondScope = opencodeScope(second.context.location);

    expect([firstScope, secondScope]).toEqual([
      'opencode:["/work/app","ws-one"]',
      'opencode:["/work/app","ws-two"]',
    ]);
    expect(slot.plugins(firstScope).map((plugin) => plugin.name)).toEqual(["deny-push"]);
    expect(slot.plugins(secondScope).map((plugin) => plugin.name)).toEqual(["deny-push"]);

    const firstEvent: FakeToolEvent = {
      tool: "shell",
      sessionID: "s1",
      input: { command: "git push origin main" },
    };

    const secondEvent: FakeToolEvent = {
      tool: "shell",
      sessionID: "s1",
      input: { command: "git push origin main" },
    };

    const firstFailure = yield* runHookFailure(() =>
      hookOf(first.handlers["execute.before"])(firstEvent),
    );

    const secondFailure = yield* runHookFailure(() =>
      hookOf(second.handlers["execute.before"])(secondEvent),
    );

    expect(firstFailure?.message).toBe("blocked by test");
    expect(secondFailure?.message).toBe("blocked by test");
  }),
);

it.effect("refuses a second plugin of the same name in one location", () =>
  Effect.gen(function* () {
    const first = fakeContext("/work/duplicate");
    const second = fakeContext("/work/duplicate");
    const slot = yield* hostSlot();
    const scope = opencodeScope(first.context.location);
    const source = fileURLToPath(new URL("../../src/agents/opencode.ts", import.meta.url));

    yield* attach(denyPush, first);

    const failure = yield* setupFailure(denyPush, second);

    expect(failure?.message).toBe(
      `tack: two plugins named "deny-push" are loaded in ${scope} (${source} and ${source}); give them different names.`,
    );
    expect(slot.plugins(scope).map((plugin) => plugin.name)).toEqual(["deny-push"]);

    const event: FakeToolEvent = {
      tool: "shell",
      sessionID: "s1",
      input: { command: "git push origin main" },
    };

    const denied = yield* runHookFailure(() => hookOf(first.handlers["execute.before"])(event));

    expect(denied?.message).toBe("blocked by test");
  }),
);

it.effect("hands leadership to the next registration when the leader unloads", () =>
  Effect.gen(function* () {
    const first = fakeContext("/work/leadership");
    const second = fakeContext("/work/leadership");
    const cleanup = yield* attach(safePush, first);

    yield* attach(signedPush, second);

    const ignored: FakeToolEvent = {
      tool: "shell",
      sessionID: "s1",
      input: { command: "git push origin main" },
    };

    yield* runHook(() => hookOf(second.handlers["execute.before"])(ignored));

    expect(ignored.input).toEqual({ command: "git push origin main" });

    yield* release(cleanup);

    const event: FakeToolEvent = {
      tool: "shell",
      sessionID: "s1",
      input: { command: "git push origin main" },
    };

    yield* runHook(() => hookOf(second.handlers["execute.before"])(event));

    expect(event.input).toEqual({ command: "git push origin main --signed" });
  }),
);

it.effect("removes the slot registration in the setup cleanup", () =>
  Effect.gen(function* () {
    const fake = fakeContext("/work/cleanup");
    const slot = yield* hostSlot();
    const cleanup = yield* attach(safePush, fake);
    const scope = opencodeScope(fake.context.location);

    expect(slot.plugins(scope)).toHaveLength(1);

    yield* release(cleanup);

    expect(slot.plugins(scope)).toEqual([]);
  }),
);

it.effect("appends a synthetic message with the delivery its when names", () =>
  Effect.gen(function* () {
    const fake = fakeContext("/work/append");
    const session = yield* handleOf(fake);

    const outcomes = [
      yield* Effect.promise(() => session.append("note", { when: "now" })),
      yield* Effect.promise(() => session.append("note", { when: "next" })),
      yield* Effect.promise(() => session.append("note", { when: "wake" })),
    ];

    expect(outcomes).toEqual([
      { status: "accepted" },
      { status: "accepted" },
      { status: "accepted" },
    ]);
    expect(fake.calls).toEqual([
      {
        method: "synthetic",
        input: { sessionID: "s1", text: "note", delivery: "steer", resume: false },
      },
      {
        method: "synthetic",
        input: { sessionID: "s1", text: "note", delivery: "queue", resume: false },
      },
      {
        method: "synthetic",
        input: { sessionID: "s1", text: "note", delivery: "steer", resume: true },
      },
    ]);
  }),
);

it.effect("compacts the session", () =>
  Effect.gen(function* () {
    const fake = fakeContext("/work/compact");
    const session = yield* handleOf(fake);

    const outcome = yield* Effect.promise(() => session.compact());

    expect(outcome).toEqual({ status: "accepted" });
    expect(fake.calls).toEqual([{ method: "compact", input: { sessionID: "s1" } }]);
  }),
);

it.effect("interrupts the session", () =>
  Effect.gen(function* () {
    const fake = fakeContext("/work/interrupt");
    const session = yield* handleOf(fake);

    const outcome = yield* Effect.promise(() => session.interrupt());

    expect(outcome).toEqual({ status: "accepted" });
    expect(fake.calls).toEqual([{ method: "interrupt", input: { sessionID: "s1" } }]);
  }),
);

it.effect("refuses an interrupt that found nothing to stop", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const fake = fakeContext("/work/no-interrupt");
    const session = yield* handleOf(fake);

    fake.interruptResult.interrupted = false;

    const outcome = yield* Effect.promise(() => session.interrupt());

    expect(outcome).toEqual({ status: "refused", reason: "nothing to interrupt" });
    expect(fake.calls).toEqual([{ method: "interrupt", input: { sessionID: "s1" } }]);
    expect(
      observed.lines().filter((line) => line.includes("interrupt refused: nothing to interrupt")),
    ).toHaveLength(1);
  }),
);

it.effect("switches to the model the handle names", () =>
  Effect.gen(function* () {
    const fake = fakeContext("/work/model");
    const session = yield* handleOf(fake);
    const model = { providerID: "anthropic", id: "claude-sonnet-4-5" };

    const outcome = yield* Effect.promise(() => session.setModel(model));

    expect(outcome).toEqual({ status: "accepted" });
    expect(fake.calls).toEqual([{ method: "switchModel", input: { sessionID: "s1", model } }]);
  }),
);

it.effect("refuses an action the harness rejects, naming its message", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const fake = fakeContext("/work/rejected", undefined, new Error("no such session"));
    const session = yield* handleOf(fake);

    const outcome = yield* Effect.promise(() => session.compact());

    expect(outcome).toEqual({ status: "refused", reason: "no such session" });
    expect(fake.calls).toEqual([{ method: "compact", input: { sessionID: "s1" } }]);
    expect(
      observed.lines().filter((line) => line.includes("compact refused: no such session")),
    ).toHaveLength(1);
  }),
);

it.effect("reports every action on an ended session as ended, with no harness call", () =>
  Effect.gen(function* () {
    let captured: Session | undefined;

    const capture = createAgentPlugin(() => ({
      name: "capture",

      promptSent: (_prompt, ctx) => {
        captured = ctx.session;

        return undefined;
      },
    }));

    const fake = fakeContext("/work/ended");

    fake.events.push({
      type: "session.deleted",
      location: { directory: "/work/ended" },
      data: { sessionID: "s1" },
    });

    const cleanup = yield* attach(capture, fake);

    yield* runHook(() => hookOf(fake.handlers.prompt)({ sessionID: "s1", prompt: { text: "hi" } }));

    const session = captured;

    if (session === undefined) {
      throw new Error("the adapter gave the hook no session handle");
    }

    yield* Effect.promise(() => streamOf(fake).settled);

    const outcomes = [
      yield* Effect.promise(() => session.append("note")),
      yield* Effect.promise(() => session.compact()),
      yield* Effect.promise(() => session.interrupt()),
      yield* Effect.promise(() =>
        session.setModel({ providerID: "anthropic", id: "claude-sonnet-4-5" }),
      ),
    ];

    expect(outcomes).toEqual([
      { status: "ended" },
      { status: "ended" },
      { status: "ended" },
      { status: "ended" },
    ]);
    expect(fake.calls).toEqual([]);

    yield* release(cleanup);
  }),
);

/** The one subscription a fake recorded. */
function streamOf(fake: FakeContext): FakeEventStream {
  const stream = fake.subscriptions[0];

  if (stream === undefined) {
    throw new Error("the adapter subscribed to no events");
  }

  return stream;
}

/** The lifecycle, step and idle events one location's subscription must sort through. */
function lifecycleEvents(directory: string): FakeLifecycleEvent[] {
  return [
    {
      type: "session.created",
      location: { directory: "/work/elsewhere" },
      data: { sessionID: "other" },
    },
    {
      type: "session.created",
      location: { directory },
      data: { sessionID: "s1" },
    },
    {
      type: "session.step.ended",
      location: { directory },
      data: { sessionID: "s1" },
    },
    {
      type: "session.step.failed",
      location: { directory },
      data: { sessionID: "s1", error: { type: "aborted" } },
    },
    {
      type: "session.step.failed",
      location: { directory },
      data: { sessionID: "s1", error: { type: "api_error" } },
    },
    {
      type: "session.deleted",
      location: { directory },
      data: { sessionID: "s1" },
    },
    {
      type: "session.archived",
      location: { directory },
      data: { sessionID: "s1" },
    },
  ];
}

it.effect("reports this location's lifecycle and step events", () =>
  Effect.gen(function* () {
    const seen: string[] = [];

    const watch = createAgentPlugin(() => ({
      name: "watch",

      sessionCreated: (event) => {
        seen.push(`created:${event.resumed}`);
      },

      sessionEnded: (event) => {
        seen.push(`ended:${event.reason}`);
      },

      responseFinished: (event) => {
        seen.push(`finished:${event.reason}`);
      },
    }));

    const fake = fakeContext("/work/events");

    fake.events.push(...lifecycleEvents("/work/events"));

    const cleanup = yield* attach(watch, fake);

    yield* Effect.promise(() => streamOf(fake).settled);

    expect(streamOf(fake).options?.types).toEqual([
      "session.created",
      "session.deleted",
      "session.archived",
      "session.step.ended",
      "session.step.failed",
    ]);
    expect(seen).toEqual([
      "created:false",
      "finished:done",
      "finished:aborted",
      "finished:error",
      "ended:closed",
    ]);

    yield* release(cleanup);
  }),
);

it.effect("drops an event for a session it reported ended", () =>
  Effect.gen(function* () {
    const seen: string[] = [];

    const watch = createAgentPlugin(() => ({
      name: "watch",

      sessionCreated: (event) => {
        seen.push(`created:${event.resumed}`);
      },

      sessionEnded: (event) => {
        seen.push(`ended:${event.reason}`);
      },

      responseFinished: (event) => {
        seen.push(`finished:${event.reason}`);
      },

      sessionIdle: () => {
        seen.push("idle");
      },
    }));

    const fake = fakeContext("/work/dropped");

    fake.events.push(
      {
        type: "session.created",
        location: { directory: "/work/dropped" },
        data: { sessionID: "s1" },
      },
      {
        type: "session.deleted",
        location: { directory: "/work/dropped" },
        data: { sessionID: "s1" },
      },
      {
        type: "session.archived",
        location: { directory: "/work/dropped" },
        data: { sessionID: "s1" },
      },
      {
        type: "session.step.ended",
        location: { directory: "/work/dropped" },
        data: { sessionID: "s1" },
      },
      {
        type: "session.idle",
        location: { directory: "/work/dropped" },
        data: { sessionID: "s1" },
      },
    );

    const cleanup = yield* attach(watch, fake);

    yield* Effect.promise(() => streamOf(fake).settled);

    expect(seen).toEqual(["created:false", "ended:closed"]);

    yield* release(cleanup);
  }),
);

it.effect("forgets the oldest ended session past the cap", () =>
  Effect.gen(function* () {
    const seen: string[] = [];

    const watch = createAgentPlugin(() => ({
      name: "watch",

      sessionCreated: (event) => {
        seen.push(`created:${event.session.id}:${event.resumed}`);
      },

      sessionEnded: () => {
        seen.push("ended");
      },

      responseFinished: () => {
        seen.push("finished");
      },
    }));

    const fake = fakeContext("/work/cap");
    const location = { directory: "/work/cap" };

    for (let index = 0; index <= 1024; index += 1) {
      fake.events.push(
        { type: "session.created", location, data: { sessionID: `s${index}` } },
        { type: "session.deleted", location, data: { sessionID: `s${index}` } },
      );
    }

    fake.events.push({ type: "session.step.ended", location, data: { sessionID: "s0" } });

    const cleanup = yield* attach(watch, fake);

    yield* Effect.promise(() => streamOf(fake).settled);

    expect(seen.slice(-2)).toEqual(["created:s0:true", "finished"]);

    yield* release(cleanup);
  }),
);

it.effect("reports a session it first sees later with resumed true", () =>
  Effect.gen(function* () {
    const seen: string[] = [];

    const watch = createAgentPlugin(() => ({
      name: "watch",
      sessionCreated: (event) => {
        seen.push(`created:${event.resumed}`);
      },
      responseFinished: (event) => {
        seen.push(`finished:${event.reason}`);
      },
    }));

    const fake = fakeContext("/work/resumed");

    fake.events.push({
      type: "session.step.ended",
      location: { directory: "/work/resumed" },
      data: { sessionID: "old" },
    });

    const cleanup = yield* attach(watch, fake);

    yield* Effect.promise(() => streamOf(fake).settled);

    expect(seen).toEqual(["created:true", "finished:done"]);

    yield* release(cleanup);
  }),
);

it.effect("ignores an event with no location and warns once per process", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const seen: string[] = [];

    const watch = createAgentPlugin(() => ({
      name: "watch",
      sessionCreated: (event) => {
        seen.push(`created:${event.resumed}`);
      },
      responseFinished: (event) => {
        seen.push(`finished:${event.reason}`);
      },
    }));

    const fake = fakeContext("/work/no-location");

    fake.events.push(
      { type: "session.created", data: { sessionID: "lost" } },
      { type: "session.step.ended", data: { sessionID: "lost" } },
      {
        type: "session.step.ended",
        location: { directory: "/work/no-location" },
        data: { sessionID: "s1" },
      },
    );

    const cleanup = yield* attach(watch, fake);

    yield* Effect.promise(() => streamOf(fake).settled);

    expect(seen).toEqual(["created:true", "finished:done"]);
    expect(
      observed
        .lines()
        .filter((line) =>
          line.includes("tack: an OpenCode event carried no location; tack ignores it"),
        ),
    ).toHaveLength(1);

    yield* release(cleanup);
  }),
);

it.effect("attributes a locationless event to a session it has already reported", () =>
  Effect.gen(function* () {
    const seen: string[] = [];

    const watch = createAgentPlugin(() => ({
      name: "watch",

      sessionCreated: (event) => {
        seen.push(`created:${event.resumed}`);
      },

      sessionEnded: (event) => {
        seen.push(`ended:${event.reason}`);
      },

      responseFinished: (event) => {
        seen.push(`finished:${event.reason}`);
      },
    }));

    const fake = fakeContext("/work/attributed");

    fake.events.push(
      {
        type: "session.created",
        location: { directory: "/work/attributed" },
        data: { sessionID: "s1" },
      },
      { type: "session.step.ended", data: { sessionID: "s1" } },
      { type: "session.deleted", data: { sessionID: "s1" } },
    );

    const cleanup = yield* attach(watch, fake);

    yield* Effect.promise(() => streamOf(fake).settled);

    expect(seen).toEqual(["created:false", "finished:done", "ended:closed"]);

    yield* release(cleanup);
  }),
);

it.effect("waits for a session's creation report before running its idle", () =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const started = Promise.withResolvers<void>();
    let finish: (() => void) | undefined;

    const watch = createAgentPlugin(() => ({
      name: "watch",

      sessionCreated: () => {
        seen.push("created");
        started.resolve();

        const { promise, resolve } = Promise.withResolvers<void>();

        finish = () => {
          seen.push("created:done");
          resolve();
        };

        return promise;
      },

      sessionIdle: () => {
        seen.push("idle");
      },
    }));

    const fake = fakeContext("/work/race");
    const cleanup = yield* attach(watch, fake);

    const pending = Promise.resolve(hookOf(fake.handlers.idle)({ sessionID: "s1" }));

    yield* Effect.promise(() => started.promise);

    expect(seen).toEqual(["created"]);

    if (finish === undefined) {
      throw new Error("the creation report never started");
    }

    finish();

    yield* Effect.promise(() => pending);

    expect(seen).toEqual(["created", "created:done", "idle"]);

    yield* release(cleanup);
  }),
);

it.effect("restarts a failed subscription and keeps reporting", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const seen: string[] = [];
    const reported = Promise.withResolvers<void>();

    const watch = createAgentPlugin(() => ({
      name: "watch",

      sessionCreated: (event) => {
        seen.push(`created:${event.resumed}`);
        reported.resolve();
      },
    }));

    const fake = fakeContext("/work/resume");

    fake.subscriptionFailures.remaining = 1;
    fake.events.push({
      type: "session.created",
      location: { directory: "/work/resume" },
      data: { sessionID: "s1" },
    });

    const cleanup = yield* attach(watch, fake);

    yield* Effect.promise(() => reported.promise);

    expect(fake.subscriptions).toHaveLength(2);
    expect(seen).toEqual(["created:false"]);
    expect(
      observed
        .lines()
        .filter((line) => line.includes("tack: OpenCode event subscription failed; retrying")),
    ).toHaveLength(1);

    yield* release(cleanup);
  }),
);

it.effect("counts subscription failures from zero again after a delivered event", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const seen: string[] = [];

    const fake = fakeContext("/work/consecutive");

    const watch = createAgentPlugin(() => ({
      name: "watch",

      sessionCreated: () => {
        seen.push("created");
        fake.subscriptionFailures.remaining = 4;
      },
    }));

    fake.subscriptionFailures.remaining = 1;
    fake.events.push({
      type: "session.created",
      location: { directory: "/work/consecutive" },
      data: { sessionID: "s1" },
    });

    vi.useFakeTimers();

    const cleanup = yield* attach(watch, fake);

    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(3_100));

    vi.useRealTimers();

    const attempts = observed
      .lines()
      .filter((line) => line.includes("tack: OpenCode event subscription failed; retrying"))
      .map((line) => /\(attempt (\d+) of \d+\)/.exec(line)?.[1]);

    // One failure, then a delivered event, then four more: the new run counts
    // from zero, so its last failure is the fourth attempt, not the fifth, and
    // reporting continues.
    expect(attempts).toEqual(["1", "1", "2", "3", "4"]);
    expect(fake.subscriptions).toHaveLength(6);
    expect(seen).toEqual(["created"]);
    expect(
      observed.lines().filter((line) => line.includes("lifecycle reporting stopped")),
    ).toHaveLength(0);

    yield* release(cleanup);
  }),
);

it.effect("stops restarting after five failed subscriptions, saying so", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const seen: string[] = [];

    const watch = createAgentPlugin(() => ({
      name: "watch",

      sessionCreated: () => {
        seen.push("created");
      },
    }));

    const fake = fakeContext("/work/give-up");

    fake.subscriptionFailures.remaining = 6;

    vi.useFakeTimers();

    const cleanup = yield* attach(watch, fake);

    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(3_100));

    vi.useRealTimers();

    expect(
      observed
        .lines()
        .filter((line) => line.includes("lifecycle reporting stopped: the stream dropped")),
    ).toHaveLength(1);
    expect(fake.subscriptions).toHaveLength(6);
    expect(seen).toEqual([]);

    yield* release(cleanup);
  }),
);

it.effect("reports idle through the experimental hook", () =>
  Effect.gen(function* () {
    const seen: string[] = [];

    const watch = createAgentPlugin(() => ({
      name: "watch",
      sessionIdle: () => {
        seen.push("idle");
      },
    }));

    const fake = fakeContext("/work/idle");
    const cleanup = yield* attach(watch, fake);

    yield* runHook(() => hookOf(fake.handlers.idle)({ sessionID: "s1" }));

    expect(seen).toEqual(["idle"]);
    expect(streamOf(fake).options?.types).not.toContain("session.idle");

    yield* release(cleanup);
  }),
);

it.effect("falls back to the session.idle event when the hook is absent", () =>
  Effect.gen(function* () {
    const seen: string[] = [];

    const watch = createAgentPlugin(() => ({
      name: "watch",
      sessionIdle: () => {
        seen.push("idle");
      },
    }));

    const fake = fakeContext("/work/fallback", undefined, undefined, true);

    fake.events.push({
      type: "session.idle",
      location: { directory: "/work/fallback" },
      data: { sessionID: "s1" },
    });

    const cleanup = yield* attach(watch, fake);

    yield* Effect.promise(() => streamOf(fake).settled);

    expect(fake.handlers.idle).toBeUndefined();
    expect(streamOf(fake).options?.types).toContain("session.idle");
    expect(seen).toEqual(["idle"]);

    yield* release(cleanup);
  }),
);

it.effect("maps permission allow, deny and leave onto the evaluation", () =>
  Effect.gen(function* () {
    const gate = createAgentPlugin(() => ({
      name: "gate",

      permissionAsked: (request) => {
        if (request.resources.some((resource) => resource.startsWith("/infra/"))) {
          return { deny: "/infra/ is off limits." };
        }

        if (request.action === "read") {
          return { allow: true };
        }

        return undefined;
      },
    }));

    const fake = fakeContext("/work/permission");
    const cleanup = yield* attach(gate, fake);
    const evaluate = hookOf(fake.handlers.evaluate);

    const denied: FakePermissionEvent = {
      sessionID: "s1",
      action: "shell",
      resources: ["/infra/deploy.sh"],
      effect: "ask",
    };

    yield* runHook(() => evaluate(denied));

    expect(denied).toEqual({
      sessionID: "s1",
      action: "shell",
      resources: ["/infra/deploy.sh"],
      effect: "deny",
      message: "/infra/ is off limits.",
    });

    const allowed: FakePermissionEvent = {
      sessionID: "s1",
      action: "read",
      resources: ["/work/readme.md"],
      effect: "ask",
    };

    yield* runHook(() => evaluate(allowed));

    expect(allowed.effect).toBe("allow");

    const left: FakePermissionEvent = {
      sessionID: "s1",
      action: "write",
      resources: ["/work/notes.md"],
      effect: "ask",
      message: "the person's own prompt",
    };

    yield* runHook(() => evaluate(left));

    expect(left.effect).toBe("ask");
    expect(left.message).toBe("the person's own prompt");

    yield* release(cleanup);
  }),
);
