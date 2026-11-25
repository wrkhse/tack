// Loopback Chat Completions stand-in for the Pi conformance sessions.
// It prints its port as one line; no model request leaves this machine.

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const MAX_REQUESTS = 12;
const MAX_BODY_BYTES = 1024 * 1024;
// Outlives the runner's session and model-start bounds combined.
const LIFETIME_MS = 60_000;

const BASH = { name: "bash", input: { command: "git push origin main" } };
// The harmless command tack allows; its output comes back as the bash result.
const HARMLESS = { name: "bash", input: { command: "git status --short" } };
const STATUS = { name: "guard_status", input: {} };
const scripts = new Map([
  ["normal", [BASH, STATUS]],
  ["bash", [BASH]],
  ["harmless", [HARMLESS]],
  ["invalid-tool", [{ name: STATUS.name, input: { unexpected: true } }]],
]);

const script = scripts.get(process.argv[2] ?? "normal");
const requestLog = process.argv[3];
if (!script) throw new Error("unknown model script: " + process.argv[2]);

let handled = 0;

function chunk(delta, finishReason = null) {
  return sse({ choices: [{ index: 0, delta, finish_reason: finishReason }] });
}

function sse(fields) {
  return "data: " + JSON.stringify({
    id: "chatcmpl-tack-pi-" + handled,
    object: "chat.completion.chunk",
    created: 0,
    model: "scripted",
    ...fields,
  }) + "\n\n";
}

function toolCallTurn({ name, input }) {
  const start = chunk({
    role: "assistant",
    content: null,
    tool_calls: [
      { index: 0, id: "call_" + name, type: "function", function: { name, arguments: "" } },
    ],
  });
  const args = chunk({
    tool_calls: [{ index: 0, function: { arguments: JSON.stringify(input) } }],
  });

  return start + args + chunk({}, "tool_calls");
}

// A Chat Completions tool message carries a string or an array of text parts.
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function replyFor(body) {
  if (body?.model !== "scripted" || body.stream !== true || !Array.isArray(body.messages)) {
    throw new Error("expected a streaming request to the scripted model");
  }

  const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name) : [];
  const results = body.messages.filter((message) => message?.role === "tool");
  const resultIds = results.map((result) => result.tool_call_id);
  // What the model saw of each tool result, keyed by call id.
  const outputs = Object.fromEntries(results.map((result) =>
    [result.tool_call_id, textOf(result.content)]));

  if (requestLog) {
    appendFileSync(requestLog, JSON.stringify({ tools, resultIds, outputs }) + "\n");
  }

  if (results.length > script.length ||
      resultIds.some((id, index) => id !== "call_" + script[index].name)) {
    throw new Error("unexpected tool result sequence: " + JSON.stringify(resultIds));
  }

  const turn = script[results.length];
  if (turn && !tools.includes(turn.name)) throw new Error("missing tool: " + turn.name);

  const reply = turn ? toolCallTurn(turn) : chunk({ role: "assistant", content: "done" }) + chunk({}, "stop");
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

  return reply + sse({ choices: [], usage }) + "data: [DONE]\n\n";
}

function sendError(response, status, message) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

function handle(request, response) {
  handled += 1;
  if (handled > MAX_REQUESTS) return sendError(response, 429, "too many requests");
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
    return sendError(response, 404, "not found");
  }

  const chunks = [];
  let size = 0;
  let rejected = false;

  request.on("data", (piece) => {
    if (rejected) return;

    size += piece.length;

    if (size > MAX_BODY_BYTES) {
      rejected = true;
      sendError(response, 413, "request body too large");
      request.destroy();
      return;
    }

    chunks.push(piece);
  });
  request.on("error", () => {});

  request.on("end", () => {
    if (rejected) return;

    let reply;

    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      reply = replyFor(body);
    } catch (error) {
      sendError(response, 400, error.message);
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.end(reply);
  });
}

const server = createServer({ headersTimeout: 5_000, requestTimeout: 10_000 }, handle);

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("model has no listening address");

  process.stdout.write(String(address.port) + "\n");
});

setTimeout(() => {
  server.close();
  server.closeAllConnections();
}, LIFETIME_MS).unref();
