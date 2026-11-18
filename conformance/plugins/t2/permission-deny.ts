import { createAgentPlugin } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

export const NAME = "permission-deny";

const DENY = "tack-conformance: permission denied";

/**
 * Registers a marker at load, so a run where the hook never runs still shows
 * the plugin loaded, and denies every request it is asked about.
 */
export const permissionDeny = createAgentPlugin(() => {
  markHere(NAME, { event: "registered" });

  return {
    name: NAME,

    permissionAsked: (request) => {
      markHere(NAME, {
        event: "asked",
        action: request.action,
        resources: request.resources.join(" "),
      });

      return { deny: DENY };
    },
  };
});
