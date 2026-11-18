import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import type { SessionCreatedEvent, SessionEndedEvent } from "../src/hooks/lifecycle.ts";
import { runSessionCreated, runSessionEnded } from "../src/hooks/lifecycle.ts";
import type { HookContext } from "../src/hooks/tool-before.ts";
import { logCapture, noTools, resolvedPlugin, sessionFor } from "./helpers.ts";

const ctx: HookContext = {
  agent: "opencode",
  sessionId: "session-1",
  session: sessionFor("s1"),
  tools: noTools(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSessionCreated", () => {
  it.effect("calls every handler in priority order with resumed", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly name: string; readonly resumed: boolean }> = [];

      const later = resolvedPlugin({
        name: "later",
        priority: 20,
        sessionCreated: (event: SessionCreatedEvent) => {
          seen.push({ name: "later", resumed: event.resumed });
        },
      });

      const earlier = resolvedPlugin({
        name: "earlier",
        priority: 10,
        sessionCreated: (event: SessionCreatedEvent) => {
          seen.push({ name: "earlier", resumed: event.resumed });
        },
      });

      yield* runSessionCreated([later, earlier], { session: ctx.session, resumed: true }, ctx);

      expect(seen).toEqual([
        { name: "earlier", resumed: true },
        { name: "later", resumed: true },
      ]);
    }),
  );

  it.effect("keeps going after one handler fails", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const capture = logCapture();

      const broken = resolvedPlugin({
        name: "broken",
        priority: 10,
        sessionCreated: () => {
          throw new Error("boom");
        },
      });

      const good = resolvedPlugin({
        name: "good",
        priority: 20,
        sessionCreated: () => {
          seen.push("good");
        },
      });

      yield* runSessionCreated([broken, good], { session: ctx.session, resumed: false }, ctx).pipe(
        Effect.withLogger(capture.logger),
      );

      expect(seen).toEqual(["good"]);
      expect(
        capture.lines().filter((line) => line.includes("tack: broken failed: boom")),
      ).toHaveLength(1);
    }),
  );
});

describe("runSessionEnded", () => {
  it.effect("calls every handler in priority order with the reason", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly name: string; readonly reason: string }> = [];

      const later = resolvedPlugin({
        name: "later",
        priority: 20,
        sessionEnded: (event: SessionEndedEvent) => {
          seen.push({ name: "later", reason: event.reason });
        },
      });

      const earlier = resolvedPlugin({
        name: "earlier",
        priority: 10,
        sessionEnded: (event: SessionEndedEvent) => {
          seen.push({ name: "earlier", reason: event.reason });
        },
      });

      yield* runSessionEnded([later, earlier], { session: ctx.session, reason: "shutdown" }, ctx);

      expect(seen).toEqual([
        { name: "earlier", reason: "shutdown" },
        { name: "later", reason: "shutdown" },
      ]);
    }),
  );

  it.effect("keeps going after one handler fails", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const capture = logCapture();

      const broken = resolvedPlugin({
        name: "broken",
        priority: 10,
        sessionEnded: () => {
          throw new Error("boom");
        },
      });

      const good = resolvedPlugin({
        name: "good",
        priority: 20,
        sessionEnded: () => {
          seen.push("good");
        },
      });

      yield* runSessionEnded(
        [broken, good],
        { session: ctx.session, reason: "replaced" },
        ctx,
      ).pipe(Effect.withLogger(capture.logger));

      expect(seen).toEqual(["good"]);
      expect(
        capture.lines().filter((line) => line.includes("tack: broken failed: boom")),
      ).toHaveLength(1);
    }),
  );
});
