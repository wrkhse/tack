import type { Agent } from "../plugin.ts";
import { opencodeFidelity } from "./opencode.ts";
import { piFidelity } from "./pi.ts";

/** Every agent capability tack claims, one row per fidelity cell. */
export const capabilities = [
  "toolBefore.deny",
  "toolBefore.rewrite",
  "toolBefore.failClosed",
  "promptSent.append",
  "toolAfter.observe",
  "tool.register",
  "tool.remove",
  "tool.call",
  "tool.result",
  "tool.schema",
  "host.sharedRealm",
  "session.append.now",
  "session.append.next",
  "session.append.wake",
  "session.compact",
  "session.interrupt",
  "session.model",
  "event.responseFinished",
  "event.sessionCreated",
  "event.sessionEnded",
  "event.sessionIdle",
  "event.permissionAsked",
  "session.actOutsideHook",
] as const;

export type Capability = (typeof capabilities)[number];

/** One capability's support on one agent version range. */
export interface Cell {
  readonly fidelity: "native" | "fallback" | "unsupported";
  readonly how: string;
  readonly source: string;
}

/** One agent's fidelity table: the claim, the versions, the evidence. */
export interface Fidelity {
  readonly agent: Agent;
  readonly versions: string;
  readonly verifiedWith: string;
  readonly verifiedAt: string;
  readonly cells: { readonly [K in Capability]: Cell };
}

/** Both agent tables, keyed by agent. */
export interface FidelityTable {
  readonly opencode: Fidelity;
  readonly pi: Fidelity;
}

/** The published fidelity data: one table per agent. */
export const fidelity: FidelityTable = {
  opencode: opencodeFidelity,
  pi: piFidelity,
};
