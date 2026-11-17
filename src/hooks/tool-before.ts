import { Data, Effect, Schema } from "effect";

import type { Agent, ResolvedPlugin } from "../plugin.ts";
import { HandlerFailed, callHandler } from "./budget.ts";
import { byPriority } from "./order.ts";

/** What a hook knows about the run it is part of. */
export interface HookContext {
  readonly agent: Agent;
  readonly sessionId: string;
}

/** The shell tool's one normalized input, whatever the agent calls the tool. */
export interface ShellInput {
  readonly command: string;
}

/**
 * The language a shell command is written in. `"unknown"` means the agent
 * chooses its shell at run time, such as OpenCode on Windows.
 */
export type ShellDialect = "posix" | "powershell" | "unknown";

/**
 * A tool call: the shell tool with its normalized input and dialect, or any
 * other tool under the agent's own name and input.
 */
export type ToolCall =
  | {
      readonly tool: "shell";
      readonly name: string;
      readonly dialect: ShellDialect;
      readonly input: ShellInput;
    }
  | { readonly tool: "other"; readonly name: string; readonly input: unknown };

/** What a `toolBefore` handler may return. */
export type ToolBeforeResult =
  | { readonly deny: string }
  | { readonly rewrite: ShellInput }
  | undefined;

/** A handler that may rewrite or deny a tool call. */
export type ToolBefore = (
  call: ToolCall,
  ctx: HookContext,
) => ToolBeforeResult | Promise<ToolBeforeResult>;

/** The combined outcome of every `toolBefore` handler. */
export type ToolDecision = Data.TaggedEnum<{
  Allow: { readonly call: ToolCall; readonly rewritten: boolean };
  Deny: { readonly reason: string };
}>;

/** Constructors and matchers for {@link ToolDecision}. */
export const ToolDecision = Data.taggedEnum<ToolDecision>();

const ToolBeforeResultSchema = Schema.Union([
  Schema.Undefined,
  Schema.Struct({ deny: Schema.String }),
  Schema.Struct({ rewrite: Schema.Struct({ command: Schema.String }) }),
]);

type DecodedToolBeforeResult = Schema.Schema.Type<typeof ToolBeforeResultSchema>;

type Applied =
  | { readonly kind: "allow"; readonly call: ToolCall; readonly rewritten: boolean }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "failed"; readonly message: string };

function invalidResult(
  plugin: ResolvedPlugin,
  reason = "returned an invalid result",
): HandlerFailed {
  return new HandlerFailed({ plugin: plugin.name, hook: "toolBefore", reason });
}

/**
 * Applies one decoded handler result. A rewrite is only meaningful for the
 * shell tool because `command` is the only field tack normalizes.
 */
function applyToolBeforeResult(
  plugin: ResolvedPlugin,
  result: DecodedToolBeforeResult,
  call: ToolCall,
): Effect.Effect<Applied, HandlerFailed> {
  if (result === undefined) {
    return Effect.succeed<Applied>({ kind: "allow", call, rewritten: false });
  }

  if ("deny" in result) {
    return Effect.succeed<Applied>({ kind: "deny", reason: result.deny });
  }

  if (call.tool !== "shell") {
    return Effect.fail(invalidResult(plugin, "rewrite applies only to the shell tool"));
  }

  return Effect.succeed<Applied>({
    kind: "allow",
    call: { ...call, input: { command: result.rewrite.command } },
    rewritten: true,
  });
}

/** Decodes the untrusted handler value before tack acts on it. */
function decodeToolBeforeResult(
  plugin: ResolvedPlugin,
  value: ToolBeforeResult,
  call: ToolCall,
): Effect.Effect<Applied, HandlerFailed> {
  return Schema.decodeEffect(ToolBeforeResultSchema)(value).pipe(
    Effect.mapError(() => invalidResult(plugin)),
    Effect.flatMap((result) => applyToolBeforeResult(plugin, result, call)),
  );
}

/** Runs one handler and folds every failure into the loop's `Applied` shape. */
function applyPlugin(
  plugin: ResolvedPlugin,
  handler: ToolBefore,
  call: ToolCall,
  ctx: HookContext,
): Effect.Effect<Applied> {
  return callHandler(plugin, "toolBefore", () => handler(call, ctx)).pipe(
    Effect.flatMap((value) => decodeToolBeforeResult(plugin, value, call)),
    Effect.match({
      onFailure: (failure): Applied => ({ kind: "failed", message: failure.message }),
      onSuccess: (applied) => applied,
    }),
  );
}

/**
 * Runs every `toolBefore` handler in priority order and combines their
 * decisions. Each handler sees the input as rewritten so far; the first deny
 * wins. A failed handler denies unless the plugin opted into `allow`.
 */
export function runToolBefore(
  plugins: ReadonlyArray<ResolvedPlugin>,
  call: ToolCall,
  ctx: HookContext,
): Effect.Effect<ToolDecision> {
  return Effect.gen(function* () {
    let current = call;
    let rewritten = false;

    for (const plugin of plugins.toSorted(byPriority)) {
      const handler = plugin.toolBefore;

      if (handler === undefined) {
        continue;
      }

      const applied = yield* applyPlugin(plugin, handler, current, ctx);

      if (applied.kind === "allow") {
        current = applied.call;
        rewritten = rewritten || applied.rewritten;

        continue;
      }

      if (applied.kind === "deny") {
        return ToolDecision.Deny({ reason: applied.reason });
      }

      if (plugin.toolBeforeOnError === "deny") {
        return ToolDecision.Deny({ reason: applied.message });
      }

      yield* Effect.logWarning(applied.message);
    }

    return ToolDecision.Allow({ call: current, rewritten });
  });
}
