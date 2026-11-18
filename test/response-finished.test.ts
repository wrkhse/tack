import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import type { ResponseReason } from "../src/hooks/response-finished.ts";
import { runResponseFinished } from "../src/hooks/response-finished.ts";
import type { HookContext } from "../src/hooks/tool-before.ts";
import { logCapture, noTools, resolvedPlugin, sessionFor } from "./helpers.ts";

const ctx: HookContext = {
  agent: "pi",
  sessionId: "session-1",
  session: sessionFor("s1"),
  tools: noTools(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runResponseFinished", () => {
  it.effect("reaches the handler with each reason", () =>
    Effect.gen(function* () {
      const seen: ResponseReason[] = [];

      const observe = resolvedPlugin({
        name: "observe",
        responseFinished: (event) => {
          seen.push(event.reason);
        },
      });

      for (const reason of ["done", "aborted", "error"] as const) {
        yield* runResponseFinished([observe], { session: ctx.session, reason }, ctx);
      }

      expect(seen).toEqual(["done", "aborted", "error"]);
    }),
  );

  it.effect("keeps going after one handler fails", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const capture = logCapture();

      const broken = resolvedPlugin({
        name: "broken",
        priority: 10,
        responseFinished: () => {
          throw new Error("boom");
        },
      });

      const good = resolvedPlugin({
        name: "good",
        priority: 20,
        responseFinished: () => {
          seen.push("good");
        },
      });

      yield* runResponseFinished(
        [broken, good],
        { session: ctx.session, reason: "done" },
        ctx,
      ).pipe(Effect.withLogger(capture.logger));

      expect(seen).toEqual(["good"]);
      expect(
        capture.lines().filter((line) => line.includes("tack: broken failed: boom")),
      ).toHaveLength(1);
    }),
  );
});
