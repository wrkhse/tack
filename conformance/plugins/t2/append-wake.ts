import { createAgentPlugin } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

export const NAME = "append-wake";

const WAKE = "tack-conformance: wake";

/**
 * Appends once, when the first model request finishes, so an idle session is
 * woken. A second append would wake the turn it just started, forever.
 */
export const appendWake = createAgentPlugin(() => {
  let appended = false;

  return {
    name: NAME,

    responseFinished: (response, ctx) => {
      if (response.reason !== "done" || appended) return;

      appended = true;

      void ctx.session
        .append(WAKE, { when: "wake" })
        .then((outcome) => markHere(NAME, { event: "append", outcome: outcome.status }));
    },
  };
});
