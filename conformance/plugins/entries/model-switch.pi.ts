import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { markHere } from "../../harness/markers.ts";
import { markLoaded } from "../loaded.ts";
import { NAME, modelSwitch } from "../t2/model-switch.ts";

markLoaded(NAME);

const extension = modelSwitch.pi();

/**
 * `model_select` is a Pi extension event, not an RPC session event, so the
 * entry records the model the switch landed on.
 */
export default (pi: ExtensionAPI) => {
  extension(pi);

  pi.on("model_select", (event) => {
    markHere(NAME, {
      event: "model_select",
      provider: event.model.provider,
      model: event.model.id,
    });
  });
};
