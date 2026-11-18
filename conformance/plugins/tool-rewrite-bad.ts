import { createAgentPlugin } from "../../src/index.ts";

/** Rewrites the monitor tool's input to one its header cannot admit. */
export const toolRewriteBad = createAgentPlugin(() => ({
  name: "tool-rewrite-bad",

  toolBefore: (call) =>
    call.name === "monitor_create" ? { rewrite: { input: { key: 42 } } } : undefined,
}));
