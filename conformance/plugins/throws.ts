import { createAgentPlugin } from "../../src/index.ts";

/** Throws from toolBefore; the default onError turns that into a deny. */
export const throwingGuard = createAgentPlugin(() => ({
  name: "throws",

  toolBefore: () => {
    throw new Error("tack-conformance: boom");
  },
}));
