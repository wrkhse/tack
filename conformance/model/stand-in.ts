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

/** A local OpenAI-compatible model that scripts one shell call. */
export interface StandIn {
  /** The OpenAI-compatible base URL, ending in `/v1`. */
  readonly baseUrl: string;
  /** Every request body the server parsed, in arrival order. */
  readonly requests: Effect.Effect<ReadonlyArray<ChatRequest>>;
}

interface ModelState {
  handled: number;
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
const CHUNK_HEAD = { id: "c1", object: "chat.completion.chunk", created: 0, model: "scripted" };
const DONE_LINE = "data: [DONE]\n\n";

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

const toolCallTurn = (tool: ShellTool): ReadonlyArray<string> => {
  const opening: ChunkDelta = {
    role: "assistant",
    content: null,
    tool_calls: [
      { index: 0, id: "call_1", type: "function", function: { name: tool, arguments: "" } },
    ],
  };

  const command: ChunkDelta = {
    tool_calls: [
      { index: 0, function: { arguments: JSON.stringify({ command: SCRIPTED_COMMAND }) } },
    ],
  };

  return [
    chunkLine(opening, null),
    chunkLine(command, null),
    chunkLine({}, "tool_calls"),
    usageLine(),
    DONE_LINE,
  ];
};

const turnFor = (request: ChatRequest, tool: ShellTool): ReadonlyArray<string> => {
  const tools = request.tools ?? [];

  if (tools.length === 0) return textTurn("title");

  if (request.messages.some((message) => message.role === "tool")) return textTurn("done");

  return toolCallTurn(tool);
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
    streamTurn(response, turnFor(body, tool));
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
});

/**
 * Starts the scripted model on an ephemeral loopback port. The server closes
 * when the surrounding scope closes.
 */
export const standInModel = (tool: ShellTool): Effect.Effect<StandIn, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state: ModelState = { handled: 0, requests: [] };

    const server = yield* Effect.acquireRelease(startServer(state, tool), stopServer);
    const port = yield* Effect.sync(() => portOf(server));

    return standIn(state, port);
  });
