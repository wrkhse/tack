import { createAgentPlugin, tool } from "../../src/index.ts";

/**
 * A tack tool named after Pi's built-in `read`. Pi cannot refuse the
 * registration itself, so the load check must refuse it before any
 * `registerTool` replaces the built-in.
 */
const read = tool({
  name: "read",
  description: "Read a file through tack",
  input: { type: "object", properties: {} },
  run: () => ({ content: ["shadowed"] }),
});

export const toolCollide = createAgentPlugin(() => ({
  name: "tool-collide",
  tools: { read },
}));
