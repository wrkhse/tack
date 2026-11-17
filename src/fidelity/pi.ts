import type { Fidelity } from "./index.ts";

const source = (path: string): string => `@earendil-works/pi-coding-agent@1.5.2/${path}`;

/** Pi 1.5.2 feature evidence, one cell per capability. */
export const piFidelity: Fidelity = {
  agent: "pi",
  versions: ">=1.5.2 <1.6.0",
  verifiedWith: "1.5.2",
  verifiedAt: "2026-11-17",
  cells: {
    "toolBefore.deny": {
      fidelity: "native",
      how: "`{ block, reason }` from `tool_call`",
      source: source("dist/core/extensions/types.d.ts#L1109-L1119"),
    },
    "toolBefore.rewrite": {
      fidelity: "native",
      how: "mutate `event.input`",
      source: source("docs/extensions.md#L979-L986"),
    },
    "toolBefore.failClosed": {
      fidelity: "native",
      how: "a throw blocks the call",
      source: source("docs/extensions.md#L3250-L3256"),
    },
    "promptSent.append": {
      fidelity: "native",
      how: "`input` transform",
      source: source("dist/core/agent-session.js#L1656-L1669"),
    },
    "toolAfter.observe": {
      fidelity: "native",
      how: "`tool_result`",
      source: source("dist/core/extensions/types.d.ts#L1030-L1059"),
    },
    "host.sharedRealm": {
      fidelity: "native",
      how: "one realm",
      source: "spike/unagent/REALM-SPIKE.md",
    },
  },
};
