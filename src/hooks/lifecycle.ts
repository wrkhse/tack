import { Effect } from "effect";

import type { ResolvedPlugin } from "../plugin.ts";
import type { Session } from "../session.ts";
import { callHandler } from "./budget.ts";
import { byPriority } from "./order.ts";
import type { HookContext } from "./tool-before.ts";

/** A session's start, as every plugin observes it. */
export interface SessionCreatedEvent {
  readonly session: Session;
  /**
   * True when tack found the session already open, so no plugin saw it start.
   * A plugin uses it to tell "a session appeared" from "a session I inherited".
   */
  readonly resumed: boolean;
}

/** A handler that observes a session's start. */
export type SessionCreated = (event: SessionCreatedEvent, ctx: HookContext) => void | Promise<void>;

/** Why a session's handle stopped being live. */
export interface SessionEndedEvent {
  readonly session: Session;
  readonly reason: "closed" | "shutdown" | "replaced";
}

/** A handler that observes a session's end. */
export type SessionEnded = (event: SessionEndedEvent, ctx: HookContext) => void | Promise<void>;

/**
 * Runs every `sessionCreated` handler in priority order. A failure is logged
 * and never affects the other handlers.
 */
export function runSessionCreated(
  plugins: ReadonlyArray<ResolvedPlugin>,
  event: SessionCreatedEvent,
  ctx: HookContext,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const plugin of plugins.toSorted(byPriority)) {
      const handler = plugin.sessionCreated;

      if (handler === undefined) {
        continue;
      }

      yield* callHandler(plugin, "sessionCreated", () => handler(event, ctx)).pipe(
        Effect.catchTag("HandlerFailed", (failure) => Effect.logWarning(failure.message)),
      );
    }
  });
}

/**
 * Runs every `sessionEnded` handler in priority order. A failure is logged and
 * never affects the other handlers.
 */
export function runSessionEnded(
  plugins: ReadonlyArray<ResolvedPlugin>,
  event: SessionEndedEvent,
  ctx: HookContext,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const plugin of plugins.toSorted(byPriority)) {
      const handler = plugin.sessionEnded;

      if (handler === undefined) {
        continue;
      }

      yield* callHandler(plugin, "sessionEnded", () => handler(event, ctx)).pipe(
        Effect.catchTag("HandlerFailed", (failure) => Effect.logWarning(failure.message)),
      );
    }
  });
}
