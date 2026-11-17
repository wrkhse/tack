import { Effect, Schema } from "effect";

import type { ResolvedPlugin } from "../plugin.ts";
import { HandlerFailed, callHandler } from "./budget.ts";
import { byPriority } from "./order.ts";
import type { HookContext } from "./tool-before.ts";

/** The prompt the agent is about to send. */
export interface Prompt {
  readonly text: string;
}

/** What a `promptSent` handler may return. */
export type PromptSentResult = { readonly append: string } | undefined;

/** A handler that may append text to the outgoing prompt. */
export type PromptSent = (
  prompt: Prompt,
  ctx: HookContext,
) => PromptSentResult | Promise<PromptSentResult>;

/** The most UTF-8 bytes of appended text one prompt may carry. */
export const APPEND_CAP_BYTES = 16384;

const PromptSentResultSchema = Schema.Union([
  Schema.Undefined,
  Schema.Struct({ append: Schema.String }),
]);

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Turns a handler value into text, or logs and skips a broken handler. */
function appendOf(
  plugin: ResolvedPlugin,
  handler: PromptSent,
  prompt: Prompt,
  ctx: HookContext,
): Effect.Effect<string | undefined> {
  return callHandler(plugin, "promptSent", () => handler(prompt, ctx)).pipe(
    Effect.flatMap((value) =>
      Schema.decodeEffect(PromptSentResultSchema)(value).pipe(
        Effect.mapError(
          () =>
            new HandlerFailed({
              plugin: plugin.name,
              hook: "promptSent",
              reason: "returned an invalid result",
            }),
        ),
      ),
    ),
    Effect.map((result) => result?.append),
    Effect.catchTag("HandlerFailed", (failure) =>
      Effect.logWarning(failure.message).pipe(Effect.as(undefined)),
    ),
  );
}

/**
 * Collects prompt appends in priority order, drops duplicates and empty
 * strings, and stops adding text once the combined append would pass
 * {@link APPEND_CAP_BYTES}. A failing handler is logged and skipped.
 */
export function runPromptSent(
  plugins: ReadonlyArray<ResolvedPlugin>,
  prompt: Prompt,
  ctx: HookContext,
): Effect.Effect<string | undefined> {
  return Effect.gen(function* () {
    const parts: string[] = [];
    let bytes = 0;

    for (const plugin of plugins.toSorted(byPriority)) {
      const handler = plugin.promptSent;

      if (handler === undefined) {
        continue;
      }

      const text = yield* appendOf(plugin, handler, prompt, ctx);

      if (text === undefined || text.length === 0) {
        continue;
      }

      if (parts.includes(text)) {
        continue;
      }

      const separator = parts.length === 0 ? 0 : 2;

      if (bytes + separator + byteLength(text) > APPEND_CAP_BYTES) {
        yield* Effect.logWarning(
          `tack: ${plugin.name} append dropped: the combined append would exceed ${APPEND_CAP_BYTES} bytes`,
        );

        continue;
      }

      bytes += separator + byteLength(text);
      parts.push(text);
    }

    return parts.length === 0 ? undefined : parts.join("\n\n");
  });
}
