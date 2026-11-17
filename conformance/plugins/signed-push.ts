import { createAgentPlugin } from "../../src/index.ts";

/** Adds a signature to a push after the dry-run rewrite. */
export const signedPush = createAgentPlugin(() => ({
  name: "signed-push",
  priority: 20,

  toolBefore: (call) =>
    call.tool === "shell" && call.input.command.startsWith("git push")
      ? { rewrite: { command: call.input.command + " --signed" } }
      : undefined,
}));
