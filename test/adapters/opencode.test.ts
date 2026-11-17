import { afterEach, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import type * as oc from "@opencode/plugin";

import { HOST_KEY, hostSlot } from "../../src/host/host.ts";
import type { AgentPlugin, ToolCall, ToolResult } from "../../src/index.ts";
import { createAgentPlugin } from "../../src/index.ts";

const DIRECTORY = "/work/app";
const SCOPE = `opencode:${DIRECTORY}`;

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

interface FakeHandlers {
  "execute.before"?: FakeToolCallback;
  "execute.after"?: FakeToolCallback;
  prompt?: FakePromptCallback;
}

interface FakeContext {
  readonly context: oc.Plugin.Context;
  readonly handlers: FakeHandlers;
  readonly disposed: string[];
}

interface FakeRegistration {
  readonly dispose: () => Promise<void>;
}

/** The fake's shape, which the adapter's three Context members cover. */
interface FakeCandidate {
  readonly location: { readonly directory: string };
  readonly tool: {
    readonly hook: (
      name: "execute.before" | "execute.after",
      callback: FakeToolCallback,
    ) => Promise<FakeRegistration>;
  };
  readonly session: {
    readonly hook: (name: "prompt", callback: FakePromptCallback) => Promise<FakeRegistration>;
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

/** The fake implements the three Context members the adapter reads. */
function isOpenCodeContext(value: FakeCandidate): value is oc.Plugin.Context {
  return (
    Predicate.isString(value.location.directory) &&
    Predicate.isFunction(value.tool.hook) &&
    Predicate.isFunction(value.session.hook)
  );
}

function fakeContext(directory: string): FakeContext {
  const disposed: string[] = [];
  const handlers: FakeHandlers = {};

  const fake = {
    location: { directory },
    tool: {
      hook: (name: "execute.before" | "execute.after", callback: FakeToolCallback) => {
        handlers[name] = callback;

        return registration(name, disposed);
      },
    },
    session: {
      hook: (name: "prompt", callback: FakePromptCallback) => {
        handlers.prompt = callback;

        return registration(name, disposed);
      },
    },
  };

  if (!isOpenCodeContext(fake)) {
    throw new Error("the test fake is not an OpenCode context");
  }

  return { context: fake, handlers, disposed };
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

function release(cleanup: oc.Plugin.Cleanup): Effect.Effect<void> {
  return Effect.promise(() => Promise.resolve(cleanup()));
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

afterEach(() => {
  Reflect.deleteProperty(globalThis, HOST_KEY);
});

it.effect("throws the deny reason and leaves the input untouched", () =>
  Effect.gen(function* () {
    const fake = fakeContext(DIRECTORY);

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
    const fake = fakeContext(DIRECTORY);

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

    const fake = fakeContext(DIRECTORY);
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

    const fake = fakeContext(DIRECTORY);

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

it.effect("hands leadership to the next registration when the leader unloads", () =>
  Effect.gen(function* () {
    const first = fakeContext(DIRECTORY);
    const second = fakeContext(DIRECTORY);
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
    const fake = fakeContext(DIRECTORY);
    const slot = yield* hostSlot();
    const cleanup = yield* attach(safePush, fake);

    expect(slot.plugins(SCOPE)).toHaveLength(1);

    yield* release(cleanup);

    expect(slot.plugins(SCOPE)).toEqual([]);
  }),
);
