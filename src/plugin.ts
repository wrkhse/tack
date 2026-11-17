import { Effect, Schema } from "effect";

import type { PromptSent } from "./hooks/prompt-sent.ts";
import type { ToolAfter } from "./hooks/tool-after.ts";
import type { ToolBefore } from "./hooks/tool-before.ts";

/** The agent a plugin output targets. */
export type Agent = "opencode" | "pi";

/** Facts the factory receives about the agent loading the plugin. */
export interface Meta {
  readonly agent: Agent;
}

/** A plugin as its author writes it, before tack applies defaults. */
export interface PluginDefinition {
  readonly name: string;
  readonly priority?: number;
  readonly budgetMs?: number;
  readonly onError?: { readonly toolBefore?: "deny" | "allow" };
  readonly toolBefore?: ToolBefore;
  readonly promptSent?: PromptSent;
  readonly toolAfter?: ToolAfter;
}

/**
 * A validated definition with defaults applied: the plain-data view the host
 * slot shares between copies of tack.
 */
export interface ResolvedPlugin {
  readonly name: string;
  readonly priority: number;
  readonly budgetMs: number;
  readonly toolBeforeOnError: "deny" | "allow";
  readonly toolBefore: ToolBefore | undefined;
  readonly promptSent: PromptSent | undefined;
  readonly toolAfter: ToolAfter | undefined;
}

const DEFAULT_PRIORITY = 100;
const DEFAULT_BUDGET_MS = 5000;
const MAX_BUDGET_MS = 60000;
const NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * A definition tack refuses to load. The message names the plugin as written
 * and the rule it broke.
 */
export class InvalidPlugin extends Schema.TaggedError<
  InvalidPlugin,
  { readonly brand: unique symbol }
>()("InvalidPlugin", {
  plugin: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `tack: plugin "${this.plugin}" is invalid: ${this.reason}`;
  }
}

/**
 * Applies defaults and checks the load-time invariants of a definition.
 *
 * The factory runs once per agent module load, so this is the single place a
 * definition becomes trusted data for the host slot and the hook runners.
 */
export function resolvePlugin(
  definition: PluginDefinition,
): Effect.Effect<ResolvedPlugin, InvalidPlugin> {
  const { name } = definition;

  if (!NAME_PATTERN.test(name)) {
    return Effect.fail(new InvalidPlugin({ plugin: name, reason: "name must match [a-z0-9-]+" }));
  }

  const priority = definition.priority ?? DEFAULT_PRIORITY;

  if (!Number.isInteger(priority)) {
    return Effect.fail(new InvalidPlugin({ plugin: name, reason: "priority must be an integer" }));
  }

  const budgetMs = definition.budgetMs ?? DEFAULT_BUDGET_MS;

  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > MAX_BUDGET_MS) {
    return Effect.fail(
      new InvalidPlugin({
        plugin: name,
        reason: `budgetMs must be an integer from 1 to ${MAX_BUDGET_MS}`,
      }),
    );
  }

  return Effect.succeed({
    name,
    priority,
    budgetMs,
    toolBeforeOnError: definition.onError?.toolBefore ?? "deny",
    toolBefore: definition.toolBefore,
    promptSent: definition.promptSent,
    toolAfter: definition.toolAfter,
  });
}
