import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ResolvedPlugin } from "../src/plugin.ts";
import {
  DuplicatePlugin,
  ForeignHostSlot,
  HOST_KEY,
  ProtocolMismatch,
  hostSlot,
} from "../src/host/host.ts";

const safePush: ResolvedPlugin = {
  name: "safe-push",
  priority: 10,
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

    yield* slot.register("pi", safePush, "/plugins/a.js");

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

    yield* first.register("create", safePush, "/plugins/a.js");

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

it.effect("refuses a second registration of a name in one scope", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();
    const first = yield* slot.register("duplicate", safePush, "/plugins/a.js");

    const error = yield* Effect.flip(
      slot.register("duplicate", safePushReplacement, "/plugins/b.js"),
    );

    expect(error).toBeInstanceOf(DuplicatePlugin);
    expect(error.message).toBe(
      'tack: two plugins named "safe-push" are loaded in duplicate (/plugins/a.js and /plugins/b.js); give them different names.',
    );
    expect(slot.plugins("duplicate")).toEqual([safePush]);
    expect(slot.isLeader(first)).toBe(true);
  }),
);

it.effect("registers a different name alongside the first in one scope", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();

    yield* slot.register("distinct", safePush, "/plugins/a.js");
    yield* slot.register("distinct", signedPush, "/plugins/b.js");

    expect(slot.plugins("distinct").map((plugin) => plugin.name)).toEqual([
      "safe-push",
      "signed-push",
    ]);
  }),
);

it.effect("freezes the slot so its scopes cannot be replaced", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, HOST_KEY);

    if (descriptor === undefined) {
      throw new Error("the host slot is not fixed at its symbol");
    }

    yield* slot.register("frozen", safePush, "/plugins/a.js");

    expect(Object.isFrozen(descriptor.value)).toBe(true);
    expect(() => {
      descriptor.value.scopes = new Map();
    }).toThrow(TypeError);
    expect(slot.plugins("frozen").map((plugin) => plugin.name)).toEqual(["safe-push"]);
  }),
);

it.effect("hands leadership to the next registration on dispose", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();
    const first = yield* slot.register("leader", safePush, "/plugins/a.js");
    const second = yield* slot.register("leader", signedPush, "/plugins/b.js");

    expect(slot.isLeader(first)).toBe(true);
    expect(slot.isLeader(second)).toBe(false);

    first.dispose();

    expect(slot.isLeader(second)).toBe(true);
    expect(slot.plugins("leader").map((plugin) => plugin.name)).toEqual(["signed-push"]);
  }),
);

it.effect("deletes an empty scope and recreates it on the next register", () =>
  Effect.gen(function* () {
    const slot = yield* hostSlot();
    const registration = yield* slot.register("empty", safePush, "/plugins/a.js");

    registration.dispose();

    expect(slot.plugins("empty")).toEqual([]);

    const again = yield* slot.register("empty", safePush, "/plugins/a.js");

    expect(slot.isLeader(again)).toBe(true);
  }),
);
