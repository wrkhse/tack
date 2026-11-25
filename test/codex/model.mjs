// Loopback Responses API stand-in for the Codex conformance sessions.
// It prints its port as one line; no model request leaves this machine.
// argv: <script> <request log>

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import zlib from "node:zlib";

const MAX_REQUESTS = 20;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
// Outlives the runner's session and model-start bounds combined.
const LIFETIME_MS = 150_000;
const PUSH = "git push origin main";
const HARMLESS = "git status --short";

const BASH = { kind: "bash", callId: "call_bash", command: PUSH };
const STATUS = { kind: "status", callId: "call_status", input: {} };
const scripts = new Map([
  ["normal", [BASH, STATUS]],
  ["bash", [BASH]],
  ["harmless", [{ ...BASH, command: HARMLESS }]],
  ["invalid-tool", [{ ...STATUS, input: { unexpected: true } }]],
]);

const script = scripts.get(process.argv[2] ?? "normal");
const requestLog = process.argv[3];
if (!script) throw new Error("unknown model script: " + process.argv[2]);

let handled = 0;

function log(entry) {
  if (requestLog) appendFileSync(requestLog, JSON.stringify(entry) + "\n");
}

function textOf(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";

  return output.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

// Top-level tool names, and namespace children as "<namespace>.<name>".
function toolNames(tools) {
  const names = [];

  for (const tool of tools) {
    const name = tool?.name ?? tool?.type;
    if (typeof name !== "string") continue;

    names.push(name);

    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const child of tool.tools) names.push(name + "." + child?.name);
    }
  }

  return names;
}

// guard_status as a namespace child or a top-level function, in the offered
// tools or in a tool_search_output from an earlier turn.
function findStatus(tools, input) {
  const searched = input.filter((item) => item?.type === "tool_search_output")
    .flatMap((item) => (Array.isArray(item.tools) ? item.tools : []));

  for (const tool of [...tools, ...searched]) {
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
      const child = tool.tools.find((entry) => entry?.name === "guard_status");
      if (child) return { namespace: tool.name, name: "guard_status" };
    }

    if (tool?.type === "function" && /(^|__)guard_status$/.test(tool.name ?? "")) {
      return { name: tool.name };
    }
  }

  return undefined;
}

function bashCall(names, command) {
  if (names.includes("exec_command")) {
    return { name: "exec_command", arguments: { cmd: command } };
  }

  if (names.includes("shell_command")) {
    return { name: "shell_command", arguments: { command } };
  }

  if (names.includes("shell")) {
    return { name: "shell", arguments: { command: ["bash", "-lc", command] } };
  }

  throw new Error("no shell tool offered: " + JSON.stringify(names));
}

function statusTurn(step, tools, input, outputs, names) {
  const status = findStatus(tools, input);

  if (status) {
    return {
      type: "function_call",
      call_id: step.callId,
      ...status,
      arguments: JSON.stringify(step.input),
    };
  }

  if (names.includes("tool_search") && !("call_search" in outputs)) {
    return {
      type: "tool_search_call",
      call_id: "call_search",
      execution: "client",
      arguments: { query: "guard_status", limit: 8 },
    };
  }

  throw new Error("guard_status is not offered: " + JSON.stringify(names));
}

function nextItem(tools, input, outputs) {
  const names = toolNames(tools);

  for (const step of script) {
    if (step.callId in outputs) continue;

    if (step.kind === "bash") {
      const call = bashCall(names, step.command);
      return {
        type: "function_call",
        call_id: step.callId,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      };
    }

    return statusTurn(step, tools, input, outputs, names);
  }

  return {
    type: "message",
    role: "assistant",
    id: "msg_done_" + handled,
    content: [{ type: "output_text", text: "done" }],
  };
}

function outputsOf(input) {
  const outputs = {};

  for (const item of input) {
    if (typeof item?.call_id !== "string") continue;

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      outputs[item.call_id] = textOf(item.output);
    } else if (item.type === "tool_search_output") {
      outputs[item.call_id] = JSON.stringify(item.tools ?? []);
    }
  }

  return outputs;
}

function sse(events) {
  return events.map((event) => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n")
    .join("");
}

function replyFor(body) {
  if (body?.stream !== true || !Array.isArray(body.input)) {
    throw new Error("expected a streaming Responses request");
  }

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const outputs = outputsOf(body.input);
  const item = nextItem(tools, body.input, outputs);
  const id = "resp_tack_codex_" + handled;
  const usage = { input_tokens: 1, input_tokens_details: null, output_tokens: 1,
    output_tokens_details: null, total_tokens: 2 };

  log({
    request: handled,
    at: Math.round(performance.now()),
    path: "/v1/responses",
    model: body.model,
    tools: toolNames(tools),
    outputs,
    reply: item.type === "message" ? "done" : item.call_id,
  });

  return sse([
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id, usage } },
  ]);
}

function sendError(response, status, message) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

function decode(buffer, encoding) {
  if (!encoding || encoding === "identity") return buffer;
  if (encoding === "gzip") return zlib.gunzipSync(buffer);
  if (encoding === "br") return zlib.brotliDecompressSync(buffer);
  if (encoding === "zstd" && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buffer);

  throw new Error("unsupported content-encoding: " + encoding);
}

function answer(request, response, chunks) {
  let reply;

  try {
    const raw = decode(Buffer.concat(chunks), request.headers["content-encoding"]);
    reply = replyFor(JSON.parse(raw.toString("utf8")));
  } catch (error) {
    log({ request: handled, path: request.url, error: error.message });
    sendError(response, 400, error.message);
    return;
  }

  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.end(reply);
}

function handle(request, response) {
  handled += 1;
  if (handled > MAX_REQUESTS) return sendError(response, 429, "too many requests");

  const route = (request.url ?? "").split("?")[0];
  if (request.method !== "POST" || route !== "/v1/responses") {
    log({ request: handled, method: request.method, path: request.url, status: 404 });
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
    if (!rejected) answer(request, response, chunks);
  });
}

const server = createServer({ headersTimeout: 5_000, requestTimeout: 30_000 }, handle);

// Codex falls back to HTTP when the Responses websocket is refused.
server.on("upgrade", (request, socket) => {
  log({ request: handled, method: "UPGRADE", path: request.url, status: 404 });
  socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("model has no listening address");

  process.stdout.write(String(address.port) + "\n");
});

setTimeout(() => {
  server.close();
  server.closeAllConnections();
}, LIFETIME_MS).unref();
