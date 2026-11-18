import { Effect, Schema } from "effect";

import type { ResolvedPlugin } from "../plugin.ts";
import { HandlerFailed, callHandler } from "./budget.ts";
import { byPriority } from "./order.ts";
import type { HookContext } from "./tool-before.ts";

/** The permission the agent is about to evaluate. */
export interface PermissionRequest {
  readonly sessionId: string;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  /** The harness's current effect. A configured `deny` never reaches the hook. */
  readonly effect: "allow" | "ask";
  readonly message?: string;
}

/**
 * What a `permissionAsked` handler may return: `{ allow: true }` allows the
 * action without the person's configured prompt, `{ deny }` refuses it, and
 * `undefined` leaves the decision to the agent's own rule.
 */
export type PermissionAskedResult =
  | { readonly allow: true }
  | { readonly deny: string }
  | undefined;

/** A handler that may allow or deny one permission request. */
export type PermissionAsked = (
  request: PermissionRequest,
  ctx: HookContext,
) => PermissionAskedResult | Promise<PermissionAskedResult>;

const PermissionAskedResultSchema = Schema.Union([
  Schema.Undefined,
  Schema.Struct({ allow: Schema.Literal(true) }),
  Schema.Struct({ deny: Schema.String }),
]);

type DecodedResult = Schema.Schema.Type<typeof PermissionAskedResultSchema>;

/** Decodes the untrusted handler value before tack acts on it. */
function decodeResult(
  plugin: ResolvedPlugin,
  value: PermissionAskedResult,
): Effect.Effect<DecodedResult, HandlerFailed> {
  return Schema.decodeEffect(PermissionAskedResultSchema)(value).pipe(
    Effect.mapError(
      () =>
        new HandlerFailed({
          plugin: plugin.name,
          hook: "permissionAsked",
          reason: "returned an invalid result",
        }),
    ),
  );
}

type Answer =
  | { readonly kind: "answer"; readonly value: DecodedResult }
  | { readonly kind: "failed"; readonly message: string };

/** Runs one handler and folds a failure into a value the loop can act on. */
function ask(
  plugin: ResolvedPlugin,
  handler: PermissionAsked,
  request: PermissionRequest,
  ctx: HookContext,
): Effect.Effect<Answer> {
  return callHandler(plugin, "permissionAsked", () => handler(request, ctx)).pipe(
    Effect.flatMap((value) => decodeResult(plugin, value)),
    Effect.match({
      onFailure: (failure): Answer => ({ kind: "failed", message: failure.message }),
      onSuccess: (value): Answer => ({ kind: "answer", value }),
    }),
  );
}

/**
 * Runs every `permissionAsked` handler in priority order.
 *
 * The first deny wins and supplies the reason. `{ allow: true }` is consent
 * only when every handler answered allow: an `undefined` answer and a handler
 * that failed are each not consent, so the result is `undefined` and the
 * agent's own rule decides. A failed handler is
 * a `HandlerFailed`: the `"deny"` setting refuses with the failure message;
 * the default `"leave"` logs it, records that the handler left, and runs the
 * next one, so one failure never stops the rest.
 */
export function runPermissionAsked(
  plugins: ReadonlyArray<ResolvedPlugin>,
  request: PermissionRequest,
  ctx: HookContext,
): Effect.Effect<PermissionAskedResult> {
  return Effect.gen(function* () {
    let allowed = false;
    let left = false;

    for (const plugin of plugins.toSorted(byPriority)) {
      const handler = plugin.permissionAsked;

      if (handler === undefined) {
        continue;
      }

      const answer = yield* ask(plugin, handler, request, ctx);

      if (answer.kind === "failed") {
        if (plugin.permissionAskedOnError === "deny") {
          return { deny: answer.message };
        }

        yield* Effect.logWarning(answer.message);

        left = true;

        continue;
      }

      if (answer.value === undefined) {
        left = true;

        continue;
      }

      if ("deny" in answer.value) {
        return answer.value;
      }

      allowed = true;
    }

    return allowed && !left ? { allow: true } : undefined;
  });
}
