import { Effect } from "effect";

import type { HostSlot, Registration } from "../host/host.ts";
import type { HookContext, ToolCall } from "../hooks/tool-before.ts";
import { ToolDecision, runToolBefore } from "../hooks/tool-before.ts";

/** The chain's answer once any rewrite is applied: an allow, or a deny reason. */
type BeforeAnswer = { readonly denied: false } | { readonly denied: true; readonly reason: string };

/**
 * Runs the `toolBefore` chain when this registration leads the scope, applying
 * a rewrite through `rewrite`. A deny goes through `deny`, so each adapter
 * expresses it natively. A non-leader runs nothing and returns undefined.
 */
export function runBefore<Result>(
  slot: HostSlot,
  registration: Registration,
  call: ToolCall,
  ctx: HookContext,
  deny: (reason: string) => Result,
  rewrite: (call: ToolCall) => void,
): Result | undefined | Promise<Result | undefined> {
  if (!slot.isLeader(registration)) {
    return undefined;
  }

  const answer = runToolBefore(slot.plugins(registration.scope), call, ctx).pipe(
    Effect.map((decision) =>
      ToolDecision.$match(decision, {
        Allow: (value): BeforeAnswer => {
          if (value.rewritten) {
            rewrite(value.call);
          }

          return { denied: false };
        },
        Deny: (value): BeforeAnswer => ({ denied: true, reason: value.reason }),
      }),
    ),
    Effect.runPromise,
  );

  return answer.then((value) => (value.denied ? deny(value.reason) : undefined));
}
