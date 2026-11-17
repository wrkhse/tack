import { createAgentPlugin } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

export const NAME = "idle-note";

/** Records every sessionIdle tack reports. */
export const idleNote = createAgentPlugin(() => ({
  name: NAME,

  sessionIdle: () => {
    markHere(NAME, { event: "idle" });
  },
}));
