// Codex starts this as its "tack" MCP server over stdio, one JSON-RPC
// message per line. It offers only guard_status and asks tack-hook for each
// call; arguments are checked before tack-hook runs.

const MCP_PROTOCOL_VERSION = __TACK_MCP_PROTOCOL_VERSION__;
const SERVER_VERSION = __TACK_VERSION__;
const STATUS = "guard_status: daemon ok";
const MAX_IN_FLIGHT = 4;

const TOOL = {
  name: "guard_status",
  description: "Reports whether the tack daemon is running",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

function toolError(reason) {
  return {
    content: [{ type: "text", text: "tack: " + reason }],
    isError: true,
  };
}

function emptyArguments(args) {
  if (args === undefined) return true;

  return (
    args !== null &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    Object.keys(args).length === 0
  );
}

function createServer(write) {
  let sequence = 0;
  let inFlight = 0;

  function reply(id, result) {
    write({ jsonrpc: "2.0", id, result });
  }

  function fail(id, code, message) {
    write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function guardStatus(args) {
    if (!emptyArguments(args)) return toolError("malformed");
    if (inFlight >= MAX_IN_FLIGHT) return toolError("limit");

    inFlight += 1;
    sequence = (sequence % Number.MAX_SAFE_INTEGER) + 1;

    const id = sequence;
    const deadline = startDeadline(BUDGET_MS);

    try {
      const result = await forward(
        {
          kind: "tool",
          id,
          version: PROTOCOL_VERSION,
          name: "guard_status",
          input: {},
        },
        deadline,
      );

      if (!result.ok) return toolError(result.reason);

      const content = result.reply.content;
      const item =
        Array.isArray(content) && content.length === 1 ? content[0] : null;

      if (item?.kind !== "text" || item.text !== STATUS) {
        return toolError("malformed_reply");
      }

      record("guard_status", id);

      return { content: [{ type: "text", text: item.text }] };
    } catch {
      return toolError("daemon_error");
    } finally {
      deadline.clear();
      inFlight -= 1;
    }
  }

  async function handle(message) {
    const valid =
      message !== null &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      message.jsonrpc === "2.0" &&
      typeof message.method === "string";

    if (!valid) {
      fail(null, -32600, "invalid request");
      return;
    }

    const { id, method, params } = message;

    // A notification, such as notifications/initialized, takes no reply.
    if (id === undefined) return;

    if (method === "initialize") {
      reply(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "tack", version: SERVER_VERSION },
      });
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/list") {
      reply(id, { tools: [TOOL] });
    } else if (method === "tools/call") {
      if (params?.name === TOOL.name)
        reply(id, await guardStatus(params.arguments));
      else fail(id, -32602, "unknown tool");
    } else {
      fail(id, -32601, "method not found");
    }
  }

  return { handle };
}

function parseLine(bytes) {
  try {
    return {
      ok: true,
      message: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ),
    };
  } catch {
    return { ok: false };
  }
}

// Split stdin into lines of at most MAX_FRAME_BYTES; a longer line is
// dropped whole and answered with a parse error.
function serve(stdin, write) {
  const server = createServer(write);
  let pieces = [];
  let size = 0;
  let oversized = false;

  function parseError() {
    write({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
  }

  function line() {
    const bytes = oversized ? null : Buffer.concat(pieces, size);

    if (bytes === null) {
      parseError();
    } else if (bytes.toString("utf8").trim() !== "") {
      const parsed = parseLine(bytes);

      if (parsed.ok) server.handle(parsed.message).catch(() => {});
      else parseError();
    }

    pieces = [];
    size = 0;
    oversized = false;
  }

  stdin.on("data", (chunk) => {
    let start = 0;

    while (start <= chunk.length) {
      const end = chunk.indexOf(10, start);
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end);

      size += piece.length;
      if (size > MAX_FRAME_BYTES) {
        oversized = true;
        pieces = [];
      } else if (!oversized) {
        pieces.push(piece);
      }

      if (end === -1) return;

      line();
      start = end + 1;
    }
  });
}

serve(process.stdin, (message) => {
  process.stdout.write(JSON.stringify(message) + "\n");
});
