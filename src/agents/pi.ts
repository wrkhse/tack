import { Effect, Predicate } from "effect";
import type {
  BashToolCallEvent,
  ExtensionAPI,
  InputEvent,
  InputEventResult,
  PowerShellToolCallEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import type { HostSlot, Registration } from "../host/host.ts";
import { hostSlot } from "../host/host.ts";
import { runPromptSent } from "../hooks/prompt-sent.ts";
import type { ToolResult } from "../hooks/tool-after.ts";
import { runToolAfter } from "../hooks/tool-after.ts";
import type { HookContext, ToolCall } from "../hooks/tool-before.ts";
import { ToolDecision, runToolBefore } from "../hooks/tool-before.ts";
import type { ResolvedPlugin } from "../plugin.ts";
import { joinTextParts } from "./text.ts";

/** The scope every Pi extension in one process shares. */
const PI_SCOPE = "pi";

/** A Pi 1.5 extension factory. */
export type PiExtension = (pi: ExtensionAPI) => void;

/** Bash and PowerShell both carry their command in `input.command`. */
type ShellToolCallEvent = BashToolCallEvent | PowerShellToolCallEvent;

/** Pi hands hooks as promise callbacks, so each crossing into Effect is here. */
function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

/** True when the call's tool is a shell and its input carries a command. */
function isShellCall(event: ToolCallEvent): event is ShellToolCallEvent {
  return (
    (event.toolName === "bash" || event.toolName === "powershell") &&
    Predicate.isObject(event.input) &&
    Predicate.isString(event.input["command"])
  );
}

/** tack's view of a Pi tool call or result: a shell command, or the agent's own tool. */
function callOf(event: ToolCallEvent | ToolResultEvent): ToolCall {
  const name = event.toolName;
  const input = event.input;

  if (
    (name === "bash" || name === "powershell") &&
    Predicate.hasProperty("command")(input) &&
    Predicate.isString(input["command"])
  ) {
    return {
      tool: "shell",
      name,
      dialect: name === "bash" ? "posix" : "powershell",
      input: { command: input["command"] },
    };
  }

  return { tool: "other", name, input };
}

/** Pi requires rewrites in place; no validation runs after the mutation. */
function assignRewrite(event: ToolCallEvent, command: string): void {
  if (!isShellCall(event)) {
    return;
  }

  event.input.command = command;
}

/** Runs `toolBefore` and returns Pi's block result for a deny. */
function handleToolCall(
  slot: HostSlot,
  registration: Registration,
  event: ToolCallEvent,
  sessionId: string,
): ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined> {
  if (!slot.isLeader(registration)) {
    return undefined;
  }

  const ctx: HookContext = { agent: "pi", sessionId };
  const call = callOf(event);

  return run(runToolBefore(slot.plugins(registration.scope), call, ctx)).then((decision) =>
    ToolDecision.$match(decision, {
      Allow: (value) => {
        if (value.rewritten && value.call.tool === "shell") {
          assignRewrite(event, value.call.input.command);
        }

        return undefined;
      },
      Deny: (value) => ({ block: true, reason: value.reason }),
    }),
  );
}

/** Runs `toolAfter` with the joined result text and its error flag. */
function handleToolResult(
  slot: HostSlot,
  registration: Registration,
  event: ToolResultEvent,
  sessionId: string,
): void | Promise<void> {
  if (!slot.isLeader(registration)) {
    return;
  }

  const ctx: HookContext = { agent: "pi", sessionId };
  const call = callOf(event);
  const result: ToolResult = { output: joinTextParts(event.content), isError: event.isError };

  return run(runToolAfter(slot.plugins(registration.scope), call, result, ctx));
}

/** Runs `promptSent` for user input; text tack produced is never transformed again. */
function handleInput(
  slot: HostSlot,
  registration: Registration,
  event: InputEvent,
  sessionId: string,
): InputEventResult | undefined | Promise<InputEventResult | undefined> {
  if (event.source === "extension" || !slot.isLeader(registration)) {
    return undefined;
  }

  const ctx: HookContext = { agent: "pi", sessionId };

  return run(runPromptSent(slot.plugins(registration.scope), { text: event.text }, ctx)).then(
    (append) =>
      append === undefined
        ? undefined
        : { action: "transform", text: `${event.text}\n\n${append}` },
  );
}

/** Registers one plugin's hooks for the process scope. */
function attach(plugin: ResolvedPlugin, pi: ExtensionAPI): void {
  // Pi's factory is synchronous, so the pure slot lookup runs here.
  const slot: HostSlot = Effect.runSync(hostSlot());
  const registration = slot.register(PI_SCOPE, plugin);

  const offs: Array<() => void> = [
    pi.on("tool_call", (event, ctx) =>
      handleToolCall(slot, registration, event, ctx.sessionManager.getSessionId()),
    ),
    pi.on("tool_result", (event, ctx) =>
      handleToolResult(slot, registration, event, ctx.sessionManager.getSessionId()),
    ),
    pi.on("input", (event, ctx) =>
      handleInput(slot, registration, event, ctx.sessionManager.getSessionId()),
    ),
  ];

  offs.push(
    pi.on("session_shutdown", () => {
      registration.dispose();

      for (const off of offs) {
        off();
      }
    }),
  );
}

/** Wraps one resolved definition as a Pi extension factory. */
export function piExtension(plugin: ResolvedPlugin): PiExtension {
  return (pi) => attach(plugin, pi);
}
