import { createAgentPlugin } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

export const NAME = "model-switch";

const MODEL = { providerID: "fake", id: "scripted-2" };

/** Switches the session's model at its start and records each finished turn. */
export const modelSwitch = createAgentPlugin(() => ({
  name: NAME,

  sessionCreated: ({ session }) =>
    session
      .setModel(MODEL)
      .then((outcome) => markHere(NAME, { event: "switch", outcome: outcome.status }))
      .catch((cause: Error) => markHere(NAME, { event: "switch", error: String(cause) })),

  responseFinished: (response) => {
    markHere(NAME, { event: "turn", reason: response.reason });
  },
}));
