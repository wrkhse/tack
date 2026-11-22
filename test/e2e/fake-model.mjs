// A local OpenAI-compatible Chat Completions stand-in for the e2e run.
// It scripts the few turns the safe-push fixture needs and prints its port.
// CI / disposable container only.

import { createServer } from "node:http";

const MAX_REQUESTS = 50;
const MAX_BODY_BYTES = 1024 * 1024;
const LIFETIME_MS = 20_000;

const CHUNK_HEAD = {
  id: "chatcmpl-e2e",
  object: "chat.completion.chunk",
  created: 0,
  model: "fake",
};
const DONE_LINE = "data: [DONE]\n\n";

let handled = 0;
let toolTurn = 0;

function chunk(delta, finishReason = null) {
  return (
    "data: " +
    JSON.stringify({
      ...CHUNK_HEAD,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }) +
    "\n\n"
  );
}

function usageLine() {
  return (
    "data: " +
    JSON.stringify({
      ...CHUNK_HEAD,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1 },
    }) +
    "\n\n"
  );
}

function textTurn(text) {
  return chunk({ role: "assistant", content: text }) + chunk({}, "stop") + usageLine() + DONE_LINE;
}

function toolCallTurn(name, input) {
  toolTurn += 1;
  const id = "call_" + toolTurn;

  return (
    chunk({
      role: "assistant",
      content: null,
      tool_calls: [
        { index: 0, id, type: "function", function: { name, arguments: "" } },
      ],
    }) +
    chunk({
      tool_calls: [{ index: 0, function: { arguments: JSON.stringify(input) } }],
    }) +
    chunk({}, "tool_calls") +
    usageLine() +
    DONE_LINE
  );
}

function toolName(request, candidates) {
  const tools = Array.isArray(request.tools) ? request.tools : [];

  for (const candidate of candidates) {
    const match = tools.find((tool) => (tool?.function?.name ?? tool?.name) === candidate);
    if (match) return match.function?.name ?? match.name;
  }

  return candidates[0];
}

function replyFor(request) {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const messages = Array.isArray(request.messages) ? request.messages : [];

  if (tools.length === 0) return textTurn("title");

  const results = messages.filter((message) => message?.role === "tool");

  if (results.length === 0) {
    return toolCallTurn(toolName(request, ["shell", "bash"]), {
      command: "git push origin main",
    });
  }

  if (results.length === 1) {
    return toolCallTurn(toolName(request, ["guard_status"]), {});
  }

  return textTurn("done");
}

function respondWithError(response, status, message) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

function handle(request, response) {
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
    respondWithError(response, 404, "not found");
    return;
  }

  if (handled >= MAX_REQUESTS) {
    respondWithError(response, 429, "too many requests");
    return;
  }

  const chunks = [];
  let size = 0;
  let rejected = false;

  request.on("data", (piece) => {
    if (rejected) return;

    size += piece.length;

    if (size > MAX_BODY_BYTES) {
      rejected = true;
      respondWithError(response, 413, "request body too large");
      request.destroy();
      return;
    }

    chunks.push(piece);
  });

  request.on("error", () => {});

  request.on("end", () => {
    if (rejected) return;

    handled += 1;

    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      respondWithError(response, 400, "unreadable request body");
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(replyFor(body));
    response.end();
  });
}

const server = createServer(handle);

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    console.error("fake-model: no listening address");
    process.exit(1);
  }
  process.stdout.write(String(address.port) + "\n");
});

server.on("error", (error) => {
  console.error("fake-model: " + error.message);
  process.exit(1);
});

const lifetime = setTimeout(() => {
  server.close();
  process.exit(0);
}, LIFETIME_MS);
lifetime.unref();
