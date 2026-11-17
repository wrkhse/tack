import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import type { PermissionRequest } from "../src/hooks/permission-asked.ts";
import { runPermissionAsked } from "../src/hooks/permission-asked.ts";
import type { HookContext } from "../src/hooks/tool-before.ts";
import { logCapture, resolvedPlugin, sessionFor } from "./helpers.ts";

const ctx: HookContext = { agent: "opencode", sessionId: "session-1", session: sessionFor("s1") };

const request: PermissionRequest = {
  sessionId: "s1",
  action: "shell",
  resources: ["git push origin main"],
  effect: "ask",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runPermissionAsked", () => {
  it.effect("takes the first deny in priority order and its reason", () =>
    Effect.gen(function* () {
      const later = resolvedPlugin({
        name: "later",
        priority: 20,
        permissionAsked: () => ({ deny: "later says no" }),
      });

      const earlier = resolvedPlugin({
        name: "earlier",
        priority: 10,
        permissionAsked: () => ({ deny: "earlier says no" }),
      });

      const result = yield* runPermissionAsked([later, earlier], request, ctx);

      expect(result).toEqual({ deny: "earlier says no" });
    }),
  );

  it.effect("allows when every answering handler allows", () =>
    Effect.gen(function* () {
      const first = resolvedPlugin({
        name: "first",
        priority: 10,
        permissionAsked: () => ({ allow: true }),
      });

      const second = resolvedPlugin({
        name: "second",
        priority: 20,
        permissionAsked: () => ({ allow: true }),
      });

      const result = yield* runPermissionAsked([first, second], request, ctx);

      expect(result).toEqual({ allow: true });
    }),
  );

  it.effect("leaves the decision to the agent when no handler answers", () =>
    Effect.gen(function* () {
      const silent = resolvedPlugin({
        name: "silent",
        permissionAsked: () => undefined,
      });

      const result = yield* runPermissionAsked([silent], request, ctx);

      expect(result).toBeUndefined();
    }),
  );
});

describe("runPermissionAsked failures", () => {
  it.effect("logs a failed handler and leaves the decision by default", () =>
    Effect.gen(function* () {
      const capture = logCapture();

      const broken = resolvedPlugin({
        name: "broken",
        permissionAsked: () => {
          throw new Error("boom");
        },
      });

      const allowing = resolvedPlugin({
        name: "allowing",
        priority: 20,
        permissionAsked: () => ({ allow: true }),
      });

      const result = yield* runPermissionAsked([broken, allowing], request, ctx).pipe(
        Effect.withLogger(capture.logger),
      );

      expect(result).toBeUndefined();
      expect(
        capture.lines().filter((line) => line.includes("tack: broken failed: boom")),
      ).toHaveLength(1);
    }),
  );

  it.effect("denies with the failure message when onError asks it to", () =>
    Effect.gen(function* () {
      const broken = resolvedPlugin({
        name: "broken",
        permissionAskedOnError: "deny",
        permissionAsked: () => {
          throw new Error("boom");
        },
      });

      const result = yield* runPermissionAsked([broken], request, ctx);

      expect(result).toEqual({ deny: "tack: broken failed: boom" });
    }),
  );
});
