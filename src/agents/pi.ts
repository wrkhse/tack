import { fileURLToPath } from "node:url";

import { Cause, Effect, Exit, Option, Predicate } from "effect";
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
import type { ResolvedPlugin } from "../plugin.ts";
import { runBefore } from "./chain.ts";
import { joinTextParts } from "./text.ts";

/** The scope every Pi extension in one process shares. */
const PI_SCOPE = "pi";

/**
 * The file this adapter was loaded from. Each plugin bundles its own copy of
 * tack, so under a bundle this names that plugin's bundle file.
 */
const SOURCE = fileURLToPath(import.meta.url);

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
function assignRewrite(event: ToolCallEvent, call: ToolCall): void {
  if (call.tool !== "shell" || !isShellCall(event)) {
    return;
  }

  event.input.command = call.input.command;
}

/** Runs `toolBefore` and returns Pi's block result for a deny. */
function handleToolCall(
  slot: HostSlot,
  registration: Registration,
  event: ToolCallEvent,
  sessionId: string,
): ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined> {
  return runBefore(
    slot,
    registration,
    callOf(event),
    { agent: "pi", sessionId },
    (reason) => ({ block: true, reason }),
    (call) => assignRewrite(event, call),
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

/** Registers in the process scope, throwing the duplicate's message instead. */
function registeredIn(slot: HostSlot, plugin: ResolvedPlugin): Registration {
  const exit = Effect.runSyncExit(slot.register(PI_SCOPE, plugin, SOURCE));

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  throw new Error(
    Option.match(Cause.findErrorOption(exit.cause), {
      onNone: () => "tack: plugin registration failed",
      onSome: (error) => error.message,
    }),
  );
}

/**
 * Registers one plugin's hooks for the process scope. Pi's factory is
 * synchronous, so the slot lookup and registration run here; a name already
 * live in the scope throws with the duplicate's message.
 */
function attach(plugin: ResolvedPlugin, pi: ExtensionAPI): void {
  const slot: HostSlot = Effect.runSync(hostSlot());
  const registration = registeredIn(slot, plugin);

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
