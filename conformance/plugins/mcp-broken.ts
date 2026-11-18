import { createAgentPlugin, tool } from "../../src/index.ts";

/** A plugin the MCP entry must refuse: its tool needs the agent's session. */
export const mcpBroken = createAgentPlugin(() => ({
  name: "mcp-broken",
  tools: {
    monitor_session: tool({
      name: "monitor_session",
      description: "Needs the agent's session",
      input: { type: "object", properties: {} },
      needsSession: true,
      run: () => ({ content: ["never"] }),
    }),
  },
}));
