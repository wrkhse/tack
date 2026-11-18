import { afterEach, expect, it, vi } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { hostSlot } from "../../src/host/host.ts";
import type { Session, ToolCall, ToolResult } from "../../src/index.ts";
import { createAgentPlugin } from "../../src/index.ts";
import { quietConsole } from "../helpers.ts";

type PiEventName =
  | "tool_call"
  | "tool_result"
  | "input"
  | "session_start"
  | "turn_end"
  | "agent_settled"
  | "session_shutdown";

interface FakeCompactOptions {
  readonly customInstructions?: string;
  readonly onComplete?: () => void;
  readonly onError?: (error: Error) => void;
}

interface FakeModel {
  readonly providerID: string;
  readonly id: string;
}

interface FakePiContext {
  readonly sessionManager: { readonly getSessionId: () => string };
  readonly modelRegistry: {
    readonly find: (provider: string, id: string) => FakeModel | undefined;
  };
  readonly compact: (options: FakeCompactOptions) => void;
  readonly abort: () => void;
}

interface FakeToolCallEvent {
  readonly toolName: string;
  readonly input: unknown;
}

interface FakeToolResultEvent {
  readonly toolName: string;
  readonly input: unknown;
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  >;
  readonly isError: boolean;
}

interface FakeInputEvent {
  readonly text: string;
  readonly source: "interactive" | "rpc" | "extension";
}

interface FakeShutdownEvent {
  readonly reason: "quit" | "reload" | "new" | "resume" | "fork";
}

interface FakeSessionStartEvent {
  readonly reason: "startup" | "reload" | "new" | "resume" | "fork";
}

interface FakeTurnEndEvent {
  readonly outcome: "completed" | "aborted" | "error";
}

interface FakeAgentSettledEvent {
  readonly aborted: boolean;
}

type FakeEvent =
  | FakeToolCallEvent
  | FakeToolResultEvent
  | FakeInputEvent
  | FakeSessionStartEvent
  | FakeTurnEndEvent
  | FakeAgentSettledEvent
  | FakeShutdownEvent;

type FakeResult =
  | { readonly block: true; readonly reason: string }
  | { readonly action: "transform"; readonly text: string }
  | undefined;

type FakeHandler = (event: FakeEvent, ctx: FakePiContext) => FakeResult | Promise<FakeResult>;

/** The custom message the adapter asks Pi to inject. */
interface FakeAppendMessage {
  readonly customType: string;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly display: boolean;
  readonly details: Record<string, never>;
}

interface FakeSendOptions {
  readonly deliverAs?: "steer" | "followUp" | "nextTurn";
  readonly triggerTurn?: boolean;
}

/** One native call the adapter made, as Pi received it. */
type FakeCall =
  | {
      readonly method: "sendMessage";
      readonly message: FakeAppendMessage;
      readonly options: FakeSendOptions | undefined;
    }
  | { readonly method: "setModel"; readonly model: FakeModel }
  | { readonly method: "compact"; readonly options: FakeCompactOptions }
  | { readonly method: "abort" };

interface FakePi {
  readonly pi: ExtensionAPI;
  readonly context: FakePiContext;
  readonly handlers: Partial<Record<PiEventName, FakeHandler>>;
  readonly unsubscribed: string[];
  readonly calls: FakeCall[];
  /** When set, every action throws Pi's stale-context error. */
  readonly stale: { active: boolean };
}

/** The fakes a case started, shut down after it so the next case starts clean. */
const started: FakePi[] = [];

const safePush = createAgentPlugin(() => ({
  name: "safe-push",

  toolBefore: (call) =>
    call.tool === "shell" ? { rewrite: { command: `${call.input.command} --dry-run` } } : undefined,
}));

const denyPush = createAgentPlugin(() => ({
  name: "deny-push",

  toolBefore: (call) => (call.tool === "shell" ? { deny: "blocked by test" } : undefined),
}));

/** The message one append sends, as Pi's `sendMessage` receives it. */
function messageOf(text: string): FakeAppendMessage {
  return {
    customType: "tack.append",
    content: [{ type: "text", text }],
    display: false,
    details: {},
  };
}

/** The options one `sendMessage` call carried, as Pi received them. */
function optionsOf(call: FakeCall | undefined): FakeSendOptions {
  if (call?.method !== "sendMessage" || call.options === undefined) {
    throw new Error("the adapter made no sendMessage call with options");
  }

  return call.options;
}

/** The options one `compact` call carried, as Pi received them. */
function compactOf(call: FakeCall | undefined): FakeCompactOptions {
  if (call?.method !== "compact") {
    throw new Error("the adapter made no compact call");
  }

  return call.options;
}

/** The fake's shape: the one ExtensionAPI member the factory reads. */
interface FakeCandidate {
  readonly on: (...args: never[]) => () => void;
}

/** The fake implements the one ExtensionAPI member the factory reads. */
function isExtensionApi(value: FakeCandidate): value is ExtensionAPI {
  return Predicate.isFunction(value.on);
}

function fakePi(modelResult = true): FakePi {
  const handlers: Partial<Record<PiEventName, FakeHandler>> = {};
  const unsubscribed: string[] = [];
  const calls: FakeCall[] = [];
  const stale = { active: false };

  const assertFresh = (): void => {
    if (stale.active) {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    }
  };

  const context: FakePiContext = {
    sessionManager: { getSessionId: () => "s1" },
    modelRegistry: {
      find: (provider, id) =>
        provider === "anthropic" && id === "claude-sonnet-4-5"
          ? { providerID: provider, id }
          : undefined,
    },
    compact: (options) => {
      assertFresh();
      calls.push({ method: "compact", options });
    },
    abort: () => {
      assertFresh();
      calls.push({ method: "abort" });
    },
  };

  const fake = {
    on: (name: PiEventName, handler: FakeHandler) => {
      handlers[name] = handler;

      return () => {
        unsubscribed.push(name);
      };
    },
    sendMessage: (message: FakeAppendMessage, options?: FakeSendOptions) => {
      assertFresh();
      calls.push({ method: "sendMessage", message, options });
    },
    setModel: (model: FakeModel) => {
      assertFresh();
      calls.push({ method: "setModel", model });

      return Promise.resolve(modelResult);
    },
  };

  if (!isExtensionApi(fake)) {
    throw new Error("the test fake is not a Pi extension API");
  }

  const created = { pi: fake, context, handlers, unsubscribed, calls, stale };

  started.push(created);

  return created;
}

function hookOf(handlers: FakePi["handlers"], name: PiEventName): FakeHandler {
  const handler = handlers[name];

  if (handler === undefined) {
    throw new Error(`the adapter registered no ${name} handler`);
  }

  return handler;
}

/** Runs a promise-land hook inside the test's Effect. */
function runHook<A>(hook: () => A | Promise<A>): Effect.Effect<A> {
  return Effect.promise(() => Promise.resolve(hook()));
}

/** Registers a plugin that keeps the handle its hook receives, and returns that handle. */
function handleOf(fake: FakePi): Effect.Effect<Session> {
  return Effect.gen(function* () {
    let captured: Session | undefined;

    const capture = createAgentPlugin(() => ({
      name: "capture",

      promptSent: (_prompt, ctx) => {
        captured = ctx.session;

        return undefined;
      },
    }));

    capture.pi()(fake.pi);

    const event: FakeInputEvent = { text: "hi", source: "interactive" };

    yield* runHook(() => hookOf(fake.handlers, "input")(event, fake.context));

    if (captured === undefined) {
      throw new Error("the adapter gave the hook no session handle");
    }

    return captured;
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();

  const shutdowns: Array<Promise<FakeResult>> = [];

  for (const fake of started.splice(0)) {
    const shutdown = fake.handlers.session_shutdown;

    if (shutdown !== undefined) {
      shutdowns.push(Promise.resolve(shutdown({ reason: "quit" }, fake.context)));
    }
  }

  return Promise.all(shutdowns);
});

it.effect("blocks a denied call with the reason", () =>
  Effect.gen(function* () {
    const fake = fakePi();
    const event = { toolName: "bash", input: { command: "git push origin main" } };

    denyPush.pi()(fake.pi);

    const result = yield* runHook(() => hookOf(fake.handlers, "tool_call")(event, fake.context));

    expect(result).toEqual({ block: true, reason: "blocked by test" });
    expect(event.input).toEqual({ command: "git push origin main" });
  }),
);

it.effect("rewrites the command in place and keeps the other input fields", () =>
  Effect.gen(function* () {
    const fake = fakePi();
    const event = { toolName: "bash", input: { command: "git push origin main", timeout: 30 } };

    safePush.pi()(fake.pi);

    yield* runHook(() => hookOf(fake.handlers, "tool_call")(event, fake.context));

    expect(event.input).toEqual({ command: "git push origin main --dry-run", timeout: 30 });
  }),
);

it.effect("maps bash and powershell to the shell tool with their dialect", () =>
  Effect.gen(function* () {
    const seen: ToolCall[] = [];

    const record = createAgentPlugin(() => ({
      name: "record",

      toolBefore: (call) => {
        seen.push(call);

        return undefined;
      },
    }));

    const fake = fakePi();

    record.pi()(fake.pi);

    const bash = { toolName: "bash", input: { command: "git status" } };
    const powershell = { toolName: "powershell", input: { command: "git status" } };

    yield* runHook(() => hookOf(fake.handlers, "tool_call")(bash, fake.context));
    yield* runHook(() => hookOf(fake.handlers, "tool_call")(powershell, fake.context));

    expect(seen[0]).toMatchObject({ tool: "shell", name: "bash", dialect: "posix" });
    expect(seen[1]).toMatchObject({ tool: "shell", name: "powershell", dialect: "powershell" });
  }),
);

it.effect("skips extension input and transforms interactive input", () =>
  Effect.gen(function* () {
    const note = createAgentPlugin(() => ({
      name: "push-note",
      promptSent: () => ({ append: "dry runs only." }),
    }));

    const fake = fakePi();
    const fromExtension: FakeInputEvent = { text: "hello", source: "extension" };
    const interactive: FakeInputEvent = { text: "hello", source: "interactive" };

    note.pi()(fake.pi);

    const skipped = yield* runHook(() =>
      hookOf(fake.handlers, "input")(fromExtension, fake.context),
    );

    expect(skipped).toBeUndefined();

    const transformed = yield* runHook(() =>
      hookOf(fake.handlers, "input")(interactive, fake.context),
    );

    expect(transformed).toEqual({ action: "transform", text: "hello\n\ndry runs only." });
  }),
);

it.effect("passes the joined text and error flag to toolAfter", () =>
  Effect.gen(function* () {
    const observed: Array<{ call: ToolCall; result: ToolResult }> = [];

    const observe = createAgentPlugin(() => ({
      name: "observe",

      toolAfter: (call, result) => {
        observed.push({ call, result });
      },
    }));

    const fake = fakePi();

    const event: FakeToolResultEvent = {
      toolName: "bash",
      input: { command: "git push origin main" },
      content: [
        { type: "text", text: "one" },
        { type: "image", data: "x", mimeType: "image/png" },
        { type: "text", text: "two" },
      ],
      isError: true,
    };

    observe.pi()(fake.pi);

    yield* runHook(() => hookOf(fake.handlers, "tool_result")(event, fake.context));

    expect(observed[0]?.result).toEqual({ output: "one\ntwo", isError: true });
    expect(observed[0]?.call).toMatchObject({ tool: "shell", name: "bash", dialect: "posix" });
  }),
);

it.effect("ends the registration and unsubscribes on session shutdown", () =>
  Effect.gen(function* () {
    const fake = fakePi();
    const slot = yield* hostSlot();
    const event: FakeShutdownEvent = { reason: "quit" };

    safePush.pi()(fake.pi);

    expect(slot.plugins("pi")).toHaveLength(1);

    yield* runHook(() => hookOf(fake.handlers, "session_shutdown")(event, fake.context));

    expect(slot.plugins("pi")).toEqual([]);
    expect(fake.unsubscribed).toEqual([
      "tool_call",
      "tool_result",
      "input",
      "session_start",
      "turn_end",
      "agent_settled",
      "session_shutdown",
    ]);
  }),
);

it.effect("throws when the same name loads twice in the process scope", () =>
  Effect.gen(function* () {
    const first = fakePi();
    const second = fakePi();

    safePush.pi()(first.pi);

    expect(() => safePush.pi()(second.pi)).toThrow(
      'tack: two plugins named "safe-push" are loaded in pi',
    );

    const event = { toolName: "bash", input: { command: "git push origin main" } };

    yield* runHook(() => hookOf(first.handlers, "tool_call")(event, first.context));

    expect(event.input).toEqual({ command: "git push origin main --dry-run" });
  }),
);

it.effect("appends a synthetic message with the options its when names", () =>
  Effect.gen(function* () {
    const fake = fakePi();
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
        method: "sendMessage",
        message: messageOf("note"),
        options: { deliverAs: "steer" },
      },
      {
        method: "sendMessage",
        message: messageOf("note"),
        options: { deliverAs: "followUp" },
      },
      {
        method: "sendMessage",
        message: messageOf("note"),
        options: { deliverAs: "steer", triggerTurn: true },
      },
    ]);

    const now = optionsOf(fake.calls[0]);
    const next = optionsOf(fake.calls[1]);
    const wake = optionsOf(fake.calls[2]);

    expect("triggerTurn" in now).toBe(false);
    expect("triggerTurn" in next).toBe(false);
    expect(wake.triggerTurn).toBe(true);
  }),
);

it.effect("reports a completed compaction as accepted", () =>
  Effect.gen(function* () {
    const fake = fakePi();
    const session = yield* handleOf(fake);

    const pending = session.compact();

    yield* Effect.promise(() => vi.waitFor(() => expect(fake.calls).toHaveLength(1)));

    compactOf(fake.calls[0]).onComplete?.();

    const outcome = yield* Effect.promise(() => pending);

    expect(outcome).toEqual({ status: "accepted" });
    expect(fake.calls).toHaveLength(1);
  }),
);

it.effect("refuses a compaction Pi reports as failed", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const fake = fakePi();
    const session = yield* handleOf(fake);

    const pending = session.compact();

    yield* Effect.promise(() => vi.waitFor(() => expect(fake.calls).toHaveLength(1)));

    compactOf(fake.calls[0]).onError?.(new Error("out of room"));

    const outcome = yield* Effect.promise(() => pending);

    expect(outcome).toEqual({ status: "refused", reason: "out of room" });
    expect(
      observed.lines().filter((line) => line.includes("compact refused: out of room")),
    ).toHaveLength(1);
  }),
);

it.effect("does not accept a compaction before Pi reports it", () =>
  Effect.gen(function* () {
    const fake = fakePi();
    const session = yield* handleOf(fake);
    let settled = false;

    const pending = session.compact().then((outcome) => {
      settled = true;

      return outcome;
    });

    yield* Effect.promise(() => vi.waitFor(() => expect(fake.calls).toHaveLength(1)));

    expect(settled).toBe(false);

    compactOf(fake.calls[0]).onComplete?.();

    expect(yield* Effect.promise(() => pending)).toEqual({ status: "accepted" });
  }),
);

it.effect("interrupts the session", () =>
  Effect.gen(function* () {
    const fake = fakePi();
    const session = yield* handleOf(fake);

    const outcome = yield* Effect.promise(() => session.interrupt());

    expect(outcome).toEqual({ status: "accepted" });
    expect(fake.calls).toEqual([{ method: "abort" }]);
  }),
);

it.effect("switches to the model it found", () =>
  Effect.gen(function* () {
    const fake = fakePi();
    const session = yield* handleOf(fake);
    const model = { providerID: "anthropic", id: "claude-sonnet-4-5" };

    const outcome = yield* Effect.promise(() => session.setModel(model));

    expect(outcome).toEqual({ status: "accepted" });
    expect(fake.calls).toEqual([{ method: "setModel", model }]);
  }),
);

it.effect("refuses a model this agent does not have", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const fake = fakePi();
    const session = yield* handleOf(fake);

    const outcome = yield* Effect.promise(() =>
      session.setModel({ providerID: "openai", id: "gpt" }),
    );

    expect(outcome).toEqual({ status: "refused", reason: "no model openai/gpt for this agent" });
    expect(fake.calls).toEqual([]);
    expect(
      observed.lines().filter((line) => line.includes("setModel refused: no model openai/gpt")),
    ).toHaveLength(1);
  }),
);

it.effect("refuses a model Pi cannot authenticate", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const fake = fakePi(false);
    const session = yield* handleOf(fake);
    const model = { providerID: "anthropic", id: "claude-sonnet-4-5" };

    const outcome = yield* Effect.promise(() => session.setModel(model));

    expect(outcome).toEqual({
      status: "refused",
      reason: "no credentials for anthropic/claude-sonnet-4-5",
    });
    expect(fake.calls).toEqual([{ method: "setModel", model }]);
    expect(
      observed.lines().filter((line) => line.includes("setModel refused: no credentials")),
    ).toHaveLength(1);
  }),
);

it.effect("reports an ended session after its extension instance shut down", () =>
  Effect.gen(function* () {
    const fake = fakePi();
    const session = yield* handleOf(fake);
    const event: FakeShutdownEvent = { reason: "new" };

    yield* runHook(() => hookOf(fake.handlers, "session_shutdown")(event, fake.context));

    const outcome = yield* Effect.promise(() => session.append("note", { when: "wake" }));

    expect(outcome).toEqual({ status: "ended" });
    expect(fake.calls).toEqual([]);
  }),
);

it.effect("reports an action on a stale ctx as ended", () =>
  Effect.gen(function* () {
    const fake = fakePi();
    const session = yield* handleOf(fake);

    fake.stale.active = true;

    const outcomes = [
      yield* Effect.promise(() => session.append("note", { when: "wake" })),
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
  }),
);

it.effect("refuses a compaction that never reports", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const fake = fakePi();
    const session = yield* handleOf(fake);

    vi.useFakeTimers();

    const pending = session.compact();

    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));

    const outcome = yield* Effect.promise(() => pending);

    vi.useRealTimers();

    expect(outcome).toEqual({ status: "refused", reason: "compaction did not report" });
    expect(
      observed
        .lines()
        .filter((line) => line.includes("compact refused: compaction did not report")),
    ).toHaveLength(1);
  }),
);

it.effect("maps session_start's reason onto resumed", () =>
  Effect.gen(function* () {
    const seen: boolean[] = [];

    const watch = createAgentPlugin(() => ({
      name: "watch",
      sessionCreated: (event) => {
        seen.push(event.resumed);
      },
    }));

    const fake = fakePi();

    watch.pi()(fake.pi);

    for (const reason of ["startup", "resume", "fork", "new", "reload"] as const) {
      const event: FakeSessionStartEvent = { reason };

      yield* runHook(() => hookOf(fake.handlers, "session_start")(event, fake.context));
    }

    expect(seen).toEqual([false, true, true, false, false]);
  }),
);

it.effect("maps turn_end's outcome onto the response reason", () =>
  Effect.gen(function* () {
    const seen: string[] = [];

    const watch = createAgentPlugin(() => ({
      name: "watch",
      responseFinished: (event) => {
        seen.push(event.reason);
      },
    }));

    const fake = fakePi();

    watch.pi()(fake.pi);

    for (const outcome of ["completed", "aborted", "error"] as const) {
      const event: FakeTurnEndEvent = { outcome };

      yield* runHook(() => hookOf(fake.handlers, "turn_end")(event, fake.context));
    }

    expect(seen).toEqual(["done", "aborted", "error"]);
  }),
);

it.effect("reports agent_settled as sessionIdle", () =>
  Effect.gen(function* () {
    const seen: string[] = [];

    const watch = createAgentPlugin(() => ({
      name: "watch",
      sessionIdle: (event) => {
        seen.push(event.session.id);
      },
    }));

    const fake = fakePi();

    watch.pi()(fake.pi);

    const event: FakeAgentSettledEvent = { aborted: false };

    yield* runHook(() => hookOf(fake.handlers, "agent_settled")(event, fake.context));

    expect(seen).toEqual(["s1"]);
  }),
);

it.effect("registers no permission layer", () =>
  Effect.sync(() => {
    const fake = fakePi();

    safePush.pi()(fake.pi);

    expect("permission" in fake.pi).toBe(false);
    expect(Object.keys(fake.handlers)).toEqual([
      "tool_call",
      "tool_result",
      "input",
      "session_start",
      "turn_end",
      "agent_settled",
      "session_shutdown",
    ]);
  }),
);
