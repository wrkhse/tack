import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ResolvedPlugin } from "../src/plugin.ts";
import type { HookContext, ToolCall } from "../src/hooks/tool-before.ts";
import type { ToolResult } from "../src/hooks/tool-after.ts";
import { runToolAfter } from "../src/hooks/tool-after.ts";

const ctx: HookContext = { agent: "opencode", sessionId: "session-1" };

const call: ToolCall = {
  tool: "shell",
  name: "shell",
  dialect: "posix",
  input: { command: "git push origin main" },
};

const result: ToolResult = { output: "pushed", isError: false };

function plugin(definition: Partial<ResolvedPlugin> & { readonly name: string }): ResolvedPlugin {
  return {
    priority: 100,
    budgetMs: 5000,
    toolBeforeOnError: "deny",
    toolBefore: undefined,
    promptSent: undefined,
    toolAfter: undefined,
    ...definition,
  };
}

describe("runToolAfter", () => {
  it.effect("calls every handler in priority order", () =>
    Effect.gen(function* () {
      const seen: string[] = [];

      const later = plugin({
        name: "later",
        priority: 20,
        toolAfter: (givenCall, givenResult) => {
          seen.push(`later:${givenCall.tool}:${givenResult.output}`);
        },
      });

      const earlier = plugin({
        name: "earlier",
        priority: 10,
        toolAfter: () => {
          seen.push("earlier");
        },
      });

      yield* runToolAfter([later, earlier], call, result, ctx);

      expect(seen).toEqual(["earlier", "later:shell:pushed"]);
    }),
  );

  it.effect("keeps going after one handler fails", () =>
    Effect.gen(function* () {
      const seen: string[] = [];

      const broken = plugin({
        name: "broken",
        priority: 10,
        toolAfter: () => {
          throw new Error("boom");
        },
      });

      const good = plugin({
        name: "good",
        priority: 20,
        toolAfter: () => {
          seen.push("good");
        },
      });

      yield* runToolAfter([broken, good], call, result, ctx);

      expect(seen).toEqual(["good"]);
    }),
  );
});
