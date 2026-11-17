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
    "session.append.now": {
      fidelity: "native",
      how: '`ctx.session.synthetic({ sessionID, text, delivery: "steer", resume: false })`; a message admitted mid-turn should steer at the next step boundary. Unconfirmed in a run: that `resume: false` with `delivery: "steer"` lands mid-turn',
      source: source("packages/client/src/promise/generated/types.ts#L3497-L3506"),
    },
    "session.append.next": {
      fidelity: "native",
      how: '`ctx.session.synthetic({ sessionID, text, delivery: "queue", resume: false })`; parked until the running turn ends',
      source: source("packages/schema/src/session-inbox.ts#L11-L12"),
    },
    "session.append.wake": {
      fidelity: "native",
      how: "the same `synthetic` call with `resume: true`, so an idle session schedules a turn; on a busy session it steers. The docs say a message is admitted and execution scheduled unless `resume` is false",
      source: source("packages/client/src/promise/generated/types.ts#L3497-L3506"),
    },
    "session.compact": {
      fidelity: "native",
      how: "`ctx.session.compact({ sessionID, delivery? })` returns `Promise<SessionInboxCompaction>`; compaction runs at the next step boundary by default",
      source: source("packages/client/src/promise/generated/types.ts#L3517-L3522"),
    },
    "session.interrupt": {
      fidelity: "native",
      how: "`ctx.session.interrupt({ sessionID, resume? })` returns `Promise<{ interrupted: boolean }>`, and the harness emits `session.execution.interrupted` with reason `user`",
      source: source("packages/client/src/promise/generated/types.ts#L3574"),
    },
    "session.model": {
      fidelity: "native",
      how: "`ctx.session.switchModel({ sessionID, model: { providerID, id, variant? } })`",
      source: source("packages/client/src/promise/generated/types.ts#L3408-L3411"),
    },
    "event.responseFinished": {
      fidelity: "native",
      how: "`session.step.ended` per model request carries `{ sessionID, assistantMessageID, finish, cost, tokens }`, and `session.step.failed` carries `error`. `done` is `step.ended`; `aborted` is `step.failed` with the `aborted` step error; `error` is `step.failed` with the harness error. Both arrive through `ctx.event.subscribe({ types })`",
      source: source("packages/schema/src/session-event.ts#L371-L404"),
    },
    "event.sessionCreated": {
      fidelity: "native",
      how: "`session.created` through `ctx.event.subscribe`, filtered by `event.location` because the event stream is not location-scoped; an event with no location is ignored. The adapter subscribes at load, and a session already open when the plugin loaded gets no `session.created`, so its first event reports `sessionCreated` with `resumed: true`, then the event",
      source: source("packages/schema/src/session-event.ts#L39-L57"),
    },
    "event.sessionEnded": {
      fidelity: "native",
      how: "`session.deleted` and `session.archived` through `ctx.event.subscribe`, also filtered by `event.location`; both report `closed`. A session persists after the client stops working with it, so deletion or archival ends the handle; a disconnect does not",
      source: source("packages/schema/src/session-event.ts#L133-L137"),
    },
    "event.sessionIdle": {
      fidelity: "native",
      how: 'through the experimental `ctx.session.hook("experimental.idle", cb)` with `{ sessionID, background }`; it runs when a session finishes model work with no pending input and skips interrupted, failed and control-only work. The adapter falls back to the deprecated `session.idle` event when the hook is absent at load',
      source: source("packages/plugin/src/promise/session.ts#L184-L198"),
    },
    "event.permissionAsked": {
      fidelity: "native",
      how: '`ctx.permission.hook("evaluate", cb)` with `{ sessionID, agent?, action, resources[], metadata?, source?, effect, message? }`; `request.effect` is `allow` or `ask`, and the hook runs for both. A configured `deny` skips it, and `{ allow: true }` skips the person\'s configured ask',
      source: source("packages/plugin/src/promise/permission.ts#L8-L19"),
    },
    "session.actOutsideHook": {
      fidelity: "native",
      how: '`ctx.session.*` are client-equivalent action methods, callable at any time with a session id captured in a hook: "Its read and action methods use the same inputs and responses as the client" (Server plugins → Lifecycle → Context). The docs show no setup-time prompt, so that pattern is unconfirmed in a run',
      source: source("packages/plugin/src/promise/session.ts#L219-L239"),
    },
  },
};
