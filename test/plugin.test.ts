import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { PluginDefinition } from "../src/plugin.ts";
import { InvalidPlugin, resolvePlugin } from "../src/plugin.ts";

const invalidDefinitions: ReadonlyArray<PluginDefinition> = [
  { name: "Bad Name" },
  { name: "" },
  { name: "bad_name" },
  { name: "priority", priority: 1.5 },
  { name: "budget-floor", budgetMs: 0 },
  { name: "budget-ceiling", budgetMs: 60001 },
  { name: "budget-fraction", budgetMs: 1.5 },
];

describe("resolvePlugin", () => {
  it.effect("applies the documented defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolvePlugin({ name: "safe-push" });

      expect(resolved.name).toBe("safe-push");
      expect(resolved.priority).toBe(100);
      expect(resolved.budgetMs).toBe(5000);
      expect(resolved.toolBeforeOnError).toBe("deny");
      expect(resolved.permissionAskedOnError).toBe("leave");
      expect(resolved.toolBefore).toBeUndefined();
      expect(resolved.promptSent).toBeUndefined();
      expect(resolved.toolAfter).toBeUndefined();
      expect(resolved.sessionCreated).toBeUndefined();
      expect(resolved.sessionEnded).toBeUndefined();
      expect(resolved.responseFinished).toBeUndefined();
      expect(resolved.sessionIdle).toBeUndefined();
      expect(resolved.permissionAsked).toBeUndefined();
    }),
  );

  it.effect("keeps explicit values", () =>
    Effect.gen(function* () {
      const resolved = yield* resolvePlugin({
        name: "signed-push",
        priority: 20,
        budgetMs: 250,
        onError: { toolBefore: "allow", permissionAsked: "deny" },
      });

      expect(resolved.priority).toBe(20);
      expect(resolved.budgetMs).toBe(250);
      expect(resolved.toolBeforeOnError).toBe("allow");
      expect(resolved.permissionAskedOnError).toBe("deny");
    }),
  );

  it.effect("rejects each invalid definition and names the plugin", () =>
    Effect.gen(function* () {
      for (const definition of invalidDefinitions) {
        const error = yield* Effect.flip(resolvePlugin(definition));

        expect(error).toBeInstanceOf(InvalidPlugin);
        expect(error.plugin).toBe(definition.name);
        expect(error.message).toContain(`tack: plugin "${definition.name}" is invalid:`);
      }
    }),
  );

  it.effect("explains the broken rule", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resolvePlugin({ name: "Bad Name" }));

      expect(error.message).toBe('tack: plugin "Bad Name" is invalid: name must match [a-z0-9-]+');
    }),
  );
});
