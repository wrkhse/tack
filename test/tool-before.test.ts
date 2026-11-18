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
import { sessionFor } from "./helpers.ts";

const ctx: HookContext = { agent: "opencode", sessionId: "session-1", session: sessionFor("s1") };

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

it.effect("denies a rewrite on a call that is not the shell tool", () =>
  Effect.gen(function* () {
    const rewriting = plugin({
      name: "rewriting",
      toolBefore: () => ({ rewrite: { command: "ls" } }),
    });

    const decision = denyOf(yield* runToolBefore([rewriting], otherCall, ctx));

    expect(decision.reason).toBe("tack: rewriting failed: rewrite applies only to the shell tool");
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
