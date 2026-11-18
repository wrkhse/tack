import { createAgentPlugin } from "../../../src/index.ts";
import { appendAndMark } from "./append.ts";

export const NAME = "append-now";

const NOW = "tack-conformance: now";

/** Appends a steer while the shell call's turn is still running. */
export const appendNow = createAgentPlugin(() => ({
  name: NAME,

  toolAfter: (call, _result, ctx) => {
    if (call.tool !== "shell") return;

    appendAndMark(NAME, ctx.session, NOW, "now");
  },
}));
