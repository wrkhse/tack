import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { markHere } from "../../harness/markers.ts";
import { markLoaded } from "../loaded.ts";
import { NAME, idleNote } from "../t2/idle-note.ts";

markLoaded(NAME);

const extension = idleNote.pi();

/**
 * tack's sessionIdle event does not carry Pi's `aborted`, so the entry records
 * the harness signal that produced the idle beside the plugin's own marker.
 */
export default (pi: ExtensionAPI) => {
  extension(pi);

  pi.on("agent_settled", (event) => {
    markHere(NAME, { event: "agent_settled", aborted: event.aborted });
  });
};
