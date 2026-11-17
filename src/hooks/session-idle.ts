import { Effect } from "effect";

import type { ResolvedPlugin } from "../plugin.ts";
import type { Session } from "../session.ts";
import { callHandler } from "./budget.ts";
import { byPriority } from "./order.ts";
import type { HookContext } from "./tool-before.ts";

/** A session that has finished its work and has no pending input. */
export interface SessionIdleEvent {
  readonly session: Session;
}

/** A handler that observes a session going idle. */
export type SessionIdle = (event: SessionIdleEvent, ctx: HookContext) => void | Promise<void>;

/**
 * Runs every `sessionIdle` handler in priority order. A failure is logged and
 * never affects the other handlers.
 */
export function runSessionIdle(
  plugins: ReadonlyArray<ResolvedPlugin>,
  event: SessionIdleEvent,
  ctx: HookContext,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const plugin of plugins.toSorted(byPriority)) {
      const handler = plugin.sessionIdle;

      if (handler === undefined) {
        continue;
      }

      yield* callHandler(plugin, "sessionIdle", () => handler(event, ctx)).pipe(
        Effect.catchTag("HandlerFailed", (failure) => Effect.logWarning(failure.message)),
      );
    }
  });
}
