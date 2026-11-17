import { createAgentPlugin } from "../../src/index.ts";

/** Appends a note to every prompt the agent sends. */
export const pushNote = createAgentPlugin(() => ({
  name: "push-note",

  promptSent: () => ({ append: "tack-conformance-note: dry runs only." }),
}));
