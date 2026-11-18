import {
  Server,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
  type McpServerFactory,
  type ServerContext,
  type Transport,
} from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { Effect } from "effect";

import type { AgentPlugin } from "../create.ts";
import type { ResolvedPlugin } from "../plugin.ts";
import type { ToolPort, ToolRegistry } from "../tools/registry.ts";
import { createToolRegistry } from "../tools/registry.ts";
import type { CompiledTool, ToolCallResult, ToolContext } from "../tools/tool.ts";
import { DEFAULT_TIMEOUT_MS, invokeTool } from "../tools/tool.ts";

/**
 * How the generated server names itself. The package is private and carries
 * no version, so the version is the one npm gives an unpublished package.
 */
const SERVER = { name: "tack", version: "0.0.0" };

/** What a caller may set on the stdio entry. */
export interface McpOptions {
  /**
   * The longest one handler may run, in milliseconds; defaults to
   * {@link DEFAULT_TIMEOUT_MS}. A tool's own smaller `timeoutMs` still wins.
   */
  readonly timeoutMs?: number;
}

/** The server's ceiling on one call, or the load error that value is. */
function timeoutOf(options: McpOptions): number {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("tack: serveMcp timeoutMs must be a positive integer");
  }

  return timeoutMs;
}

/** One tool with the server's ceiling applied; a tool's own smaller limit still wins. */
function bounded(tool: CompiledTool, ceiling: number): CompiledTool {
  return tool.timeoutMs <= ceiling ? tool : { ...tool, timeoutMs: ceiling };
}

/** tack's result in MCP's shape: one text block per entry, and the error flag. */
function textResult(result: ToolCallResult): CallToolResult {
  const content = result.content.map((text) => ({ type: "text" as const, text }));

  return result.isError === true ? { content, isError: true } : { content };
}

/** An error result the model reads, with one message. */
function failed(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** The input schema MCP describes: the header, with its root known to be an object. */
type McpInputSchema = ListToolsResult["tools"][number]["inputSchema"];

/** Refuses a header MCP cannot describe: its input schema root must be an object. */
function refuseNonObject(tool: CompiledTool): void {
  if (tool.input["type"] !== "object") {
    throw new Error(`tack: tool "${tool.name}" has an input header whose root is not an object`);
  }
}

/**
 * The tool's header in MCP's shape. The copy states the object root MCP
 * requires without changing any key the header carries.
 */
function mcpInput(tool: CompiledTool): McpInputSchema {
  refuseNonObject(tool);

  return { ...tool.input, type: "object" };
}

/**
 * Every tool the server holds, as the client describes them. `inputSchema` is
 * the tool's header unchanged, and `details` is never sent: MCP carries
 * structured output only for a tool that declares an `outputSchema`.
 */
function describeTools(tools: ToolRegistry): ListToolsResult["tools"] {
  return tools.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: mcpInput(tool),
  }));
}

/** Runs one call in the server process, with no session and no channel to the agent. */
function callTool(
  tools: ToolRegistry,
  params: CallToolRequest["params"],
  context: ServerContext,
  ceiling: number,
): Promise<CallToolResult> {
  const tool = tools.get(params.name);

  if (tool === undefined) {
    return Promise.resolve(failed(`tack: no tool named "${params.name}"`));
  }

  const ctx: ToolContext = {
    callId: String(context.mcpReq.id),
    signal: context.mcpReq.signal,
    session: undefined,
    tools,
  };

  return Effect.runPromise(
    invokeTool(bounded(tool, ceiling), { input: params.arguments }, ctx),
  ).then(textResult);
}

/**
 * One server instance for one connection. Its handlers read the registry on
 * every request, so a new instance speaks the current tool set without
 * re-running the plugin factory; `onclose` leaves the live set so a change
 * notifies only the connections still open.
 */
function buildServer(tools: ToolRegistry, live: Set<Server>, ceiling: number): Server {
  const server = new Server(SERVER, { capabilities: { tools: { listChanged: true } } });

  server.setRequestHandler("tools/list", () => ({ tools: describeTools(tools) }));

  server.setRequestHandler("tools/call", (request, context) =>
    callTool(tools, request.params, context, ceiling),
  );

  Object.assign(server, {
    onclose: () => {
      live.delete(server);
    },
  });

  live.add(server);

  return server;
}

/**
 * The registry over the resolved plugin's tools. A change waits for the
 * registry to finish updating before it notifies, so a client that answers the
 * notification with `tools/list` reads the set the change produced.
 */
function registryFor(plugin: ResolvedPlugin, changed: () => void): ToolRegistry {
  const port: ToolPort = {
    install: () => {
      queueMicrotask(changed);
    },
    withdraw: () => {
      queueMicrotask(changed);
    },
    settled: () => Promise.resolve(),
  };

  return createToolRegistry(
    {
      plugin: plugin.name,
      scope: "mcp",
      source: "the generated MCP server",
      hasSession: false,
      port,
    },
    plugin.tools,
  );
}

/**
 * A transport that reports its own close after the entry's handler runs. The
 * entry owns the transport and overwrites its `onclose`, so the wrapper is the
 * one place that observes the end of stdin without taking that handler away.
 */
function observing(inner: Transport, closed: () => void): Transport {
  const outer: Transport = {
    start: () => inner.start(),
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
  };

  const callbacks: Pick<Transport, "onmessage" | "onerror" | "onclose"> = {
    onmessage: (message, extra) => outer.onmessage?.(message, extra),
    onerror: (error) => outer.onerror?.(error),
    onclose: () => {
      outer.onclose?.();
      closed();
    },
  };

  Object.assign(inner, callbacks);

  return outer;
}

/**
 * Serves the resolved plugin's tools over one transport, both protocol eras,
 * and resolves when the transport closes. The plugin factory runs once, before
 * the transport starts, so a broken factory or a refused definition rejects
 * here rather than on the wire.
 *
 * The SDK may call the server factory twice on stdio: once for a discarded
 * `server/discover` probe, then once for the legacy connection a fallback
 * opening needs. The plugin factory stays outside that callback for exactly
 * that reason: the second call would run every plugin again.
 */
export function serveMcpOn(
  plugin: AgentPlugin<void>,
  transport: Transport,
  options: McpOptions = {},
): Promise<void> {
  try {
    const resolved = plugin.mcp();
    const ceiling = timeoutOf(options);

    for (const tool of resolved.tools) {
      refuseNonObject(tool);
    }

    const live = new Set<Server>();
    const closed = Promise.withResolvers<void>();

    const tools = registryFor(resolved, () => {
      for (const server of live) {
        void server.sendToolListChanged().catch(() => undefined);
      }
    });

    const factory: McpServerFactory = () => buildServer(tools, live, ceiling);

    const serving = serveStdio(factory, {
      legacy: "serve",
      transport: observing(transport, () => closed.resolve()),
      onerror: (error) => {
        process.stderr.write(error.message + "\n");
      },
    });

    return closed.promise.finally(() => serving.close());
  } catch (cause) {
    return Promise.reject(cause);
  }
}

/**
 * Serves the resolved plugin's tools over MCP stdio: the entry a generated
 * `mcp.js` runs. Reads and writes stdio only, opens no listener, and resolves
 * once the harness closes stdin so the process can exit 0.
 */
export function serveMcp(plugin: AgentPlugin<void>, options: McpOptions = {}): Promise<void> {
  return serveMcpOn(plugin, new StdioServerTransport(), options);
}
