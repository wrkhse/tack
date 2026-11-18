import { Schema } from "effect";

import type { CompiledTool, ToolDefinition } from "./tool.ts";
import { compileDefinition } from "./tool.ts";

/**
 * How a registry reaches one agent's tool namespace. `install` adds tools in
 * one native registration and `withdraw` removes one by name; an agent whose
 * registration is asynchronous settles them through `settled`.
 */
export interface ToolPort {
  readonly install: (tools: ReadonlyArray<CompiledTool>) => void;
  readonly withdraw: (name: string) => void;
  readonly settled: () => Promise<void>;
}

/** A name the agent's tool namespace already holds, and what holds it. */
export interface TakenTool {
  readonly name: string;
  readonly source: string;
}

/** A tool the registry installed, and the way to withdraw it again. */
export interface ToolHandle {
  readonly dispose: () => void;
}

/**
 * A second live tool of a name in one scope. A model calling the name would
 * reach whichever definition won, so the load fails instead of one silently
 * replacing the other.
 */
export class DuplicateTool extends Schema.TaggedError<
  DuplicateTool,
  { readonly brand: unique symbol }
>()("DuplicateTool", {
  tool: Schema.String,
  scope: Schema.String,
  existing: Schema.String,
  incoming: Schema.String,
}) {
  override get message(): string {
    return `tack: two tools named "${this.tool}" are registered in ${this.scope} (${this.existing} and ${this.incoming}); give them different names.`;
  }
}

/** What one registry belongs to and what it reaches. */
export interface ToolRegistryOptions {
  readonly plugin: string;
  readonly scope: string;
  readonly source: string;
  readonly hasSession: boolean;
  readonly port: ToolPort;
  /** Every name already live in the scope, apart from this plugin's own. */
  readonly taken?: ReadonlyArray<TakenTool>;
  /**
   * A tool another plugin in this scope declares, by name. A whole-input
   * rewrite asks for it, so a guard can rewrite a tool its own registry does
   * not hold; a transport with one tool set leaves it out.
   */
  readonly elsewhere?: (name: string) => CompiledTool | undefined;
}

/**
 * The tools one plugin registered, by name. Every context the plugin's hooks
 * and tools receive carries it, so a plugin can add a tool after load or
 * withdraw one and the agent's next snapshot omits it.
 */
export interface ToolRegistry {
  /** One tool this plugin holds, by name. */
  readonly get: (name: string) => CompiledTool | undefined;
  /** Every tool this registry holds now, in install order. */
  readonly list: () => ReadonlyArray<CompiledTool>;
  /** A tool tack defines in this scope, whoever's plugin declares it. */
  readonly resolve: (name: string) => CompiledTool | undefined;
  readonly add: (definition: ToolDefinition) => ToolHandle;
  readonly remove: (name: string) => void;
  /** Withdraws every tool this registry holds, for the agent's unload path. */
  readonly dispose: () => void;
}

/**
 * Builds the registry for one plugin, installing the tools it declared in one
 * native registration. A name another plugin or the agent's own tools already
 * hold fails here, before anything reaches the agent.
 */
export function createToolRegistry(
  options: ToolRegistryOptions,
  tools: ReadonlyArray<CompiledTool>,
): ToolRegistry {
  const entries = new Map<string, CompiledTool>();
  const taken = new Map<string, string>();

  for (const tool of options.taken ?? []) {
    if (!taken.has(tool.name)) taken.set(tool.name, tool.source);
  }

  const duplicate = (name: string): DuplicateTool =>
    new DuplicateTool({
      tool: name,
      scope: options.scope,
      existing: entries.has(name) ? options.source : (taken.get(name) ?? options.source),
      incoming: options.source,
    });

  const check = (name: string): void => {
    if (entries.has(name) || taken.has(name)) throw duplicate(name);
  };

  const remove = (name: string): void => {
    if (!entries.has(name)) return;

    entries.delete(name);
    options.port.withdraw(name);
  };

  const install = (tool: CompiledTool): void => {
    check(tool.name);
    options.port.install([tool]);
    entries.set(tool.name, tool);
  };

  for (const tool of tools) {
    check(tool.name);
  }

  if (tools.length > 0) {
    options.port.install(tools);

    for (const tool of tools) {
      entries.set(tool.name, tool);
    }
  }

  const resolve = (name: string): CompiledTool | undefined =>
    entries.get(name) ?? options.elsewhere?.(name);

  return {
    get: (name) => entries.get(name),
    list: () => Array.from(entries.values()),
    resolve,
    add: (definition) => {
      const built = compileDefinition(
        options.plugin,
        definition.name,
        definition,
        options.hasSession,
      );

      if (!built.ok) throw built.error;

      install(built.tool);

      return { dispose: () => remove(built.tool.name) };
    },
    remove,
    dispose: () => {
      for (const name of entries.keys()) {
        remove(name);
      }
    },
  };
}
