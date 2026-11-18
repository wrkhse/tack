import { createAgentPlugin } from "../../src/index.ts";
import { markHere } from "../harness/markers.ts";
import { monitorCreate } from "./tool-create.ts";

/** The marker name this plugin writes. */
export const NAME = "tool-withdraw";

/**
 * Withdraws the tool once the first turn settles. `sessionIdle` runs after the
 * turn's tool result and before the next prompt, so the removal lands before
 * the request the row checks; the marker proves it was requested in time.
 */
export const toolWithdraw = createAgentPlugin(() => ({
  name: NAME,

  tools: { monitor_create: monitorCreate },

  sessionIdle: (_event, ctx) => {
    if (ctx.tools.get("monitor_create") === undefined) {
      return;
    }

    ctx.tools.remove("monitor_create");
    markHere(NAME, { event: "withdrawn" });
  },
}));
