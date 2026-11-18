import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ResolvedPlugin } from "../src/plugin.ts";
import type { HookContext } from "../src/hooks/tool-before.ts";
import type { Prompt } from "../src/hooks/prompt-sent.ts";
import { APPEND_CAP_BYTES, runPromptSent } from "../src/hooks/prompt-sent.ts";
import { noTools, sessionFor } from "./helpers.ts";

const ctx: HookContext = {
  agent: "pi",
  sessionId: "session-1",
  session: sessionFor("s1"),
  tools: noTools(),
};

const prompt: Prompt = { text: "push it" };

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

function appending(name: string, priority: number, append: string): ResolvedPlugin {
  return plugin({ name, priority, promptSent: () => ({ append }) });
}

describe("runPromptSent", () => {
  it.effect("joins appends in priority order with a blank line", () =>
    Effect.gen(function* () {
      const later = appending("later-note", 20, "second");
      const earlier = appending("earlier-note", 10, "first");

      const text = yield* runPromptSent([later, earlier], prompt, ctx);

      expect(text).toBe("first\n\nsecond");
    }),
  );

  it.effect("keeps identical texts once", () =>
    Effect.gen(function* () {
      const first = appending("first-note", 10, "same");
      const second = appending("second-note", 20, "same");

      const text = yield* runPromptSent([first, second], prompt, ctx);

      expect(text).toBe("same");
    }),
  );

  it.effect("drops an append that would pass the byte cap", () =>
    Effect.gen(function* () {
      const atCap = appending("at-cap", 10, "a".repeat(APPEND_CAP_BYTES));
      const overCap = appending("over-cap", 20, "b");

      const text = yield* runPromptSent([atCap, overCap], prompt, ctx);

      expect(text).toBe("a".repeat(APPEND_CAP_BYTES));
    }),
  );

  it.effect("skips a failing handler and keeps the other appends", () =>
    Effect.gen(function* () {
      const broken = plugin({
        name: "broken",
        priority: 10,
        promptSent: () => {
          throw new Error("boom");
        },
      });

      const good = appending("good-note", 20, "keep pushing");

      const text = yield* runPromptSent([broken, good], prompt, ctx);

      expect(text).toBe("keep pushing");
    }),
  );

  it.effect("ignores empty appends and returns undefined when nothing remains", () =>
    Effect.gen(function* () {
      const empty = appending("empty", 10, "");

      expect(yield* runPromptSent([empty], prompt, ctx)).toBeUndefined();
    }),
  );
});
