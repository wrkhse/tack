/**
 * tack's public entry: one plugin definition, one output per agent, the hook
 * types those handlers are written against, and the session handle they act
 * through.
 */

export { createAgentPlugin } from "./create.ts";

export type { AgentPlugin } from "./create.ts";

export { InvalidPlugin } from "./plugin.ts";

export { DuplicatePlugin } from "./host/host.ts";

export type { Agent, Meta, PluginDefinition, ResolvedPlugin } from "./plugin.ts";

export { APPEND_CAP_BYTES } from "./hooks/prompt-sent.ts";

export { DEFAULT_TIMEOUT_MS, InvalidTool, MAX_RESULT_BYTES, tool } from "./tools/tool.ts";

export type { CompiledTool, ToolCallResult, ToolContext, ToolDefinition } from "./tools/tool.ts";

export { DuplicateTool } from "./tools/registry.ts";

export type { ToolHandle, ToolRegistry } from "./tools/registry.ts";

export { serveMcp } from "./mcp/serve.ts";

export type { McpOptions } from "./mcp/serve.ts";

export type { Prompt, PromptSent, PromptSentResult } from "./hooks/prompt-sent.ts";

export type {
  SessionCreated,
  SessionCreatedEvent,
  SessionEnded,
  SessionEndedEvent,
} from "./hooks/lifecycle.ts";

export type {
  ResponseFinished,
  ResponseFinishedEvent,
  ResponseReason,
} from "./hooks/response-finished.ts";

export type { SessionIdle, SessionIdleEvent } from "./hooks/session-idle.ts";

export type {
  PermissionAsked,
  PermissionAskedResult,
  PermissionRequest,
} from "./hooks/permission-asked.ts";

export type { ToolAfter, ToolResult } from "./hooks/tool-after.ts";

export type {
  HookContext,
  ShellDialect,
  ShellInput,
  ToolBefore,
  ToolBeforeResult,
  ToolCall,
} from "./hooks/tool-before.ts";

export type { AppendWhen, ModelRef, Outcome, Session, SessionPort } from "./session.ts";

export { capabilities, fidelity } from "./fidelity/index.ts";

export type { Capability, Cell, Fidelity, FidelityTable } from "./fidelity/index.ts";
