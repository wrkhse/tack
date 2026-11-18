import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import { runSessionIdle } from "../src/hooks/session-idle.ts";
import type { HookContext } from "../src/hooks/tool-before.ts";
import { logCapture, resolvedPlugin, sessionFor } from "./helpers.ts";

const ctx: HookContext = { agent: "pi", sessionId: "session-1", session: sessionFor("s1") };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSessionIdle", () => {
  it.effect("calls the handler once with the idle session", () =>
    Effect.gen(function* () {
      const seen: string[] = [];

      const observe = resolvedPlugin({
        name: "observe",
        sessionIdle: (event) => {
          seen.push(event.session.id);
        },
      });

      yield* runSessionIdle([observe], { session: ctx.session }, ctx);

      expect(seen).toEqual(["s1"]);
    }),
  );

  it.effect("logs a failure without stopping the other handlers", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const capture = logCapture();

      const broken = resolvedPlugin({
        name: "broken",
        priority: 10,
        sessionIdle: () => {
          throw new Error("boom");
        },
      });

      const good = resolvedPlugin({
        name: "good",
        priority: 20,
        sessionIdle: () => {
          seen.push("good");
        },
      });

      yield* runSessionIdle([broken, good], { session: ctx.session }, ctx).pipe(
        Effect.withLogger(capture.logger),
      );

      expect(seen).toEqual(["good"]);
      expect(
        capture.lines().filter((line) => line.includes("tack: broken failed: boom")),
      ).toHaveLength(1);
    }),
  );
});
