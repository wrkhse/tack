import { expect, it } from "@effect/vitest";
import { Effect, Predicate, type Scope } from "effect";
import type {
  CallToolResult,
  ClientOptions,
  JSONRPCMessage,
  Transport,
} from "@modelcontextprotocol/client";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import type { AgentPlugin } from "../src/create.ts";
import { createAgentPlugin } from "../src/create.ts";
import { serveMcpOn } from "../src/mcp/serve.ts";
import type { ToolDefinition } from "../src/tools/tool.ts";
import { MAX_RESULT_BYTES, tool } from "../src/tools/tool.ts";

const MODERN: ClientOptions = { versionNegotiation: { mode: { pin: "2026-07-28" } } };

const LEGACY: ClientOptions = {
  versionNegotiation: { mode: "legacy" },
  supportedProtocolVersions: ["2025-11-25"],
};

const HEADER = {
  type: "object",
  properties: { key: { type: "string" } },
  required: ["key"],
  additionalProperties: false,
};

const DESCRIPTION = "Start watching a Jira issue";
const TIMEOUT_MS = 20;
const BIG = MAX_RESULT_BYTES + 1;

/** The actual messages sent on one side of an SDK transport pair. */
interface Recording {
  readonly transport: Transport;
  readonly sent: Array<JSONRPCMessage>;
}

function recording(inner: Transport): Recording {
  const sent: Array<JSONRPCMessage> = [];

  const outer: Transport = {
    start: () => inner.start(),
    send: (message, options) => {
      sent.push(message);

      return inner.send(message, options);
    },
    close: () => inner.close(),
  };

  const callbacks: Pick<Transport, "onmessage" | "onerror" | "onclose"> = {
    onmessage: (message, extra) => outer.onmessage?.(message, extra),
    onerror: (error) => outer.onerror?.(error),
    onclose: () => outer.onclose?.(),
  };

  Object.assign(inner, callbacks);

  return { transport: outer, sent };
}

function pluginWith(definitions: ReadonlyArray<ToolDefinition>): AgentPlugin<void> {
  return createAgentPlugin(() => ({
    name: "monitor",
    tools: Object.fromEntries(definitions.map((definition) => [definition.name, definition])),
  }));
}

const monitorCreate = tool<{ key: string }>({
  name: "monitor_create",
  description: DESCRIPTION,
  input: HEADER,
  run: (input) => ({ content: [`watching ${input.key}`], details: { id: "m-1" } }),
});

/** The waiting handler reports both events; no sleep decides when to cancel. */
interface Signals {
  readonly started: PromiseWithResolvers<void>;
  readonly stopped: PromiseWithResolvers<void>;
}

function toolsFor(signals: Signals): ReadonlyArray<ToolDefinition> {
  return [
    monitorCreate,
    tool({
      name: "monitor_throw",
      description: "Throw instead of answering",
      input: { type: "object", properties: {} },
      run: () => {
        throw new Error("boom");
      },
    }),
    tool({
      name: "monitor_stall",
      description: "Never answer",
      input: { type: "object", properties: {} },
      timeoutMs: TIMEOUT_MS,
      run: () => Promise.race([]),
    }),
    tool({
      name: "monitor_big",
      description: "Answer with too much",
      input: { type: "object", properties: {} },
      run: () => ({ content: ["x".repeat(BIG)] }),
    }),
    tool({
      name: "monitor_wait",
      description: "Wait until the call stops",
      input: { type: "object", properties: {} },
      run: (_input, ctx) => {
        signals.started.resolve();
        ctx.signal?.addEventListener("abort", () => signals.stopped.resolve(), { once: true });

        return Promise.race([]);
      },
    }),
  ];
}

interface Served {
  readonly client: Client;
  readonly server: Recording;
  readonly clientSide: Recording;
  readonly serving: Promise<void>;
}

/** Owns both ends before connecting, including when the connect fails. */
const connect = Effect.fnUntraced(function* (
  plugin: AgentPlugin<void>,
  options: ClientOptions,
): Effect.fn.Return<Served, never, Scope.Scope> {
  const served = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const clientSide = recording(clientTransport);
      const server = recording(serverTransport);
      const client = new Client({ name: "tack-test", version: "1.0.0" }, options);
      const serving = serveMcpOn(plugin, server.transport, { timeoutMs: 5_000 });

      return { client, server, clientSide, serving };
    }),
    (active) =>
      Effect.promise(() =>
        active.client
          .close()
          .then(() => active.clientSide.transport.close())
          .then(() => active.serving),
      ),
  );

  yield* Effect.promise(() => served.client.connect(served.clientSide.transport));

  return served;
});

const withServed = Effect.fnUntraced(function* (
  plugin: AgentPlugin<void>,
  options: ClientOptions,
  use: (served: Served) => Effect.Effect<void>,
) {
  const served = yield* connect(plugin, options);

  yield* use(served);
}, Effect.scoped);

function textOf(result: CallToolResult): string {
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function methodOf(message: JSONRPCMessage): string | undefined {
  return "method" in message ? message.method : undefined;
}

function idOf(message: JSONRPCMessage): string | number | undefined {
  return "id" in message ? message.id : undefined;
}

function responseIdOf(message: JSONRPCMessage): string | number | undefined {
  return "method" in message ? undefined : idOf(message);
}

const checkList = Effect.fnUntraced(function* (served: Served) {
  const { tools } = yield* Effect.promise(() => served.client.listTools());
  const found = tools.find((candidate) => candidate.name === "monitor_create");

  expect(found?.description).toBe(DESCRIPTION);
  expect(found?.inputSchema).toEqual(HEADER);
});

const checkCalls = Effect.fnUntraced(function* (served: Served) {
  const called = yield* Effect.promise(() =>
    served.client.callTool({ name: "monitor_create", arguments: { key: "PROJ-1" } }),
  );

  expect(textOf(called)).toBe("watching PROJ-1");
  expect(called.isError).toBeUndefined();
  expect(called.structuredContent).toBeUndefined();

  const refused = yield* Effect.promise(() =>
    served.client.callTool({ name: "monitor_create", arguments: {} }),
  );

  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toBe(
    'tack: tool "monitor_create" rejected its input: Missing key\n  at ["key"]',
  );

  const thrown = yield* Effect.promise(() =>
    served.client.callTool({ name: "monitor_throw", arguments: {} }),
  );

  expect(thrown.isError).toBe(true);
  expect(textOf(thrown)).toBe('tack: tool "monitor_throw" failed: boom');
});

const checkLimits = Effect.fnUntraced(function* (served: Served) {
  const stalled = yield* Effect.promise(() =>
    served.client.callTool({ name: "monitor_stall", arguments: {} }),
  );

  expect(stalled.isError).toBe(true);
  expect(textOf(stalled)).toBe(`tack: tool "monitor_stall" timed out after ${TIMEOUT_MS} ms`);

  const big = yield* Effect.promise(() =>
    served.client.callTool({ name: "monitor_big", arguments: {} }),
  );

  expect(big.isError).toBe(true);
  expect(textOf(big)).toBe(
    `tack: tool "monitor_big" returned ${BIG} bytes of content, over the ${MAX_RESULT_BYTES}-byte limit`,
  );
});

const checkCancel = Effect.fnUntraced(function* (served: Served, signals: Signals) {
  const controller = yield* Effect.sync(() => new AbortController());

  const call = served.client.callTool(
    { name: "monitor_wait", arguments: {} },
    { signal: controller.signal },
  );

  // Observe rejection before cancellation, so no rejected promise goes unhandled.
  const rejected = expect(call).rejects.toThrow();

  yield* Effect.promise(() => signals.started.promise);
  controller.abort();

  yield* Effect.promise(() => rejected);
  yield* Effect.promise(() => signals.stopped.promise);

  const request = served.clientSide.sent.findLast((message) => methodOf(message) === "tools/call");

  const requestId = request === undefined ? undefined : idOf(request);

  expect(requestId).toBeDefined();

  // Keep the channel alive through another completed request after cancellation.
  yield* Effect.promise(() => served.client.listTools());

  const answers = served.server.sent.filter(
    (message) => requestId !== undefined && responseIdOf(message) === requestId,
  );

  expect(answers).toEqual([]);
});

/** A per-request version error names only revisions usable with a modern envelope. */
const checkUnsupported = Effect.fnUntraced(function* () {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = recording(serverTransport);

  const client = new Client(
    { name: "unsupported", version: "1.0.0" },
    {
      versionNegotiation: { mode: { pin: "2099-01-01" } },
      supportedProtocolVersions: ["2099-01-01"],
    },
  );

  const serving = serveMcpOn(pluginWith([]), server.transport);

  yield* Effect.promise(() => expect(client.connect(clientTransport)).rejects.toThrow()).pipe(
    Effect.ensuring(
      Effect.promise(() =>
        client
          .close()
          .then(() => clientTransport.close())
          .then(() => serving),
      ),
    ),
  );

  const errors = server.sent.flatMap((message) =>
    "error" in message ? [{ code: message.error.code, data: message.error.data }] : [],
  );

  expect(errors).toEqual([
    {
      code: -32022,
      data: { supported: ["2026-07-28"], requested: "2099-01-01" },
    },
  ]);
});

/** The era and the initialize answer one handshake owes. */
function checkEra(served: Served, era: "modern" | "legacy"): void {
  expect(served.client.getProtocolEra()).toBe(era);

  const initializes = served.clientSide.sent.filter(
    (message) => methodOf(message) === "initialize",
  );

  if (era === "modern") {
    expect(initializes).toEqual([]);
    expect(served.client.getDiscoverResult()?.supportedVersions).toEqual(["2026-07-28"]);

    return;
  }

  expect(initializes).toHaveLength(1);

  const answered = served.server.sent.flatMap((message) => {
    if (!("result" in message) || !Predicate.isObject(message.result)) return [];

    const version = message.result["protocolVersion"];

    return Predicate.isString(version) ? [version] : [];
  });

  expect(answered).toEqual(["2025-11-25"]);
}

const HANDSHAKES: ReadonlyArray<{
  readonly name: string;
  readonly era: "modern" | "legacy";
  readonly options: ClientOptions;
}> = [
  { name: "2026-07-28", era: "modern", options: MODERN },
  { name: "2025-11-25", era: "legacy", options: LEGACY },
];

for (const handshake of HANDSHAKES) {
  it.live(`serves a ${handshake.name} client`, () =>
    Effect.gen(function* () {
      const signals: Signals = {
        started: Promise.withResolvers<void>(),
        stopped: Promise.withResolvers<void>(),
      };

      yield* withServed(pluginWith(toolsFor(signals)), handshake.options, (served) =>
        Effect.gen(function* () {
          checkEra(served, handshake.era);
          yield* checkList(served);

          if (handshake.era === "modern") {
            yield* checkUnsupported();
          }

          yield* checkCalls(served);
          yield* checkLimits(served);
          yield* checkCancel(served, signals);
        }),
      );
    }),
  );
}

interface Changes {
  readonly next: () => Promise<void>;
}

/** One notification per change; no polling or unbounded notification queue. */
function changesOf(client: Client): Changes {
  let pending = Promise.withResolvers<void>();

  client.setNotificationHandler("notifications/tools/list_changed", () => {
    pending.resolve();

    return Promise.resolve();
  });

  return {
    next: () =>
      pending.promise.then(() => {
        pending = Promise.withResolvers<void>();
      }),
  };
}

const checkChanges = Effect.fnUntraced(function* (served: Served, changes: Changes) {
  const added = yield* Effect.promise(() =>
    served.client.callTool({ name: "monitor_add", arguments: {} }),
  );

  expect(textOf(added)).toBe("added");
  yield* Effect.promise(() => changes.next());

  const grown = yield* Effect.promise(() => served.client.listTools());

  expect(grown.tools.map((candidate) => candidate.name)).toEqual([
    "monitor_create",
    "monitor_add",
    "monitor_remove",
    "monitor_extra",
  ]);

  const removed = yield* Effect.promise(() =>
    served.client.callTool({ name: "monitor_remove", arguments: {} }),
  );

  expect(textOf(removed)).toBe("removed");
  yield* Effect.promise(() => changes.next());

  const shrunk = yield* Effect.promise(() => served.client.listTools());

  expect(shrunk.tools.map((candidate) => candidate.name)).toEqual([
    "monitor_add",
    "monitor_remove",
    "monitor_extra",
  ]);

  const called = yield* Effect.promise(() =>
    served.client.callTool({ name: "monitor_create", arguments: {} }),
  );

  expect(called.isError).toBe(true);
  expect(textOf(called)).toBe('tack: no tool named "monitor_create"');
});

function changingPlugin(): AgentPlugin<void> {
  return pluginWith([
    monitorCreate,
    tool({
      name: "monitor_add",
      description: "Add one more tool",
      input: { type: "object", properties: {} },
      run: (_input, ctx) => {
        ctx.tools.add(
          tool({
            name: "monitor_extra",
            description: "Watch one more issue",
            input: { type: "object", properties: {} },
            run: () => ({ content: ["watching extra"] }),
          }),
        );

        return { content: ["added"] };
      },
    }),
    tool({
      name: "monitor_remove",
      description: "Withdraw the monitor",
      input: { type: "object", properties: {} },
      run: (_input, ctx) => {
        ctx.tools.remove("monitor_create");

        return { content: ["removed"] };
      },
    }),
  ]);
}

it.live("notifies a legacy connection when the tool set changes", () =>
  withServed(changingPlugin(), LEGACY, (served) => checkChanges(served, changesOf(served.client))),
);

it.live("notifies a modern subscription when the tool set changes", () =>
  withServed(changingPlugin(), MODERN, (served) =>
    Effect.gen(function* () {
      const changes = changesOf(served.client);

      const subscription = yield* Effect.acquireRelease(
        Effect.promise(() => served.client.listen({ toolsListChanged: true })),
        (active) => Effect.promise(() => active.close()),
      );

      expect(subscription.honoredFilter).toEqual({ toolsListChanged: true });

      yield* checkChanges(served, changes);
    }).pipe(Effect.scoped),
  ),
);

it.live("resolves after the transport closes", () =>
  withServed(pluginWith([monitorCreate]), MODERN, (served) =>
    Effect.gen(function* () {
      expect(served.client.getProtocolEra()).toBe("modern");

      yield* Effect.promise(() => served.client.close());
      yield* Effect.promise(() => served.serving);
    }),
  ),
);

it.live("refuses a needsSession tool at start, naming it", () =>
  Effect.gen(function* () {
    const plugin = pluginWith([
      tool({
        name: "monitor_session",
        description: "Needs the agent's session",
        input: { type: "object", properties: {} },
        needsSession: true,
        run: () => ({ content: ["never"] }),
      }),
    ]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    yield* Effect.promise(() =>
      expect(serveMcpOn(plugin, serverTransport)).rejects.toThrow('tool "monitor_session"'),
    ).pipe(Effect.ensuring(Effect.promise(() => clientTransport.close())));
  }),
);

it.live("rejects a factory that throws, with its message", () =>
  Effect.gen(function* () {
    const plugin = createAgentPlugin(() => {
      throw new Error("tack: factory exploded");
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    yield* Effect.promise(() =>
      expect(serveMcpOn(plugin, serverTransport)).rejects.toThrow("tack: factory exploded"),
    ).pipe(Effect.ensuring(Effect.promise(() => clientTransport.close())));
  }),
);

/** Speaks the opening before a Client owns the channel, with no timing guess. */
const opening = Effect.fnUntraced(function* (transport: Transport, request: JSONRPCMessage) {
  const received = Promise.withResolvers<JSONRPCMessage>();
  const prior = transport.onmessage;

  Object.assign(transport, {
    onmessage: (message: JSONRPCMessage) => received.resolve(message),
  });

  return yield* Effect.promise(() => transport.send(request).then(() => received.promise)).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        Object.assign(transport, { onmessage: prior });
      }),
    ),
  );
});

it.live("runs the plugin factory once with mcp metadata across a probe and legacy fallback", () =>
  Effect.gen(function* () {
    let factories = 0;

    const plugin = createAgentPlugin((_options, meta) => {
      factories += 1;

      return {
        name: "factory-count",
        tools: {
          factory_count: tool({
            name: "factory_count",
            description: "Report this process's factory runs",
            input: { type: "object", properties: {} },
            run: () => ({ content: [JSON.stringify({ factories, agent: meta.agent })] }),
          }),
        },
      };
    });

    const [wire, server] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fallback", version: "1.0.0" }, LEGACY);
    const serving = serveMcpOn(plugin, server);

    const run = Effect.gen(function* () {
      yield* opening(wire, {
        jsonrpc: "2.0",
        id: "probe",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "probe", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      });

      yield* Effect.promise(() => client.connect(wire));

      const called = yield* Effect.promise(() =>
        client.callTool({ name: "factory_count", arguments: {} }),
      );

      expect(client.getProtocolEra()).toBe("legacy");
      expect(textOf(called)).toBe('{"factories":1,"agent":"mcp"}');
    });

    yield* run.pipe(
      Effect.ensuring(
        Effect.promise(() =>
          client
            .close()
            .then(() => wire.close())
            .then(() => serving),
        ),
      ),
    );
  }),
);

it.live("serves a claim-less first request with legacy semantics", () =>
  Effect.gen(function* () {
    const [wire, server] = InMemoryTransport.createLinkedPair();
    const serving = serveMcpOn(pluginWith([monitorCreate]), server);

    const response = yield* opening(wire, {
      jsonrpc: "2.0",
      id: "no-claim",
      method: "tools/list",
    }).pipe(Effect.ensuring(Effect.promise(() => wire.close().then(() => serving))));

    expect("result" in response ? response.result : response).toEqual({
      tools: [
        {
          name: "monitor_create",
          description: DESCRIPTION,
          inputSchema: HEADER,
        },
      ],
    });
  }),
);
