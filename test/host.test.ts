import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ResolvedPlugin } from "../src/plugin.ts";
import { ForeignHostSlot, HOST_KEY, ProtocolMismatch, hostSlot } from "../src/host/host.ts";

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

/** A value a case leaves at the host symbol: slot-shaped, or plainly not a slot. */
interface SlotCandidate {
  readonly protocol?: unknown;
  readonly scopes?: unknown;
}

/**
 * Puts a value at the host symbol before the slot exists. Only a case declared
 * before the slot is created can do this: `hostSlot` fixes the slot as
 * non-writable and non-configurable, so every later case shares that one slot
 * and keeps to its own scope.
 */
function installSlot(value: SlotCandidate | string): void {
  if (!Reflect.set(globalThis, HOST_KEY, value)) {
    throw new Error("the host slot is already fixed; these cases must run before it is created");
  }
}

/** Removes a value that a case expects to be refused. */
function clearSlot(): void {
  Reflect.deleteProperty(globalThis, HOST_KEY);
}

it.effect("uses a foreign plain slot at the same protocol", () =>
  Effect.gen(function* () {
    const foreign = { protocol: 1, scopes: new Map<string, unknown>() };

    installSlot(foreign);

    const slot = yield* hostSlot();

    slot.register("pi", safePush);

    expect([...foreign.scopes.keys()]).toEqual(["pi"]);
    expect(slot.plugins("pi").map((plugin) => plugin.name)).toEqual(["safe-push"]);

    clearSlot();
  }),
);

it.effect("refuses another protocol and names both versions", () =>
  Effect.gen(function* () {
    installSlot({ protocol: 2, scopes: new Map() });

    const error = yield* Effect.flip(hostSlot());

    expect(error).toBeInstanceOf(ProtocolMismatch);
    expect(error.message).toContain("uses host protocol 2");
    expect(error.message).toContain("this one uses 1");

    clearSlot();
  }),
);

it.effect("refuses an object with no scopes map as foreign", () =>
  Effect.gen(function* () {
    installSlot({ protocol: 1 });

    const error = yield* Effect.flip(hostSlot());

    expect(error).toBeInstanceOf(ForeignHostSlot);
    expect(error.message).toContain("something other than a tack host slot");
    expect(error.message).toContain('Symbol.for("@workhorse/tack/host")');

    clearSlot();
  }),
);

it.effect("refuses a scope whose value is not a map as foreign", () =>
  Effect.gen(function* () {
    installSlot({ protocol: 1, scopes: new Map([["pi", ["safe-push"]]]) });

    const error = yield* Effect.flip(hostSlot());

    expect(error).toBeInstanceOf(ForeignHostSlot);
    expect(error.message).toContain("something other than a tack host slot");
    expect(error.message).toContain('Symbol.for("@workhorse/tack/host")');

    clearSlot();
  }),
);

it.effect("refuses a plain value at the host symbol as foreign", () =>
  Effect.gen(function* () {
    installSlot("not a tack slot");

    const error = yield* Effect.flip(hostSlot());

    expect(error).toBeInstanceOf(ForeignHostSlot);
    expect(error.message).toContain("something other than a tack host slot");

    clearSlot();
  }),
);

it.effect("creates the slot and reuses it on the next call", () =>
  Effect.gen(function* () {
    const first = yield* hostSlot();
    const second = yield* hostSlot();

    first.register("create", safePush);

    expect(second.plugins("create").map((plugin) => plugin.name)).toEqual(["safe-push"]);
  }),
);

it.effect("fixes the slot so no later copy can replace it", () =>
  Effect.gen(function* () {
    yield* hostSlot();

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, HOST_KEY);

    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(() =>
      Object.defineProperty(globalThis, HOST_KEY, { value: {}, configurable: true }),
    ).toThrow(TypeError);
  }),
);

it.effect("keeps a name's position when it is registered again", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();
    const stale = slot.register("replace", safePush);

    slot.register("replace", signedPush);

    const current = slot.register("replace", safePushReplacement);

    expect(slot.plugins("replace").map((plugin) => plugin.name)).toEqual([
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
    const first = slot.register("leader", safePush);
    const second = slot.register("leader", signedPush);

    expect(slot.isLeader(first)).toBe(true);
    expect(slot.isLeader(second)).toBe(false);

    first.dispose();

    expect(slot.isLeader(second)).toBe(true);
    expect(slot.plugins("leader").map((plugin) => plugin.name)).toEqual(["signed-push"]);
  }),
);

it.effect("removes only the disposed layer from its name", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();
    const stale = slot.register("layer", safePush);
    const current = slot.register("layer", safePushReplacement);

    stale.dispose();

    expect(slot.plugins("layer").map((plugin) => plugin.name)).toEqual(["safe-push"]);
    expect(slot.isLeader(current)).toBe(true);
    expect(slot.isLeader(stale)).toBe(false);
  }),
);

it.effect("restores the earlier registration when a same-named later one is disposed", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();
    const first = slot.register("restore", safePush);
    const second = slot.register("restore", safePushReplacement);

    expect(slot.plugins("restore").map((plugin) => plugin.name)).toEqual(["safe-push"]);
    expect(slot.isLeader(second)).toBe(true);
    expect(slot.isLeader(first)).toBe(false);

    second.dispose();

    expect(slot.isLeader(first)).toBe(true);

    first.dispose();

    expect(slot.plugins("restore")).toEqual([]);

    const third = slot.register("restore", safePush);

    expect(slot.plugins("restore").map((plugin) => plugin.name)).toEqual(["safe-push"]);
    expect(slot.isLeader(third)).toBe(true);
  }),
);

it.effect("deletes an empty scope and recreates it on the next register", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();
    const registration = slot.register("empty", safePush);

    registration.dispose();

    expect(slot.plugins("empty")).toEqual([]);

    const again = slot.register("empty", safePush);

    expect(slot.isLeader(again)).toBe(true);
  }),
);
