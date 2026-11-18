import type { Plugin } from "@opencode/plugin";

import { markHere } from "../../harness/markers.ts";

export const NAME = "retry-veto";

/**
 * OpenCode's retry hook is native, not a tack field. The error row loads this
 * plugin so its first scripted failure ends the turn instead of spending the
 * retry budget: without the veto OpenCode retries for about 67–101 seconds
 * (packages/core/src/model-retry.ts).
 */
export const retryVeto = {
  id: "tack-conformance.retry-veto",
  setup: (context: Plugin.Context) =>
    context.session
      .hook("retry", (event) => {
        event.decision = { retry: false };
        markHere(NAME, { event: "retry", attempt: event.attempt });
      })
      .then((registration) => () => registration.dispose()),
};
