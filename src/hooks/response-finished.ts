import { Effect } from "effect";

import type { ResolvedPlugin } from "../plugin.ts";
import type { Session } from "../session.ts";
import { callHandler } from "./budget.ts";
import { byPriority } from "./order.ts";
import type { HookContext } from "./tool-before.ts";

/** How one model request ended. */
export type ResponseReason = "done" | "aborted" | "error";

/** One model request, reported once it has settled. */
export interface ResponseFinishedEvent {
  readonly session: Session;
  readonly reason: ResponseReason;
}

/** A handler that observes one finished model request. */
export type ResponseFinished = (
  event: ResponseFinishedEvent,
  ctx: HookContext,
) => void | Promise<void>;

/**
 * Runs every `responseFinished` handler in priority order. A failure is logged
 * and never affects the other handlers.
 */
export function runResponseFinished(
  plugins: ReadonlyArray<ResolvedPlugin>,
  event: ResponseFinishedEvent,
  ctx: HookContext,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const plugin of plugins.toSorted(byPriority)) {
      const handler = plugin.responseFinished;

      if (handler === undefined) {
        continue;
      }

      yield* callHandler(plugin, "responseFinished", () => handler(event, ctx)).pipe(
        Effect.catchTag("HandlerFailed", (failure) => Effect.logWarning(failure.message)),
      );
    }
  });
}
