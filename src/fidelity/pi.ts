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
    "tool.register": {
      fidelity: "native",
      how: "`pi.registerTool({ name, label, description, parameters, execute })` works during load and after startup; the tool is active and declared on the next request (`dist/core/extensions/types.d.ts` L1271; `docs/extensions.md` L1582–1592)",
      source: source("dist/core/extensions/types.d.ts#L1271"),
    },
    "tool.remove": {
      fidelity: "fallback",
      how: 'there is no unregister. Re-register the same name with `exposure: "hidden"`, which leaves it registered but withdrawn, and tack refuses a call to it; `setActiveTools` is the other route (`dist/core/extensions/types.d.ts` L1271, L1336; `docs/extensions.md` L2766)',
      source: source("docs/extensions.md#L2766"),
    },
    "tool.call": {
      fidelity: "native",
      how: "`execute(toolCallId, params, signal, onUpdate, ctx)` returns the result (`dist/core/extensions/types.d.ts` L534)",
      source: source("dist/core/extensions/types.d.ts#L534"),
    },
    "tool.result": {
      fidelity: "native",
      how: "`AgentToolResult` carries `content` blocks, `details`, `structuredContent?`, `isError?` and `terminate?`; `isError` reports a failure the model sees (`@earendil-works/pi-agent-core` `dist/types.d.ts` L370–393; `dist/core/extensions/types.d.ts` L534)",
      source: "@earendil-works/pi-agent-core@1.5.2/dist/types.d.ts#L370-L393",
    },
    "tool.schema": {
      fidelity: "native",
      how: "Pi validates arguments as JSON Schema with `@earendil-works/pi-schema`, whatever built the schema, so a plain object is accepted (`docs/extensions.md` L174–184)",
      source: source("docs/extensions.md#L174-L184"),
    },
    "host.sharedRealm": {
      fidelity: "native",
      how: "one realm",
      source: "spike/unagent/REALM-SPIKE.md",
    },
    "session.append.now": {
      fidelity: "native",
      how: '`pi.sendMessage({ customType, content, display: false }, { deliverAs: "steer" })` while streaming; no `triggerTurn`, delivered after the turn\'s tool calls, before the next model call; idle, it is stored without starting a run',
      source: source("dist/core/extensions/types.d.ts#L1303-L1316"),
    },
    "session.append.next": {
      fidelity: "native",
      how: '`pi.sendMessage(..., { deliverAs: "followUp" })`, delivered when the agent has no more tool calls; no `triggerTurn`, so an idle session stores it without starting a run',
      source: source("dist/core/extensions/types.d.ts#L1303-L1316"),
    },
    "session.append.wake": {
      fidelity: "native",
      how: '`pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`; idle, it starts a turn immediately, and while streaming it steers. Without `triggerTurn`, an idle session only stores the message',
      source: source("docs/extensions.md#L1648"),
    },
    "session.compact": {
      fidelity: "native",
      how: "native, but it differs: `ctx.compact({ customInstructions?, onComplete?, onError? })` aborts the running turn first, where OpenCode waits for a step boundary",
      source: source("dist/core/extensions/types.d.ts#L224-L270"),
    },
    "session.interrupt": {
      fidelity: "native",
      how: "`ctx.abort()`; the run settles with `agent_settled.aborted: true`",
      source: source("dist/core/extensions/types.d.ts#L263"),
    },
    "session.model": {
      fidelity: "native",
      how: "`pi.setModel(model)` with the model from `ctx.modelRegistry.find(provider, id)`; it returns false when the provider has no credentials, and an unknown model yields no model",
      source: source("dist/core/extensions/types.d.ts#L1343-L1344"),
    },
    "event.responseFinished": {
      fidelity: "native",
      how: "`turn_end` extends `BoundaryState`, and `outcome` is `completed`, `aborted` or `error`; tack maps `done`, `aborted` and `error` straight across",
      source: source("dist/core/extensions/types.d.ts#L772"),
    },
    "event.sessionCreated": {
      fidelity: "native",
      how: "`session_start` with reason `startup`, `reload`, `new`, `resume` or `fork`; `resumed` is true for `resume` and `fork`",
      source: source("dist/core/extensions/types.d.ts#L595-L601"),
    },
    "event.sessionEnded": {
      fidelity: "native",
      how: "`session_shutdown` reports `quit` as `shutdown`; `reload`, `new`, `resume` and `fork` report `replaced`, because the session was replaced, not ended by the person",
      source: source("dist/core/extensions/types.d.ts#L657-L662"),
    },
    "event.sessionIdle": {
      fidelity: "native",
      how: "`agent_settled` is the only final-idle signal and is notification-only; it fires with `aborted: true` when the run was aborted, where OpenCode's idle hook stays silent. `ctx.isIdle()` reads the current state",
      source: source("dist/core/extensions/types.d.ts#L821-L825"),
    },
    "event.permissionAsked": {
      fidelity: "unsupported",
      how: "Pi has no permission layer: no event, no callback and no config setting. `docs/security.md` L3 says it \"does not ask for approval before every tool call\", the extension event union has no permission member, and the settings schema has no permission field. An extension's own `tool_call` handler asking with `ctx.ui.select/confirm` is T1's `toolBefore` guard, not a permission layer",
      source: source("docs/security.md#L3"),
    },
    "session.actOutsideHook": {
      fidelity: "native",
      how: 'from `session_start` on; the factory\'s action methods throw "Extension runtime not initialized..." during loading; background work is deferred to `session_start` and closed at `session_shutdown`, as the file-trigger example does. A captured `pi` or ctx must not be used after a session is replaced',
      source: source("dist/core/extensions/loader.js#L112-L113"),
    },
  },
};
