import { createAgentPlugin } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

export const NAME = "finished-note";

/** Records why each finished model request ended. */
export const finishedNote = createAgentPlugin(() => ({
  name: NAME,

  responseFinished: (response) => {
    markHere(NAME, { event: "finished", reason: response.reason });
  },
}));
