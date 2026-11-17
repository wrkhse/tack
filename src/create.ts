import { Cause, Effect, Exit, Option } from "effect";

import type { OpenCodePlugin } from "./agents/opencode.ts";
import { opencodePlugin } from "./agents/opencode.ts";
import type { PiExtension } from "./agents/pi.ts";
import { piExtension } from "./agents/pi.ts";
import type { Agent, Meta, PluginDefinition, ResolvedPlugin } from "./plugin.ts";
import { resolvePlugin } from "./plugin.ts";

/** One plugin's output function for each agent. */
export interface AgentPlugin<Options> {
  readonly opencode: (options: Options) => OpenCodePlugin;
  readonly pi: (options: Options) => PiExtension;
}

/**
 * Resolves a definition once, when the agent loads the module. A definition
 * tack refuses fails that load with the rule it broke.
 */
function resolveFor<Options>(
  factory: (options: Options, meta: Meta) => PluginDefinition,
  options: Options,
  agent: Agent,
): ResolvedPlugin {
  const exit = Effect.runSyncExit(resolvePlugin(factory(options, { agent })));

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  const failure = Option.match(Cause.findErrorOption(exit.cause), {
    onNone: () => new Error("tack: plugin validation failed"),
    onSome: (error) => new Error(error.message),
  });

  throw failure;
}

/**
 * Turns a definition factory into one output function per agent. Each output
 * resolves the definition at the moment that agent loads it.
 */
export function createAgentPlugin<Options = void>(
  factory: (options: Options, meta: Meta) => PluginDefinition,
): AgentPlugin<Options> {
  return {
    opencode: (options) => opencodePlugin(resolveFor(factory, options, "opencode")),
    pi: (options) => piExtension(resolveFor(factory, options, "pi")),
  };
}
