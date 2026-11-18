import { createAgentPlugin } from "../../src/index.ts";

/** The key the rewrite puts into the call. */
export const REWRITTEN_KEY = "PROJ-2";

/** Rewrites the monitor tool's whole input to another issue. */
export const toolRewrite = createAgentPlugin(() => ({
  name: "tool-rewrite",

  toolBefore: (call) =>
    call.name === "monitor_create" ? { rewrite: { input: { key: REWRITTEN_KEY } } } : undefined,
}));
