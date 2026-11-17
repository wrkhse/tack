import { clearTimeout, setTimeout } from "node:timers";

import { createAgentPlugin } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

export const NAME = "interrupt-action";

const DELAY_MS = 300;

/** Interrupts the first turn from a timer, with no hook deciding it. */
export const interruptAction = createAgentPlugin(() => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    name: NAME,

    sessionCreated: ({ session }) => {
      // The interrupt has to land with no hook deciding it, so it is scheduled
      // on the host's timer rather than an Effect fiber the agent would own.
      // @effect-diagnostics globalTimers:off
      timer = setTimeout(() => {
        void session
          .interrupt()
          .then((outcome) => markHere(NAME, { event: "interrupt", outcome: outcome.status }));
      }, DELAY_MS);
    },

    sessionEnded: () => {
      if (timer !== undefined) clearTimeout(timer);

      timer = undefined;
    },
  };
});
