import { createAgentPlugin } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

export const NAME = "lifecycle-note";

/** Records the session's start and its end. */
export const lifecycleNote = createAgentPlugin(() => ({
  name: NAME,

  sessionCreated: ({ resumed }) => {
    markHere(NAME, { event: "created", resumed });
  },

  sessionEnded: ({ reason }) => {
    markHere(NAME, { event: "ended", reason });
  },
}));
