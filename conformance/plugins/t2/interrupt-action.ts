import { clearTimeout, setTimeout } from "node:timers";

import { createAgentPlugin } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

export const NAME = "interrupt-action";

const DELAY_MS = 300;

/**
 * Interrupts the first turn from a timer, with no hook deciding it. The timer
 * is armed by the prompt, so the turn it interrupts is already running; armed
 * at session start it could fire before the prompt ever reached the agent.
 */
export const interruptAction = createAgentPlugin(() => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    name: NAME,

    promptSent: (_event, ctx) => {
      if (timer !== undefined) clearTimeout(timer);

      // The interrupt has to land with no hook deciding it, so it is scheduled
      // on the host's timer rather than an Effect fiber the agent would own.
      // @effect-diagnostics globalTimers:off
      timer = setTimeout(() => {
        void ctx.session
          .interrupt()
          .then((outcome) => markHere(NAME, { event: "interrupt", outcome: outcome.status }))
          .catch((cause: Error) => markHere(NAME, { event: "interrupt", error: String(cause) }));
      }, DELAY_MS);
    },

    sessionEnded: () => {
      if (timer !== undefined) clearTimeout(timer);

      timer = undefined;
    },
  };
});
