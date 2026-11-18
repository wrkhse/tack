import { createAgentPlugin } from "../../src/index.ts";
import { monitorCreate } from "./tool-create.ts";

/**
 * The plugin the MCP entry serves. Its one handler is tool-create's, so the
 * git recorder proves the call ran in the server process.
 */
export const mcpMonitor = createAgentPlugin(() => ({
  name: "mcp-monitor",
  tools: { monitor_create: monitorCreate },
}));
