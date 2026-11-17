import { createAgentPlugin } from "../../src/index.ts";

/** Denies every shell call that starts a push. */
export const denyPush = createAgentPlugin(() => ({
  name: "deny-push",

  toolBefore: (call) =>
    call.tool === "shell" && call.input.command.startsWith("git push")
      ? { deny: "tack-conformance: push denied" }
      : undefined,
}));
