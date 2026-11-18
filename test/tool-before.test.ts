import { expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import type { ResolvedPlugin } from "../src/plugin.ts";
import type {
  HookContext,
  ToolBeforeResult,
  ToolCall,
  ToolDecision,
} from "../src/hooks/tool-before.ts";
import { ToolDecision as Decision, runToolBefore } from "../src/hooks/tool-before.ts";
import type { ToolPort, ToolRegistry } from "../src/tools/registry.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { CompiledTool, ToolDefinition } from "../src/tools/tool.ts";
import { compileTools, invokeTool, tool } from "../src/tools/tool.ts";
import { noTools, sessionFor } from "./helpers.ts";

const ctx: HookContext = {
  agent: "opencode",
  sessionId: "session-1",
  session: sessionFor("s1"),
  tools: noTools(),
};

const shellCall: ToolCall = {
  tool: "shell",
  name: "shell",
  dialect: "posix",
  input: { command: "git push origin main" },
};

const otherCall: ToolCall = { tool: "other", name: "read", input: { path: "notes.md" } };

function plugin(definition: Partial<ResolvedPlugin> & { readonly name: string }): ResolvedPlugin {
  return {
    priority: 100,
    budgetMs: 5000,
    toolBeforeOnError: "deny",
    permissionAskedOnError: "leave",
    toolBefore: undefined,
    promptSent: undefined,
    toolAfter: undefined,
    sessionCreated: undefined,
    sessionEnded: undefined,
    responseFinished: undefined,
    sessionIdle: undefined,
    permissionAsked: undefined,
    tools: [],
    ...definition,
  };
}

function appendTo(command: string, suffix: string): ToolBeforeResult {
  return { rewrite: { command: `${command}${suffix}` } };
}

const safePush = plugin({
  name: "safe-push",
  priority: 10,
  toolBefore: (call) =>
    call.tool === "shell" ? appendTo(call.input.command, " --dry-run") : undefined,
});

const signedPush = plugin({
  name: "signed-push",
  priority: 20,
  toolBefore: (call) =>
    call.tool === "shell" ? appendTo(call.input.command, " --signed") : undefined,
});

/** A port that keeps nothing: these tests only look a tool up. */
function quietPort(): ToolPort {
  return {
    install: () => undefined,
    withdraw: () => undefined,
    settled: () => Promise.resolve(),
  };
}

/** The one tool a definition compiles to. */
function compileOne(definition: ToolDefinition): CompiledTool {
  const [first] = Effect.runSync(compileTools("test", { [definition.name]: definition }, true));

  if (first === undefined) {
    throw new Error("the definition compiled no tool");
  }

  return first;
}

/** A registry holding one compiled tool, so a whole-input rewrite has a schema to decode. */
function registryWith(definition: ToolDefinition): ToolRegistry {
  return createToolRegistry(
    { plugin: "test", scope: "test", source: "test", hasSession: true, port: quietPort() },
    [compileOne(definition)],
  );
}

/** A guard's registry: no tools of its own, and one another plugin holds. */
function guardRegistry(held: CompiledTool): ToolRegistry {
  return createToolRegistry(
    {
      plugin: "guard",
      scope: "test",
      source: "guard",
      hasSession: true,
      port: quietPort(),
      elsewhere: () => held,
    },
    [],
  );
}

/** The tool a rewrite targets, recording the key its handler saw. */
function monitorTool(seen: string[]): ToolDefinition {
  return tool<{ key: string }>({
    name: "monitor_create",
    description: "Start watching a Jira issue",
    input: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
    run: (input) => {
      seen.push(input.key);

      return { content: [`watching ${input.key}`] };
    },
  });
}

/** The one tool a registry must hold, or a failure naming what went wrong. */
function heldTool(tools: ToolRegistry, name: string) {
  const found = tools.get(name);

  if (found === undefined) {
    throw new Error(`the registry holds no tool named ${name}`);
  }

  return found;
}

function allowOf(decision: ToolDecision) {
  return Decision.$match(decision, {
    Allow: (value) => value,
    Deny: (value) => {
      throw new Error(`expected Allow, got Deny: ${value.reason}`);
    },
  });
}

function denyOf(decision: ToolDecision) {
  return Decision.$match(decision, {
    Allow: (value) => {
      throw new Error(`expected Deny, got Allow: ${JSON.stringify(value.call)}`);
    },
    Deny: (value) => value,
  });
}

it.effect("chains rewrites in priority order whatever the array order", () =>
  Effect.gen(function* () {
    const forward = allowOf(yield* runToolBefore([safePush, signedPush], shellCall, ctx));
    const reversed = allowOf(yield* runToolBefore([signedPush, safePush], shellCall, ctx));

    expect(forward.call.input).toEqual({
      command: "git push origin main --dry-run --signed",
    });
    expect(forward.rewritten).toBe(true);
    expect(reversed.call).toEqual(forward.call);
    expect(reversed.rewritten).toBe(true);
  }),
);

it.effect("lets the first deny win and skips later plugins", () =>
  Effect.gen(function* () {
    let laterCalls = 0;

    const denyAll = plugin({
      name: "deny-all",
      priority: 10,
      toolBefore: () => ({ deny: "push is blocked" }),
    });

    const later = plugin({
      name: "later",
      priority: 20,
      toolBefore: () => {
        laterCalls += 1;

        return undefined;
      },
    });

    const decision = denyOf(yield* runToolBefore([later, denyAll], shellCall, ctx));

    expect(decision.reason).toBe("push is blocked");
    expect(laterCalls).toBe(0);
  }),
);

it.effect("denies by default when a handler throws", () =>
  Effect.gen(function* () {
    const broken = plugin({
      name: "broken",
      toolBefore: () => {
        throw new Error("boom");
      },
    });

    const decision = denyOf(yield* runToolBefore([broken], shellCall, ctx));

    expect(decision.reason).toBe("tack: broken failed: boom");
  }),
);

it.effect("continues when the plugin opted into allow", () =>
  Effect.gen(function* () {
    const broken = plugin({
      name: "broken",
      priority: 10,
      toolBeforeOnError: "allow",
      toolBefore: () => {
        throw new Error("boom");
      },
    });

    const decision = allowOf(yield* runToolBefore([broken, safePush], shellCall, ctx));

    expect(decision.call.input).toEqual({ command: "git push origin main --dry-run" });
    expect(decision.rewritten).toBe(true);
  }),
);

it.effect("denies a handler that misses its budget", () =>
  Effect.gen(function* () {
    const stalled = plugin({
      name: "stalled",
      budgetMs: 250,
      toolBefore: () => Promise.race([]),
    });

    const fiber = yield* runToolBefore([stalled], shellCall, ctx).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.millis(250));

    const decision = denyOf(yield* Fiber.join(fiber));

    expect(decision.reason).toBe("tack: stalled failed: timed out after 250 ms");
  }),
);

it.effect("denies a handler that returns an invalid result", () =>
  Effect.gen(function* () {
    const invalid: ToolBeforeResult = JSON.parse('{"deny":42}');
    const confused = plugin({ name: "confused", toolBefore: () => invalid });

    const decision = denyOf(yield* runToolBefore([confused], shellCall, ctx));

    expect(decision.reason).toBe("tack: confused failed: returned an invalid result");
  }),
);

it.effect("rewrites a tack tool's whole input and runs the handler with it", () =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const tools = registryWith(monitorTool(seen));

    const rewriting = plugin({
      name: "rewriting",
      toolBefore: (call) =>
        call.name === "monitor_create" ? { rewrite: { input: { key: "PROJ-2" } } } : undefined,
    });

    const call: ToolCall = {
      tool: "other",
      name: "monitor_create",
      input: { key: "PROJ-1" },
    };

    const decision = allowOf(yield* runToolBefore([rewriting], call, { ...ctx, tools }));

    expect(decision.rewritten).toBe(true);

    const result = yield* invokeTool(
      heldTool(tools, "monitor_create"),
      { input: decision.call.input },
      { callId: "call-1", signal: undefined, session: ctx.session, tools },
    );

    expect(result).toEqual({ content: ["watching PROJ-2"] });
    expect(seen).toEqual(["PROJ-2"]);
  }),
);

it.effect("rewrites another plugin's tool through the scope lookup", () =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const held = compileOne(monitorTool(seen));
    const tools = guardRegistry(held);

    const rewriting = plugin({
      name: "rewriting",
      toolBefore: () => ({ rewrite: { input: { key: "PROJ-2" } } }),
    });

    const call: ToolCall = {
      tool: "other",
      name: "monitor_create",
      input: { key: "PROJ-1" },
    };

    const decision = allowOf(yield* runToolBefore([rewriting], call, { ...ctx, tools }));

    expect(decision.rewritten).toBe(true);

    const result = yield* invokeTool(
      held,
      { input: decision.call.input },
      { callId: "call-1", signal: undefined, session: ctx.session, tools },
    );

    expect(result).toEqual({ content: ["watching PROJ-2"] });
    expect(seen).toEqual(["PROJ-2"]);
  }),
);

it.effect(
  "decodes a rewritten input before the handler runs, refusing one the schema rejects",
  () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const tools = registryWith(monitorTool(seen));

      const rewriting = plugin({
        name: "rewriting",
        toolBefore: () => ({ rewrite: { input: { key: 42 } } }),
      });

      const call: ToolCall = {
        tool: "other",
        name: "monitor_create",
        input: { key: "PROJ-1" },
      };

      const decision = allowOf(yield* runToolBefore([rewriting], call, { ...ctx, tools }));

      const result = yield* invokeTool(
        heldTool(tools, "monitor_create"),
        { input: decision.call.input },
        { callId: "call-1", signal: undefined, session: ctx.session, tools },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toContain('at ["key"]');
      expect(seen).toEqual([]);
    }),
);

it.effect("denies a rewrite that names both forms", () =>
  Effect.gen(function* () {
    const both: ToolBeforeResult = JSON.parse('{"rewrite":{"command":"ls","input":{"key":"x"}}}');

    const confused = plugin({ name: "confused", toolBefore: () => both });

    const decision = denyOf(yield* runToolBefore([confused], shellCall, ctx));

    expect(decision.reason).toBe(
      "tack: confused failed: a rewrite carries either a command or an input, not both",
    );
  }),
);

it.effect("denies a command rewrite on a call that is not the shell tool, naming it", () =>
  Effect.gen(function* () {
    const rewriting = plugin({
      name: "rewriting",
      toolBefore: () => ({ rewrite: { command: "ls" } }),
    });

    const decision = denyOf(yield* runToolBefore([rewriting], otherCall, ctx));

    expect(decision.reason).toBe(
      'tack: rewriting failed: a command rewrite applies only to the shell tool, not "read"',
    );
  }),
);

it.effect("denies an input rewrite on the shell tool", () =>
  Effect.gen(function* () {
    const rewriting = plugin({
      name: "rewriting",
      toolBefore: () => ({ rewrite: { input: { command: "ls" } } }),
    });

    const decision = denyOf(yield* runToolBefore([rewriting], shellCall, ctx));

    expect(decision.reason).toBe(
      "tack: rewriting failed: an input rewrite applies only to a tool tack defines, not the shell",
    );
  }),
);

it.effect("denies an input rewrite of a tool this plugin does not define, naming it", () =>
  Effect.gen(function* () {
    const rewriting = plugin({
      name: "rewriting",
      toolBefore: () => ({ rewrite: { input: { path: "notes.md" } } }),
    });

    const decision = denyOf(yield* runToolBefore([rewriting], otherCall, ctx));

    expect(decision.reason).toBe(
      'tack: rewriting failed: an input rewrite applies only to a tool this plugin defines, and "read" is not one',
    );
  }),
);

it.effect("reports no rewrite when every handler declines", () =>
  Effect.gen(function* () {
    const quiet = plugin({ name: "quiet", toolBefore: () => undefined });

    const decision = allowOf(yield* runToolBefore([quiet], shellCall, ctx));

    expect(decision.call).toEqual(shellCall);
    expect(decision.rewritten).toBe(false);
  }),
);

it.effect("leaves a call alone when no plugin has a toolBefore handler", () =>
  Effect.gen(function* () {
    const decision = allowOf(yield* runToolBefore([plugin({ name: "empty" })], shellCall, ctx));

    expect(decision.call).toEqual(shellCall);
    expect(decision.rewritten).toBe(false);
  }),
);
