import { afterEach, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ResolvedPlugin } from "../src/plugin.ts";
import { HOST_KEY, ProtocolMismatch, hostSlot } from "../src/host/host.ts";

interface ForeignEntry {
  readonly token: symbol;
  readonly plugin: ResolvedPlugin;
}

const safePush: ResolvedPlugin = {
  name: "safe-push",
  priority: 10,
  budgetMs: 5000,
  toolBeforeOnError: "deny",
  toolBefore: undefined,
  promptSent: undefined,
  toolAfter: undefined,
};

const safePushReplacement: ResolvedPlugin = { ...safePush, priority: 5 };

const signedPush: ResolvedPlugin = { ...safePush, name: "signed-push", priority: 20 };

afterEach(() => {
  Reflect.deleteProperty(globalThis, HOST_KEY);
});

it.effect("creates the slot and reuses it on the next call", () =>
  Effect.gen(function* () {
    const first = yield* hostSlot();
    const second = yield* hostSlot();

    first.register("opencode:/app", safePush);

    expect(second.plugins("opencode:/app").map((plugin) => plugin.name)).toEqual(["safe-push"]);
  }),
);

it.effect("uses a foreign plain slot at the same protocol", () =>
  Effect.gen(function* () {
    const foreign = { protocol: 1, scopes: new Map<string, Array<ForeignEntry>>() };

    Reflect.set(globalThis, HOST_KEY, foreign);

    const slot = yield* hostSlot();

    slot.register("pi", safePush);

    expect(foreign.scopes.get("pi")?.map((entry) => entry.plugin.name)).toEqual(["safe-push"]);
    expect(slot.plugins("pi")).toHaveLength(1);
  }),
);

it.effect("refuses another protocol and names both versions", () =>
  Effect.gen(function* () {
    Reflect.set(globalThis, HOST_KEY, { protocol: 2, scopes: new Map() });

    const error = yield* Effect.flip(hostSlot());

    expect(error).toBeInstanceOf(ProtocolMismatch);
    expect(error.message).toContain("uses host protocol 2");
    expect(error.message).toContain("this one uses 1");
  }),
);

it.effect("replaces a plugin by name in place", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();
    const stale = slot.register("scope", safePush);

    slot.register("scope", signedPush);

    const current = slot.register("scope", safePushReplacement);

    expect(slot.plugins("scope").map((plugin) => plugin.name)).toEqual([
      "safe-push",
      "signed-push",
    ]);
    expect(slot.isLeader(current)).toBe(true);
    expect(slot.isLeader(stale)).toBe(false);
  }),
);

it.effect("hands leadership to the next registration on dispose", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();
    const first = slot.register("scope", safePush);
    const second = slot.register("scope", signedPush);

    expect(slot.isLeader(first)).toBe(true);
    expect(slot.isLeader(second)).toBe(false);

    first.dispose();

    expect(slot.isLeader(second)).toBe(true);
    expect(slot.plugins("scope").map((plugin) => plugin.name)).toEqual(["signed-push"]);
  }),
);

it.effect("ignores the dispose of a replaced registration", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();
    const stale = slot.register("scope", safePush);
    const current = slot.register("scope", safePushReplacement);

    stale.dispose();

    expect(slot.plugins("scope").map((plugin) => plugin.name)).toEqual(["safe-push"]);
    expect(slot.isLeader(current)).toBe(true);
  }),
);

it.effect("deletes an empty scope and recreates it on the next register", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();
    const registration = slot.register("scope", safePush);

    registration.dispose();

    expect(slot.plugins("scope")).toEqual([]);

    const again = slot.register("scope", safePush);

    expect(slot.isLeader(again)).toBe(true);
  }),
);
