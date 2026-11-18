import { expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { DuplicateTool, createToolRegistry } from "../src/tools/registry.ts";
import type { TakenTool, ToolPort } from "../src/tools/registry.ts";
import type {
  CompiledTool,
  ToolCallResult,
  ToolContext,
  ToolDefinition,
} from "../src/tools/tool.ts";
import {
  DEFAULT_TIMEOUT_MS,
  InvalidTool,
  MAX_RESULT_BYTES,
  compileTools,
  invokeTool,
  tool,
} from "../src/tools/tool.ts";
import { noTools, thrownBy } from "./helpers.ts";

const ctx: ToolContext = {
  callId: "call-1",
  signal: undefined,
  session: undefined,
  tools: noTools(),
};

const monitorCreate = tool<{ key: string }>({
  name: "monitor_create",
  description: "Start watching a Jira issue",
  input: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
  run: (input) => ({
    content: [`watching ${input.key}`],
    details: { id: "m-1" },
  }),
});

function compile(
  definitions: Record<string, ToolDefinition>,
  hasSession = true,
): Effect.Effect<ReadonlyArray<CompiledTool>, InvalidTool> {
  return compileTools("monitor", definitions, hasSession);
}

function refusal(
  definitions: Record<string, ToolDefinition>,
  hasSession = true,
): Effect.Effect<InvalidTool, ReadonlyArray<CompiledTool>> {
  return Effect.flip(compile(definitions, hasSession));
}

function oneOf(tools: ReadonlyArray<CompiledTool>): CompiledTool {
  const [first] = tools;

  if (first === undefined) {
    throw new Error("the definition compiled no tool");
  }

  return first;
}

/** A caller's stop: the signal the handler sees, and the one way to fire it. */
interface TransportStop {
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

/**
 * Builds a caller's stop outside Effect's own cancellation: the transport fires
 * it by hand, not the Effect runtime.
 */
function transportStop(): TransportStop {
  const controller = new AbortController();

  return { signal: controller.signal, abort: () => controller.abort() };
}

/** A port that keeps what a registry asked of it. */
interface FakePort {
  readonly port: ToolPort;
  readonly installs: Array<ReadonlyArray<CompiledTool>>;
  readonly withdrawn: string[];
}

function fakePort(): FakePort {
  const installs: Array<ReadonlyArray<CompiledTool>> = [];
  const withdrawn: string[] = [];

  return {
    port: {
      install: (tools) => {
        installs.push(tools);
      },
      withdraw: (name) => {
        withdrawn.push(name);
      },
      settled: () => Promise.resolve(),
    },
    installs,
    withdrawn,
  };
}

function registry(
  port: FakePort,
  tools: ReadonlyArray<CompiledTool>,
  taken: ReadonlyArray<TakenTool> = [],
  hasSession = true,
) {
  return createToolRegistry(
    {
      plugin: "monitor",
      scope: 'opencode:["/work",null]',
      source: "/plugins/monitor/index.js",
      hasSession,
      port: port.port,
      taken,
    },
    tools,
  );
}

it.effect("compiles a definition and hands the handler its decoded input", () =>
  Effect.gen(function* () {
    const compiled = oneOf(yield* compile({ monitor_create: monitorCreate }));

    const result = yield* invokeTool(compiled, { input: { key: "PROJ-1" } }, ctx);

    expect(result).toEqual({ content: ["watching PROJ-1"], details: { id: "m-1" } });
  }),
);

it.effect("refuses a name no transport can spell the same way", () =>
  Effect.gen(function* () {
    const error = yield* refusal({
      Monitor: tool({ ...monitorCreate, name: "Monitor" }),
    });

    expect(error.message).toBe(
      'tack: tool "Monitor" in plugin "monitor" is invalid: name must match [a-z][a-z0-9_]*',
    );
  }),
);

it.effect("refuses an entry whose key is not the tool's own name", () =>
  Effect.gen(function* () {
    const error = yield* refusal({ other: monitorCreate });

    expect(error.message).toBe(
      'tack: tool "monitor_create" in plugin "monitor" is invalid: the tools entry "other" must hold the tool named "monitor_create"',
    );
  }),
);

it.effect("refuses two entries that share one tool name", () =>
  Effect.gen(function* () {
    const error = yield* refusal({ a: monitorCreate, b: monitorCreate });

    expect(error.message).toBe(
      'tack: tool "monitor_create" in plugin "monitor" is invalid: the tools entries "a" and "b" share this name',
    );
  }),
);

it.effect("refuses a header the importer cannot read, naming the tool", () =>
  Effect.gen(function* () {
    const error = yield* refusal({
      monitor_create: tool({
        ...monitorCreate,
        input: { type: "object", contains: { type: "string" } },
      }),
    });

    expect(error.tool).toBe("monitor_create");
    expect(error.message).toBe(
      'tack: tool "monitor_create" in plugin "monitor" is invalid: Cannot import JSON Schema keyword "contains": Effect has no equivalent constraint.\n  at ["schema"]["contains"]',
    );
  }),
);

it.effect("refuses a session tool on a transport that has no session", () =>
  Effect.gen(function* () {
    const needsSession = tool({ ...monitorCreate, needsSession: true });

    const error = yield* refusal({ monitor_create: needsSession }, false);

    expect(error.message).toBe(
      'tack: tool "monitor_create" in plugin "monitor" is invalid: needsSession is true, but this transport has no agent session',
    );

    const compiled = yield* compile({ monitor_create: needsSession }, true);

    expect(compiled).toHaveLength(1);
  }),
);

it.effect("refuses a timeout that is not a positive integer", () =>
  Effect.gen(function* () {
    const error = yield* refusal({
      monitor_create: tool({ ...monitorCreate, timeoutMs: 0 }),
    });

    expect(error.message).toBe(
      'tack: tool "monitor_create" in plugin "monitor" is invalid: timeoutMs must be a positive integer',
    );
  }),
);

it.effect("reports an input the header rejects, naming the field", () =>
  Effect.gen(function* () {
    const compiled = oneOf(yield* compile({ monitor_create: monitorCreate }));

    const result = yield* invokeTool(compiled, { input: {} }, ctx);

    expect(result).toEqual({
      content: ['tack: tool "monitor_create" rejected its input: Missing key\n  at ["key"]'],
      isError: true,
    });
  }),
);

it.effect("keeps the details and the error flag a handler returns", () =>
  Effect.gen(function* () {
    const refuse = tool({
      name: "monitor_refuse",
      description: "Refuse a monitor",
      input: { type: "object", properties: {} },
      run: () => ({ content: ["no such issue"], details: { code: 404 }, isError: true }),
    });

    const compiled = oneOf(yield* compile({ monitor_refuse: refuse }));

    const result = yield* invokeTool(compiled, { input: {} }, ctx);

    expect(result).toEqual({ content: ["no such issue"], details: { code: 404 }, isError: true });
  }),
);

it.effect("turns a handler that throws into an error result", () =>
  Effect.gen(function* () {
    const broken = tool({
      name: "monitor_broken",
      description: "Break a monitor",
      input: { type: "object", properties: {} },
      run: () => {
        throw new Error("boom");
      },
    });

    const compiled = oneOf(yield* compile({ monitor_broken: broken }));

    const result = yield* invokeTool(compiled, { input: {} }, ctx);

    expect(result).toEqual({
      content: ['tack: tool "monitor_broken" failed: boom'],
      isError: true,
    });
  }),
);

it.effect("refuses a result a handler built in the wrong shape", () =>
  Effect.gen(function* () {
    const wrong: ToolCallResult = JSON.parse('{"content":"not a list"}');

    const confused = tool({
      name: "monitor_confused",
      description: "Answer in the wrong shape",
      input: { type: "object", properties: {} },
      run: () => wrong,
    });

    const compiled = oneOf(yield* compile({ monitor_confused: confused }));

    const result = yield* invokeTool(compiled, { input: {} }, ctx);

    expect(result).toEqual({
      content: ['tack: tool "monitor_confused" returned an invalid result'],
      isError: true,
    });
  }),
);

it.effect("answers an error result when the handler outlives its timeout", () =>
  Effect.gen(function* () {
    const stalled = tool({
      name: "monitor_stall",
      description: "Never answer",
      input: { type: "object", properties: {} },
      run: () => Promise.race([]),
    });

    const compiled = oneOf(yield* compile({ monitor_stall: stalled }));

    const fiber = yield* invokeTool(compiled, { input: {} }, ctx).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.millis(DEFAULT_TIMEOUT_MS));

    const result = yield* Fiber.join(fiber);

    expect(result).toEqual({
      content: [`tack: tool "monitor_stall" timed out after ${DEFAULT_TIMEOUT_MS} ms`],
      isError: true,
    });
  }),
);

it.effect("aborts the handler's signal when the timeout fires", () =>
  Effect.gen(function* () {
    let stopped = false;

    const slow = tool({
      name: "monitor_slow",
      description: "Stop when asked",
      input: { type: "object", properties: {} },
      run: (_input, handler) => {
        handler.signal?.addEventListener(
          "abort",
          () => {
            stopped = true;
          },
          { once: true },
        );

        return Promise.race([]);
      },
    });

    const compiled = oneOf(yield* compile({ monitor_slow: slow }));

    const fiber = yield* invokeTool(compiled, { input: {} }, ctx).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.millis(DEFAULT_TIMEOUT_MS));

    const result = yield* Fiber.join(fiber);

    expect(result).toEqual({
      content: [`tack: tool "monitor_slow" timed out after ${DEFAULT_TIMEOUT_MS} ms`],
      isError: true,
    });
    expect(stopped).toBe(true);
  }),
);

it.effect("passes the transport's stop to the handler's signal", () =>
  Effect.gen(function* () {
    const transport = transportStop();
    const started = Promise.withResolvers<void>();
    const notified = Promise.withResolvers<void>();
    let stopped = false;

    const stop = (): void => {
      stopped = true;
      notified.resolve();
    };

    const slow = tool({
      name: "monitor_stopped",
      description: "Stop when the call stops",
      input: { type: "object", properties: {} },
      run: (_input, handler) => {
        const signal = handler.signal;

        if (signal?.aborted === true) {
          stop();
        } else {
          signal?.addEventListener("abort", stop, { once: true });
        }

        started.resolve();

        return Promise.race([]);
      },
    });

    const compiled = oneOf(yield* compile({ monitor_stopped: slow }));

    const fiber = yield* invokeTool(
      compiled,
      { input: {} },
      { ...ctx, signal: transport.signal },
    ).pipe(Effect.forkChild);

    // Wait for the handler to install its listener before stopping the call.
    yield* Effect.promise(() => started.promise);
    yield* Effect.sync(() => transport.abort());
    yield* Effect.promise(() => notified.promise);

    expect(stopped).toBe(true);

    // The handler never settles on its own, so the call still ends at tack's bound.
    yield* TestClock.adjust(Duration.millis(DEFAULT_TIMEOUT_MS));

    const result = yield* Fiber.join(fiber);

    expect(result).toEqual({
      content: [`tack: tool "monitor_stopped" timed out after ${DEFAULT_TIMEOUT_MS} ms`],
      isError: true,
    });
  }),
);

it.effect("refuses a result over the size limit instead of truncating it", () =>
  Effect.gen(function* () {
    const size = MAX_RESULT_BYTES + 1;

    const big = tool({
      name: "monitor_big",
      description: "Answer with too much",
      input: { type: "object", properties: {} },
      run: () => ({ content: ["x".repeat(size)] }),
    });

    const compiled = oneOf(yield* compile({ monitor_big: big }));

    const result = yield* invokeTool(compiled, { input: {} }, ctx);

    expect(result).toEqual({
      content: [
        `tack: tool "monitor_big" returned ${size} bytes of content, over the ${MAX_RESULT_BYTES}-byte limit`,
      ],
      isError: true,
    });
  }),
);

it.effect("installs the declared tools in one native registration", () =>
  Effect.gen(function* () {
    const fake = fakePort();
    const compiled = yield* compile({ monitor_create: monitorCreate });

    registry(fake, compiled);

    expect(fake.installs).toHaveLength(1);
    expect(fake.installs[0]?.map((item) => item.name)).toEqual(["monitor_create"]);
  }),
);

it.effect("adds a tool after load and withdraws it through its handle", () =>
  Effect.sync(() => {
    const fake = fakePort();

    const extra = tool({
      name: "monitor_extra",
      description: "Watch one more issue",
      input: { type: "object", properties: {} },
      run: () => ({ content: ["watching"] }),
    });

    const tools = registry(fake, []);
    const handle = tools.add(extra);

    expect(fake.installs).toHaveLength(1);
    expect(tools.get("monitor_extra")?.description).toBe("Watch one more issue");

    handle.dispose();

    expect(fake.withdrawn).toEqual(["monitor_extra"]);
    expect(tools.get("monitor_extra")).toBeUndefined();
  }),
);

it.effect("removes a tool by name and forgets it", () =>
  Effect.gen(function* () {
    const fake = fakePort();
    const compiled = yield* compile({ monitor_create: monitorCreate });
    const tools = registry(fake, compiled);

    tools.remove("monitor_create");
    tools.remove("monitor_create");

    expect(fake.withdrawn).toEqual(["monitor_create"]);
    expect(tools.get("monitor_create")).toBeUndefined();
  }),
);

it.effect("refuses a name the agent's own tools hold", () =>
  Effect.gen(function* () {
    const fake = fakePort();
    const compiled = yield* compile({ monitor_create: monitorCreate });

    const failure = thrownBy(() =>
      registry(fake, compiled, [{ name: "monitor_create", source: "the agent's own tools" }]),
    );

    expect(failure).toBeInstanceOf(DuplicateTool);
    expect(failure?.message).toBe(
      'tack: two tools named "monitor_create" are registered in opencode:["/work",null] (the agent\'s own tools and /plugins/monitor/index.js); give them different names.',
    );
    expect(fake.installs).toEqual([]);
  }),
);

it.effect("refuses a name another plugin already registered", () =>
  Effect.sync(() => {
    const fake = fakePort();

    const extra = tool({
      name: "monitor_extra",
      description: "Watch one more issue",
      input: { type: "object", properties: {} },
      run: () => ({ content: ["watching"] }),
    });

    const tools = registry(fake, [], [{ name: "monitor_extra", source: 'plugin "other"' }]);

    const failure = thrownBy(() => tools.add(extra));

    expect(failure).toBeInstanceOf(DuplicateTool);
    expect(failure?.message).toContain('plugin "other"');
  }),
);

it.effect("refuses a tool added twice under one name", () =>
  Effect.sync(() => {
    const fake = fakePort();
    const tools = registry(fake, []);

    tools.add(monitorCreate);

    const failure = thrownBy(() => tools.add(monitorCreate));

    expect(failure).toBeInstanceOf(DuplicateTool);
    expect(fake.installs).toHaveLength(1);
  }),
);

it.effect("refuses to add a session tool where there is no session", () =>
  Effect.sync(() => {
    const fake = fakePort();
    const tools = registry(fake, [], [], false);

    const failure = thrownBy(() => tools.add(tool({ ...monitorCreate, needsSession: true })));

    expect(failure).toBeInstanceOf(InvalidTool);
  }),
);

it.effect("withdraws every tool when the registry is disposed", () =>
  Effect.gen(function* () {
    const fake = fakePort();
    const compiled = yield* compile({ monitor_create: monitorCreate });
    const tools = registry(fake, compiled);

    tools.dispose();

    expect(fake.withdrawn).toEqual(["monitor_create"]);
  }),
);
