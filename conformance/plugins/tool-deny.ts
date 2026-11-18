import { createAgentPlugin } from "../../src/index.ts";

/** The reason the model must receive when the tool is denied. */
export const DENY_REASON = "tack-conformance: monitor denied";

/** Denies every call to the monitor tool before its handler runs. */
export const toolDeny = createAgentPlugin(() => ({
  name: "tool-deny",

  toolBefore: (call) => (call.name === "monitor_create" ? { deny: DENY_REASON } : undefined),
}));
