import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Effect, Schema, type Scope } from "effect";

/** The shell tool's name: OpenCode calls it shell, Pi calls it bash. */
export type ShellTool = "shell" | "bash";

const ChatMessageSchema = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.Unknown),
});

const ChatRequestSchema = Schema.Struct({
  model: Schema.optional(Schema.String),
  messages: Schema.Array(ChatMessageSchema),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
});

const AddressInfoSchema = Schema.Struct({
  address: Schema.String,
  family: Schema.String,
  port: Schema.Finite,
});

export type ChatRequest = typeof ChatRequestSchema.Type;

const isChatRequest = Schema.is(ChatRequestSchema);
const isAddressInfo = Schema.is(AddressInfoSchema);

/** The marker a compaction request carries when a scenario does not name one. */
const DEFAULT_COMPACTION_MARKER = "tack-conformance: summarize this session";

/** The short text a compaction request is answered with. */
const SCRIPTED_SUMMARY = "summary";

/** The one tool call a scripted turn makes. */
export interface ScriptedCall {
  readonly name: string;
  readonly input: Schema.Json;
}

/** The message in the SSE error a scripted failure answers with. */
const SCRIPTED_ERROR = "tack-conformance: scripted request failure";

/** How the stand-in answers, and how long it waits before doing so. */
export interface StandInOptions {
  /**
   * Fails tool-bearing requests with an SSE error. `next` fails one, so the
   * agent's retry can succeed; `always` fails each until `failNext(false)`
   * clears it or the run ends, so a retry cannot rescue the turn. The run is
   * bounded by `MAX_REQUESTS`; absent arms nothing.
   */
  readonly failMode?: "next" | "always";
  /**
   * The text that marks a compaction request. A scenario puts it in the text
   * its plugin's `session.compact()` triggers, so the model can tell that
   * request from a title or a tool turn.
   */
  readonly compactionMarker?: string;
  /**
   * Delays the response that follows a tool result, so a scenario can append
   * mid-turn. A test aid, bounded to `MAX_POST_TOOL_DELAY_MS`; default 0.
   */
  readonly postToolDelayMs?: number;
  /** The tool a scripted turn calls; absent means the agent's own shell tool. */
  readonly call?: ScriptedCall;
}

/** A local OpenAI-compatible model that scripts every turn the suite needs. */
export interface StandIn {
  /** The OpenAI-compatible base URL, ending in `/v1`. */
  readonly baseUrl: string;
  /** Every request body the server parsed, in arrival order. */
  readonly requests: Effect.Effect<ReadonlyArray<ChatRequest>>;
  /** Arms the failure mode, or clears it with `false`. */
  readonly failNext: (armed?: boolean) => Effect.Effect<void>;
}

interface ModelState {
  handled: number;
  toolTurns: number;
  /** Whether a tool-bearing request fails now; `failMode` says one or every one. */
  failing: boolean;
  readonly failMode: "next" | "always";
  readonly compactionMarker: string;
  readonly postToolDelayMs: number;
  readonly call: ScriptedCall | undefined;
  readonly requests: Array<ChatRequest>;
}

interface ToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly type?: "function";
  readonly function: { readonly name?: string; readonly arguments?: string };
}

interface ChunkDelta {
  readonly role?: "assistant";
  readonly content?: string | null;
  readonly tool_calls?: ReadonlyArray<ToolCallDelta>;
}

type FinishReason = "tool_calls" | "stop" | null;

/** The command the scripted model asks the agent to run. */
const SCRIPTED_COMMAND = "git push origin main";

const MAX_REQUESTS = 50;
const MAX_BODY_BYTES = 1024 * 1024;

/** The longest post-tool delay a scenario may ask for, and the window it keeps a turn open. */
export const MAX_POST_TOOL_DELAY_MS = 5_000;
const CHUNK_HEAD = { id: "c1", object: "chat.completion.chunk", created: 0, model: "scripted" };
const DONE_LINE = "data: [DONE]\n\n";

/** Clamps the test-aid delay to a bound a scenario cannot exceed. */
const boundedDelay = (delayMs: number | undefined): number =>
  Math.min(Math.max(delayMs ?? 0, 0), MAX_POST_TOOL_DELAY_MS);

const chunkLine = (delta: ChunkDelta, finishReason: FinishReason): string =>
  "data: " +
  JSON.stringify({ ...CHUNK_HEAD, choices: [{ index: 0, delta, finish_reason: finishReason }] }) +
  "\n\n";

const usageLine = (): string =>
  "data: " +
  JSON.stringify({
    ...CHUNK_HEAD,
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1 },
  }) +
  "\n\n";

const textTurn = (text: string): ReadonlyArray<string> => [
  chunkLine({ role: "assistant", content: text }, null),
  chunkLine({}, "stop"),
  usageLine(),
  DONE_LINE,
];

/** A streaming error, which both agents report as a failed model request. */
const errorTurn = (): ReadonlyArray<string> => [
  "data: " +
    JSON.stringify({
      error: { message: SCRIPTED_ERROR, type: "server_error", code: "scripted" },
    }) +
    "\n\n",
  DONE_LINE,
];

/** The default scripted turn: the agent's own shell tool, running a push. */
const shellCall = (tool: ShellTool): ScriptedCall => ({
  name: tool,
  input: { command: SCRIPTED_COMMAND },
});

const toolCallTurn = (call: ScriptedCall, turn: number): ReadonlyArray<string> => {
  const opening: ChunkDelta = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        index: 0,
        id: "call_" + turn,
        type: "function",
        function: { name: call.name, arguments: "" },
      },
    ],
  };

  const input: ChunkDelta = {
    tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call.input) } }],
  };

  return [
    chunkLine(opening, null),
    chunkLine(input, null),
    chunkLine({}, "tool_calls"),
    usageLine(),
    DONE_LINE,
  ];
};

/** What one request is answered with, and how long the server waits first. */
interface Turn {
  readonly lines: ReadonlyArray<string>;
  readonly delayMs: number;
}

const isToolBearing = (request: ChatRequest): boolean => (request.tools ?? []).length > 0;

/**
 * A compaction request is the one whose last message carries the configured
 * marker, compared without case because each agent words its own summary
 * prompt. Every other request is classified by its tools and roles: a title
 * request has no tools, a finished turn carries a tool result, and anything
 * else gets one tool call.
 */
export const isCompactionRequest = (request: ChatRequest, marker: string): boolean => {
  const last = request.messages[request.messages.length - 1];

  if (last === undefined) return false;

  return JSON.stringify(last.content ?? "")
    .toLowerCase()
    .includes(marker.toLowerCase());
};

const turnFor = (state: ModelState, request: ChatRequest, tool: ShellTool): Turn => {
  if (isToolBearing(request) && state.failing) {
    if (state.failMode === "next") state.failing = false;

    return { lines: errorTurn(), delayMs: 0 };
  }

  if (isCompactionRequest(request, state.compactionMarker)) {
    return { lines: textTurn(SCRIPTED_SUMMARY), delayMs: 0 };
  }

  if ((request.tools ?? []).length === 0) {
    return { lines: textTurn("title"), delayMs: 0 };
  }

  if (request.messages.some((message) => message.role === "tool")) {
    return { lines: textTurn("done"), delayMs: state.postToolDelayMs };
  }

  state.toolTurns += 1;

  return { lines: toolCallTurn(state.call ?? shellCall(tool), state.toolTurns), delayMs: 0 };
};

const parseChatRequest = (text: string): ChatRequest | null => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  return isChatRequest(parsed) ? parsed : null;
};

const respond = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
};

const streamTurn = (response: ServerResponse, lines: ReadonlyArray<string>): void => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  for (const line of lines) response.write(line);

  response.end();
};

/** Waits out a test-aid delay, then streams the turn if the client is still there. */
const respondTo = (
  state: ModelState,
  tool: ShellTool,
  body: ChatRequest,
  response: ServerResponse,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const turn = turnFor(state, body, tool);

    if (turn.delayMs > 0) yield* Effect.sleep(turn.delayMs);

    yield* Effect.sync(() => {
      if (response.writableEnded || response.destroyed) return;

      streamTurn(response, turn.lines);
    });
  });

const collectBody = (
  request: IncomingMessage,
  response: ServerResponse,
  onBody: (text: string) => void,
): void => {
  const chunks: Array<Buffer> = [];
  let size = 0;
  let rejected = false;

  request.on("data", (chunk: Buffer) => {
    if (rejected) return;

    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      rejected = true;
      respond(response, 413, "tack-conformance: request body too large");
      request.destroy();

      return;
    }

    chunks.push(chunk);
  });

  request.on("end", () => {
    if (rejected) return;

    onBody(Buffer.concat(chunks).toString("utf8"));
  });
};

const handleRequest = (
  state: ModelState,
  tool: ShellTool,
  request: IncomingMessage,
  response: ServerResponse,
): void => {
  state.handled += 1;

  if (state.handled > MAX_REQUESTS) {
    respond(response, 429, "tack-conformance: too many model requests");

    return;
  }

  if (!(request.url ?? "").endsWith("/chat/completions")) {
    respond(response, 404, "tack-conformance: unexpected path");

    return;
  }

  collectBody(request, response, (text) => {
    const body = parseChatRequest(text);

    if (body === null) {
      respond(response, 400, "tack-conformance: unreadable request body");

      return;
    }

    state.requests.push(body);
    Effect.runFork(respondTo(state, tool, body, response));
  });
};

const portOf = (server: Server): number => {
  const address = server.address();

  if (address === null || !isAddressInfo(address)) {
    throw new Error("tack-conformance: the stand-in model has no address");
  }

  return address.port;
};

const startServer = (state: ModelState, tool: ShellTool): Effect.Effect<Server> =>
  Effect.callback<Server>((resume, signal) => {
    const server = createServer((request, response) =>
      handleRequest(state, tool, request, response),
    );

    server.once("error", (cause) => resume(Effect.die(cause)));
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    signal.addEventListener("abort", () => server.close(), { once: true });

    return Effect.sync(() => {
      if (server.listening) server.close();
    });
  });

const stopServer = (server: Server): Effect.Effect<void> =>
  Effect.sync(() => {
    if (server.listening) server.close();
  });

const standIn = (state: ModelState, port: number): StandIn => ({
  baseUrl: "http://127.0.0.1:" + port + "/v1",
  requests: Effect.sync(() => [...state.requests]),
  failNext: (armed = true) =>
    Effect.sync(() => {
      state.failing = armed;
    }),
});

/**
 * Starts the scripted model on an ephemeral loopback port. The server closes
 * when the surrounding scope closes.
 */
export const standInModel = (
  tool: ShellTool,
  options: StandInOptions = {},
): Effect.Effect<StandIn, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state: ModelState = {
      handled: 0,
      toolTurns: 0,
      failing: options.failMode !== undefined,
      failMode: options.failMode ?? "next",
      compactionMarker: options.compactionMarker ?? DEFAULT_COMPACTION_MARKER,
      postToolDelayMs: boundedDelay(options.postToolDelayMs),
      call: options.call,
      requests: [],
    };

    const server = yield* Effect.acquireRelease(startServer(state, tool), stopServer);
    const port = yield* Effect.sync(() => portOf(server));

    return standIn(state, port);
  });
