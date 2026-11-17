import { createAgentPlugin } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

export const NAME = "compact-action";

/** Asks for compaction when the first model request ends. */
export const compactAction = createAgentPlugin(() => {
  let compacted = false;

  return {
    name: NAME,

    responseFinished: (_response, ctx) => {
      if (compacted) return;

      compacted = true;

      void ctx.session
        .compact()
        .then((outcome) => markHere(NAME, { event: "compact", outcome: outcome.status }));
    },
  };
});
