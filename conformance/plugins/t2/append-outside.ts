import { clearTimeout, setTimeout } from "node:timers";

import { createAgentPlugin } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

export const NAME = "append-outside";

const OUTSIDE = "tack-conformance: outside";
const DELAY_MS = 300;

/** Appends from a timer, so no hook is running when the session is woken. */
export const appendOutside = createAgentPlugin(() => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    name: NAME,

    sessionCreated: ({ session }) => {
      // The append has to land with no hook running, so it is scheduled on the
      // host's timer rather than an Effect fiber the agent would own.
      // @effect-diagnostics globalTimers:off
      timer = setTimeout(() => {
        void session
          .append(OUTSIDE, { when: "wake" })
          .then((outcome) => markHere(NAME, { event: "append", outcome: outcome.status }));
      }, DELAY_MS);
    },

    sessionEnded: () => {
      if (timer !== undefined) clearTimeout(timer);

      timer = undefined;
    },
  };
});
