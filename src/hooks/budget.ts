import { Duration, Effect, Schema } from "effect";

import type { ResolvedPlugin } from "../plugin.ts";

/** The hook a handler failure happened in. */
export type HookName =
  | "toolBefore"
  | "promptSent"
  | "toolAfter"
  | "sessionCreated"
  | "sessionEnded"
  | "responseFinished"
  | "sessionIdle"
  | "permissionAsked";

/** The hook name schema and type share one closed union. */
const HookNameSchema = Schema.Literals([
  "toolBefore",
  "promptSent",
  "toolAfter",
  "sessionCreated",
  "sessionEnded",
  "responseFinished",
  "sessionIdle",
  "permissionAsked",
]);

/**
 * One plugin handler missed its contract: it threw, rejected, timed out, or
 * returned a value tack could not decode.
 */
export class HandlerFailed extends Schema.TaggedError<
  HandlerFailed,
  { readonly brand: unique symbol }
>()("HandlerFailed", {
  plugin: Schema.String,
  hook: HookNameSchema,
  reason: Schema.String,
}) {
  override get message(): string {
    return `tack: ${this.plugin} failed: ${this.reason}`;
  }
}

/**
 * Runs one plugin handler under the plugin's budget.
 *
 * A synchronous throw, a rejection and a missed budget all become
 * `HandlerFailed`; the caller decides whether that denies, skips or logs.
 * `Promise.resolve().then` keeps a synchronous throw inside the promise so
 * one path handles both shapes.
 */
export function callHandler<A>(
  plugin: ResolvedPlugin,
  hook: HookName,
  run: () => A | Promise<A>,
): Effect.Effect<A, HandlerFailed> {
  const attempt = Effect.tryPromise({
    try: () => Promise.resolve().then(run),
    catch: (cause) =>
      new HandlerFailed({
        plugin: plugin.name,
        hook,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  return attempt.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(plugin.budgetMs),
      orElse: () =>
        Effect.fail(
          new HandlerFailed({
            plugin: plugin.name,
            hook,
            reason: `timed out after ${plugin.budgetMs} ms`,
          }),
        ),
    }),
  );
}
