import { Effect } from "effect";

import type { ResolvedPlugin } from "../plugin.ts";
import type { HookContext, ToolCall } from "./tool-before.ts";
import { callHandler } from "./budget.ts";
import { byPriority } from "./order.ts";

/** What the agent's tool returned. */
export interface ToolResult {
  readonly output: string;
  readonly isError: boolean;
}

/** A handler that observes the final call and its result. */
export type ToolAfter = (
  call: ToolCall,
  result: ToolResult,
  ctx: HookContext,
) => void | Promise<void>;

/**
 * Runs every `toolAfter` handler in priority order. A failure is logged and
 * never affects the other handlers or the tool result.
 */
export function runToolAfter(
  plugins: ReadonlyArray<ResolvedPlugin>,
  call: ToolCall,
  result: ToolResult,
  ctx: HookContext,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const plugin of plugins.toSorted(byPriority)) {
      const handler = plugin.toolAfter;

      if (handler === undefined) {
        continue;
      }

      yield* callHandler(plugin, "toolAfter", () => handler(call, result, ctx)).pipe(
        Effect.catchTag("HandlerFailed", (failure) => Effect.logWarning(failure.message)),
      );
    }
  });
}
