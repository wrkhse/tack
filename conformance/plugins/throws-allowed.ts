import { createAgentPlugin } from "../../src/index.ts";

/** Throws from toolBefore for shell calls, but opts into allow, so the call goes on. */
export const throwingAllowedGuard = createAgentPlugin(() => ({
  name: "throws-allowed",
  onError: { toolBefore: "allow" },

  toolBefore: (call) => {
    if (call.tool !== "shell") return;

    throw new Error("tack-conformance: boom");
  },
}));
