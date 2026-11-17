import { afterEach, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { hostSlot } from "../../src/host/host.ts";
import type { ToolCall, ToolResult } from "../../src/index.ts";
import { createAgentPlugin } from "../../src/index.ts";

type PiEventName = "tool_call" | "tool_result" | "input" | "session_shutdown";

interface FakePiContext {
  readonly sessionManager: { readonly getSessionId: () => string };
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

type FakeEvent = FakeToolCallEvent | FakeToolResultEvent | FakeInputEvent | FakeShutdownEvent;

type FakeResult =
  | { readonly block: true; readonly reason: string }
  | { readonly action: "transform"; readonly text: string }
  | undefined;

type FakeHandler = (event: FakeEvent, ctx: FakePiContext) => FakeResult | Promise<FakeResult>;

interface FakePi {
  readonly pi: ExtensionAPI;
  readonly handlers: Partial<Record<PiEventName, FakeHandler>>;
  readonly unsubscribed: string[];
}

const ctx: FakePiContext = { sessionManager: { getSessionId: () => "s1" } };

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

/** The fake's shape: the one ExtensionAPI member the factory reads. */
interface FakeCandidate {
  readonly on: (...args: never[]) => () => void;
}

/** The fake implements the one ExtensionAPI member the factory reads. */
function isExtensionApi(value: FakeCandidate): value is ExtensionAPI {
  return Predicate.isFunction(value.on);
}

function fakePi(): FakePi {
  const handlers: Partial<Record<PiEventName, FakeHandler>> = {};
  const unsubscribed: string[] = [];

  const fake = {
    on: (name: PiEventName, handler: FakeHandler) => {
      handlers[name] = handler;

      return () => {
        unsubscribed.push(name);
      };
    },
  };

  if (!isExtensionApi(fake)) {
    throw new Error("the test fake is not a Pi extension API");
  }

  const created = { pi: fake, handlers, unsubscribed };

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

afterEach(() => {
  const shutdowns: Array<Promise<FakeResult>> = [];

  for (const fake of started.splice(0)) {
    const shutdown = fake.handlers.session_shutdown;

    if (shutdown !== undefined) {
      shutdowns.push(Promise.resolve(shutdown({ reason: "quit" }, ctx)));
    }
  }

  return Promise.all(shutdowns);
});

it.effect("blocks a denied call with the reason", () =>
  Effect.gen(function* () {
    const fake = fakePi();
    const event = { toolName: "bash", input: { command: "git push origin main" } };

    denyPush.pi()(fake.pi);

    const result = yield* runHook(() => hookOf(fake.handlers, "tool_call")(event, ctx));

    expect(result).toEqual({ block: true, reason: "blocked by test" });
    expect(event.input).toEqual({ command: "git push origin main" });
  }),
);

it.effect("rewrites the command in place and keeps the other input fields", () =>
  Effect.gen(function* () {
    const fake = fakePi();
    const event = { toolName: "bash", input: { command: "git push origin main", timeout: 30 } };

    safePush.pi()(fake.pi);

    yield* runHook(() => hookOf(fake.handlers, "tool_call")(event, ctx));

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

    yield* runHook(() => hookOf(fake.handlers, "tool_call")(bash, ctx));
    yield* runHook(() => hookOf(fake.handlers, "tool_call")(powershell, ctx));

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

    const skipped = yield* runHook(() => hookOf(fake.handlers, "input")(fromExtension, ctx));

    expect(skipped).toBeUndefined();

    const transformed = yield* runHook(() => hookOf(fake.handlers, "input")(interactive, ctx));

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

    yield* runHook(() => hookOf(fake.handlers, "tool_result")(event, ctx));

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

    yield* runHook(() => hookOf(fake.handlers, "session_shutdown")(event, ctx));

    expect(slot.plugins("pi")).toEqual([]);
    expect(fake.unsubscribed).toEqual(["tool_call", "tool_result", "input", "session_shutdown"]);
  }),
);
