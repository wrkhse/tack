import { createAgentPlugin } from "../../src/index.ts";

/** Rewrites a push into a dry run. */
export const safePush = createAgentPlugin(() => ({
  name: "safe-push",
  priority: 10,

  toolBefore: (call) =>
    call.tool === "shell" && call.input.command.startsWith("git push")
      ? { rewrite: { command: call.input.command + " --dry-run" } }
      : undefined,
}));
