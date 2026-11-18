import { execFileSync } from "node:child_process";

import { createAgentPlugin, tool } from "../../src/index.ts";

/**
 * A tool whose handler records its own call through the git shim, so the
 * recorder proves the handler ran inside the agent rather than merely that a
 * result arrived.
 */
const monitorCreate = tool<{ key: string }>({
  name: "monitor_create",
  description: "Start watching a Jira issue",
  input: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
  run: (input) => {
    execFileSync("git", ["tack-tool", "monitor_create", input.key], { stdio: "ignore" });

    return { content: [`watching ${input.key}`] };
  },
});

export const toolCreate = createAgentPlugin(() => ({
  name: "tool-create",
  tools: { monitor_create: monitorCreate },
}));
