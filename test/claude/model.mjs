// A loopback Anthropic Messages stand-in for the Claude Code conformance run.
// It streams the scripted turns the safe-push fixture needs, records every
// request as one JSON line, and prints its port. CI / disposable container only.
//
// Usage: node model.mjs [request-log.jsonl]

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const MAX_REQUESTS = 80;
// Claude Code sends its whole system prompt and every tool schema each turn.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
// Outlives run.mjs's 90 s Claude Code bound with a margin, so CI never stops
// the stand-in before the session finishes.
const LIFETIME_MS = 120_000;

const SHELL_TOOL = "Bash";
const STATUS_TOOL = "mcp__tack__guard_status";
const PUSH_INPUT = { command: "git push origin main" };

const requestLog = process.argv[2] ?? null;

let handled = 0;
let toolUses = 0;

function textReply(text) {
  return { block: { type: "text", text }, stopReason: "end_turn" };
}

function toolUseReply(name, input) {
  toolUses += 1;

  return {
    block: { type: "tool_use", id: "toolu_scripted_" + toolUses, name, input },
    stopReason: "tool_use",
  };
}

function toolNames(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools
    .map((tool) => tool?.name)
    .filter((name) => typeof name === "string");
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function toolResults(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const results = [];

  for (const message of messages) {
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;

    for (const block of message.content) {
      if (block?.type !== "tool_result") continue;

      results.push({
        id: block.tool_use_id,
        isError: block.is_error === true,
        text: resultText(block.content),
      });
    }
  }

  return results;
}

// The main loop is the request that offers Bash; side requests (titles,
// summaries) get plain text. Each tool_result moves the script one turn on.
function replyFor(body) {
  if (!toolNames(body).includes(SHELL_TOOL)) return textReply("ok");

  const results = toolResults(body);

  if (results.length === 0) return toolUseReply(SHELL_TOOL, PUSH_INPUT);
  if (results.length === 1) return toolUseReply(STATUS_TOOL, {});

  return textReply("done");
}

function messageHead(model) {
  return {
    id: "msg_scripted_" + handled,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function sse(type, data) {
  return (
    "event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n"
  );
}

function streamBody(model, reply) {
  const { block, stopReason } = reply;
  const isText = block.type === "text";

  const start = isText
    ? { type: "text", text: "" }
    : { type: "tool_use", id: block.id, name: block.name, input: {} };
  const delta = isText
    ? { type: "text_delta", text: block.text }
    : { type: "input_json_delta", partial_json: JSON.stringify(block.input) };

  return (
    sse("message_start", { message: messageHead(model) }) +
    sse("content_block_start", { index: 0, content_block: start }) +
    sse("content_block_delta", { index: 0, delta }) +
    sse("content_block_stop", { index: 0 }) +
    sse("message_delta", {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    sse("message_stop", {})
  );
}

function record(entry) {
  if (!requestLog) return;

  try {
    appendFileSync(requestLog, JSON.stringify(entry) + "\n");
  } catch (error) {
    console.error("model: cannot record a request: " + error.message);
  }
}

function apiError(message) {
  return { type: "error", error: { type: "invalid_request_error", message } };
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendMessage(response, body) {
  const model = typeof body.model === "string" ? body.model : "scripted";
  const reply = replyFor(body);

  if (body.stream !== true) {
    sendJson(response, 200, {
      ...messageHead(model),
      content: [reply.block],
      stop_reason: reply.stopReason,
    });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.end(streamBody(model, reply));
}

function readBody(request, response, onBody) {
  const chunks = [];
  let size = 0;
  let rejected = false;

  request.on("data", (piece) => {
    if (rejected) return;

    size += piece.length;

    if (size > MAX_BODY_BYTES) {
      rejected = true;
      sendJson(response, 413, apiError("body too large"));
      request.destroy();
      return;
    }

    chunks.push(piece);
  });

  request.on("error", () => {});

  request.on("end", () => {
    if (rejected) return;

    try {
      onBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      sendJson(response, 400, apiError("unreadable body"));
    }
  });
}

function handle(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = request.method + " " + url.pathname;

  if (handled >= MAX_REQUESTS) {
    sendJson(response, 429, apiError("too many requests"));
    return;
  }

  handled += 1;

  if (route === "POST /v1/messages/count_tokens") {
    readBody(request, response, (body) => {
      record({ route, model: body.model, tools: toolNames(body) });
      sendJson(response, 200, { input_tokens: 1 });
    });
    return;
  }

  if (route === "POST /v1/messages") {
    readBody(request, response, (body) => {
      record({
        route,
        query: url.search,
        model: body.model,
        stream: body.stream === true,
        tools: toolNames(body),
        toolResults: toolResults(body),
      });
      sendMessage(response, body);
    });
    return;
  }

  // A reachability probe is answered; anything else is recorded and refused.
  record({ route, query: url.search });

  if (request.method === "GET" || request.method === "HEAD") {
    sendJson(response, 200, {});
    return;
  }

  sendJson(response, 404, apiError("not found"));
}

const server = createServer(handle);

server.listen(0, "127.0.0.1", () => {
  const address = server.address();

  if (!address || typeof address === "string") {
    console.error("model: no listening address");
    process.exit(1);
  }

  process.stdout.write(String(address.port) + "\n");
});

server.on("error", (error) => {
  console.error("model: " + error.message);
  process.exit(1);
});

const lifetime = setTimeout(() => {
  server.close();
  process.exit(0);
}, LIFETIME_MS);
lifetime.unref();
