import { Effect, Predicate } from "effect";
import type * as oc from "@opencode/plugin";
import type { Result } from "@opencode/plugin/promise/tool";

import type { HostSlot, Registration } from "../host/host.ts";
import { hostSlot } from "../host/host.ts";
import { runPromptSent } from "../hooks/prompt-sent.ts";
import type { ToolResult } from "../hooks/tool-after.ts";
import { runToolAfter } from "../hooks/tool-after.ts";
import type { HookContext, ShellDialect, ToolCall } from "../hooks/tool-before.ts";
import { ToolDecision, runToolBefore } from "../hooks/tool-before.ts";
import type { ResolvedPlugin } from "../plugin.ts";
import { joinTextParts } from "./text.ts";

/** An OpenCode 2.3 server plugin: the shape `@opencode/plugin` declares. */
export interface OpenCodePlugin {
  readonly id: string;
  readonly setup: (context: oc.Plugin.Context) => Promise<oc.Plugin.Cleanup>;
}

/** The fields tack reads from an OpenCode tool hook event. */
interface ToolEvent {
  readonly tool: string;
  readonly sessionID: string;
  input: unknown;
}

/** The fields tack reads from OpenCode's `execute.after` event. */
type AfterEvent =
  | (ToolEvent & { readonly status: "completed"; readonly result: Result })
  | (ToolEvent & { readonly status: "error"; readonly error: { readonly message: string } });

/** The fields tack reads from OpenCode's `prompt` event. */
interface PromptEvent {
  readonly sessionID: string;
  readonly prompt: { text: string };
}

/** The only part of an OpenCode hook registration tack uses. */
interface HookRegistration {
  readonly dispose: () => Promise<void>;
}

/** OpenCode hands hooks as promise callbacks, so each crossing into Effect is here. */
function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

/**
 * The text the model sees. OpenCode's `Tool.Result` keeps it in `content`; a
 * text part contributes text, a file part contributes nothing. `output` is the
 * structured value for a tool's output schema, not prose.
 */
function resultText(result: Result): string {
  const content = result.content;

  if (content === undefined) {
    return "";
  }

  if (Predicate.isString(content)) {
    return content;
  }

  return joinTextParts(content);
}

/** OpenCode on Windows picks its shell at run time, so tack cannot know it. */
function dialectOf(): ShellDialect {
  return process.platform === "win32" ? "unknown" : "posix";
}

/** tack's view of an OpenCode tool call: a shell command, or the agent's own tool. */
function callOf(event: ToolEvent): ToolCall {
  const input = event.input;

  if (event.tool === "shell" && Predicate.isObject(input) && Predicate.isString(input["command"])) {
    return {
      tool: "shell",
      name: "shell",
      dialect: dialectOf(),
      input: { command: input["command"] },
    };
  }

  return { tool: "other", name: event.tool, input };
}

/** Replaces only the command, keeping OpenCode's other input fields. */
function assignRewrite(event: ToolEvent, command: string): void {
  const input = event.input;

  if (!Predicate.isObject(input)) {
    return;
  }

  event.input = { ...input, command };
}

/** Runs `toolBefore` for a call and throws the reason on a deny. */
function handleBefore(
  slot: HostSlot,
  registration: Registration,
  event: ToolEvent,
): void | Promise<void> {
  if (!slot.isLeader(registration)) {
    return;
  }

  const ctx: HookContext = { agent: "opencode", sessionId: event.sessionID };
  const call = callOf(event);

  return run(runToolBefore(slot.plugins(registration.scope), call, ctx)).then((decision) => {
    ToolDecision.$match(decision, {
      Allow: (value) => {
        if (value.rewritten && value.call.tool === "shell") {
          assignRewrite(event, value.call.input.command);
        }
      },
      Deny: (value) => {
        throw new Error(value.reason);
      },
    });
  });
}

/** Runs `toolAfter` with the completed output or the failure message. */
function handleAfter(
  slot: HostSlot,
  registration: Registration,
  event: AfterEvent,
): void | Promise<void> {
  if (!slot.isLeader(registration)) {
    return;
  }

  const ctx: HookContext = { agent: "opencode", sessionId: event.sessionID };
  const call = callOf(event);

  const result: ToolResult =
    event.status === "completed"
      ? { output: resultText(event.result), isError: false }
      : { output: event.error.message, isError: true };

  return run(runToolAfter(slot.plugins(registration.scope), call, result, ctx));
}

/** Runs `promptSent` and appends the combined text after a blank line. */
function handlePrompt(
  slot: HostSlot,
  registration: Registration,
  event: PromptEvent,
): void | Promise<void> {
  if (!slot.isLeader(registration)) {
    return;
  }

  const ctx: HookContext = { agent: "opencode", sessionId: event.sessionID };

  return run(
    runPromptSent(slot.plugins(registration.scope), { text: event.prompt.text }, ctx),
  ).then((append) => {
    if (append !== undefined) {
      event.prompt.text = `${event.prompt.text}\n\n${append}`;
    }
  });
}

/** Ends the slot registration and every hook registration. */
function disposeAll(
  registration: Registration,
  hooks: ReadonlyArray<HookRegistration>,
): Promise<void> {
  registration.dispose();

  return Promise.all(hooks.map((hook) => hook.dispose())).then(() => undefined);
}

/** Registers the plugin and its hooks in one location's scope. */
function setupPlugin(
  plugin: ResolvedPlugin,
  context: oc.Plugin.Context,
  scope: string,
): Promise<oc.Plugin.Cleanup> {
  return run(hostSlot()).then((slot) => {
    const registration = slot.register(scope, plugin);

    return Promise.all([
      context.tool.hook("execute.before", (event) => handleBefore(slot, registration, event)),
      context.tool.hook("execute.after", (event) => handleAfter(slot, registration, event)),
      context.session.hook("prompt", (event) => handlePrompt(slot, registration, event)),
    ]).then(
      (hooks) => () => disposeAll(registration, hooks),
      (cause: Error) => {
        registration.dispose();
        throw cause;
      },
    );
  });
}

/** Wraps one resolved definition as an OpenCode server plugin. */
export function opencodePlugin(plugin: ResolvedPlugin): OpenCodePlugin {
  return {
    id: `tack.${plugin.name}`,
    setup: (context) => setupPlugin(plugin, context, `opencode:${context.location.directory}`),
  };
}
