import type { Fidelity } from "./index.ts";

const source = (path: string): string =>
  `https://github.com/anomalyco/opencode/blob/v2.3.0/${path}`;

/** OpenCode 2.3.0 feature evidence, one cell per capability. */
export const opencodeFidelity: Fidelity = {
  agent: "opencode",
  versions: ">=2.3.0 <2.4.0",
  verifiedWith: "2.3.0",
  verifiedAt: "2026-11-17",
  cells: {
    "toolBefore.deny": {
      fidelity: "native",
      how: "throw in `execute.before`",
      source: source("packages/plugin/src/promise/adapter.ts#L688-L698"),
    },
    "toolBefore.rewrite": {
      fidelity: "native",
      how: "assign `event.input`",
      source: source("packages/core/src/tool.ts#L311-L320"),
    },
    "toolBefore.failClosed": {
      fidelity: "native",
      how: "a throw fails the call",
      source: source("packages/plugin/src/promise/adapter.ts#L688-L698"),
    },
    "promptSent.append": {
      fidelity: "native",
      how: "`session` hook `prompt`",
      source: source("packages/core/src/session/prompt.ts#L40-L53"),
    },
    "toolAfter.observe": {
      fidelity: "native",
      how: "`execute.after`",
      source: source("packages/core/src/tool.ts#L166-L181"),
    },
    "host.sharedRealm": {
      fidelity: "native",
      how: "one process realm; per-location scopes unconfirmed in a run",
      source: "spike/unagent/REALM-SPIKE.md",
    },
  },
};
