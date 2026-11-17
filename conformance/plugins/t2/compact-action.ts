import { createAgentPlugin } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

export const NAME = "compact-action";

/**
 * Asks for compaction once the session has a turn to summarize. Pi summarizes
 * the entries before the newest user-message span and refuses when there are
 * none, so the prompt count, not the response count, is what triggers it.
 */
export const compactAction = createAgentPlugin(() => {
  let prompts = 0;
  let compacted = false;

  return {
    name: NAME,

    promptSent: () => {
      prompts += 1;
    },

    responseFinished: (_response, ctx) => {
      if (prompts < 2 || compacted) return;

      compacted = true;

      void ctx.session
        .compact()
        .then((outcome) => markHere(NAME, { event: "compact", outcome: outcome.status }));
    },
  };
});
