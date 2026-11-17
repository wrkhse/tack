import { createAgentPlugin } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

export const NAME = "append-next";

const NEXT = "tack-conformance: next";

/** Appends a queued message, held until the running turn ends. */
export const appendNext = createAgentPlugin(() => ({
  name: NAME,

  toolAfter: (call, _result, ctx) => {
    if (call.tool !== "shell") return;

    void ctx.session
      .append(NEXT, { when: "next" })
      .then((outcome) => markHere(NAME, { event: "append", outcome: outcome.status }));
  },
}));
