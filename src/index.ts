/**
 * tack's public entry: one plugin definition, one output per agent, and the
 * hook types those handlers are written against.
 */

export { createAgentPlugin } from "./create.ts";

export type { AgentPlugin } from "./create.ts";

export { InvalidPlugin } from "./plugin.ts";

export { DuplicatePlugin } from "./host/host.ts";

export type { Agent, Meta, PluginDefinition, ResolvedPlugin } from "./plugin.ts";

export { APPEND_CAP_BYTES } from "./hooks/prompt-sent.ts";

export type { Prompt, PromptSent, PromptSentResult } from "./hooks/prompt-sent.ts";

export type { ToolAfter, ToolResult } from "./hooks/tool-after.ts";

export type {
  HookContext,
  ShellDialect,
  ShellInput,
  ToolBefore,
  ToolBeforeResult,
  ToolCall,
} from "./hooks/tool-before.ts";

export { capabilities, fidelity } from "./fidelity/index.ts";

export type { Capability, Cell, Fidelity, FidelityTable } from "./fidelity/index.ts";
