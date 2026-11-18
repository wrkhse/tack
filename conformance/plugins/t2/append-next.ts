import { createAgentPlugin } from "../../../src/index.ts";
import { appendAndMark } from "./append.ts";

export const NAME = "append-next";

const NEXT = "tack-conformance: next";

/** Appends a queued message, held until the running turn ends. */
export const appendNext = createAgentPlugin(() => ({
  name: NAME,

  toolAfter: (call, _result, ctx) => {
    if (call.tool !== "shell") return;

    appendAndMark(NAME, ctx.session, NEXT, "next");
  },
}));
