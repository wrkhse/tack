import { Effect, Option, Predicate, Schema } from "effect";

import type { ResolvedPlugin } from "../plugin.ts";

/** The registered name the slot symbol is created from. */
const HOST_KEY_NAME = "@workhorse/tack/host";

/** The one symbol every copy of tack reads on `globalThis`. */
export const HOST_KEY = Symbol.for(HOST_KEY_NAME);

/** The host protocol version this copy of tack speaks. */
const HOST_PROTOCOL = 1;

interface HostEntry {
  readonly token: symbol;
  readonly plugin: ResolvedPlugin;
}

/** One name's live registrations, oldest first; the last is the definition in force. */
type NameStack = Array<HostEntry>;

/** The slot's plain shape. Only data and functions, never a class instance. */
interface HostSlotData {
  readonly protocol: number;
  readonly scopes: Map<string, Map<string, NameStack>>;
}

/** One plugin's live registration in a scope. */
export interface Registration {
  readonly scope: string;
  readonly token: symbol;
  readonly dispose: () => void;
}

/** The host slot an agent adapter reads and registers through. */
export interface HostSlot {
  readonly register: (scope: string, plugin: ResolvedPlugin) => Registration;
  readonly plugins: (scope: string) => ReadonlyArray<ResolvedPlugin>;
  readonly isLeader: (registration: Registration) => boolean;
}

/**
 * A slot written by another copy of tack under a protocol this one cannot
 * speak. Both versions are named so the fix is obvious.
 */
export class ProtocolMismatch extends Schema.TaggedError<
  ProtocolMismatch,
  { readonly brand: unique symbol }
>()("ProtocolMismatch", {
  found: Schema.Finite,
  expected: Schema.Finite,
}) {
  override get message(): string {
    return `tack: another tack plugin in this process uses host protocol ${this.found}; this one uses ${this.expected}. Rebuild the plugins with the same major version of @workhorse/tack.`;
  }
}

/**
 * A value at the host symbol that is not a tack slot at all: another plugin
 * framework's object, a hand-written one, or a plain value.
 */
export class ForeignHostSlot extends Schema.TaggedError<
  ForeignHostSlot,
  { readonly brand: unique symbol }
>()("ForeignHostSlot", {}) {
  override get message(): string {
    return `tack: something other than a tack host slot is set at Symbol.for("${HOST_KEY_NAME}"); delete it or load one major version of @workhorse/tack.`;
  }
}

/**
 * A slot's scopes map: one map per scope of that scope's name stacks. A scope
 * whose value is not a map cannot serve the reads below, so it is refused.
 */
const ScopesSchema = Schema.declare(
  (value): value is Map<string, Map<string, NameStack>> =>
    Predicate.isMap(value) && [...value.values()].every(Predicate.isMap),
);

/**
 * What has to hold before the value at the symbol is trusted: a finite
 * protocol number and the scopes map. A value that fails either is foreign.
 */
const SlotSchema = Schema.Struct({
  protocol: Schema.Finite,
  scopes: ScopesSchema,
});

type HostGlobal = {
  [key: symbol]: HostSlotData | undefined;
};

/**
 * The single, narrow globalThis access. The slot is the only symbol-keyed
 * property tack reads; its value is decoded before any of it is trusted.
 */
function hostGlobal(): HostGlobal {
  // SAFETY: globalThis always exists; the value read through the symbol is
  // decoded by `hostSlot` before any field of it is used.
  return globalThis;
}

/**
 * Adds a registration on top of its name's stack. A name already in the scope
 * keeps its position; only the definition in force for that name changes.
 */
function registerIn(data: HostSlotData, scope: string, plugin: ResolvedPlugin): symbol {
  const names = data.scopes.get(scope) ?? new Map<string, NameStack>();
  const stack = names.get(plugin.name) ?? [];
  const token = Symbol();

  stack.push({ token, plugin });
  names.set(plugin.name, stack);
  data.scopes.set(scope, names);

  return token;
}

/** Removes one registration; a name leaves the scope only when its stack empties. */
function disposeIn(data: HostSlotData, scope: string, token: symbol): void {
  const names = data.scopes.get(scope);

  if (names === undefined) {
    return;
  }

  for (const [name, stack] of names) {
    const index = stack.findIndex((entry) => entry.token === token);

    if (index === -1) {
      continue;
    }

    stack.splice(index, 1);

    if (stack.length === 0) {
      names.delete(name);
    }

    break;
  }

  if (names.size === 0) {
    data.scopes.delete(scope);
  }
}

/** One definition per name, the top of each stack, in first-registration order. */
function activeIn(data: HostSlotData, scope: string): ReadonlyArray<ResolvedPlugin> {
  const names = data.scopes.get(scope);

  if (names === undefined) {
    return [];
  }

  const active: Array<ResolvedPlugin> = [];

  for (const stack of names.values()) {
    const top = stack[stack.length - 1];

    if (top !== undefined) {
      active.push(top.plugin);
    }
  }

  return active;
}

/** True only for the top of the first name's stack: the earliest live registration. */
function leadsIn(data: HostSlotData, registration: Registration): boolean {
  const names = data.scopes.get(registration.scope);

  if (names === undefined) {
    return false;
  }

  const first = names.values().next();

  if (first.done) {
    return false;
  }

  const stack = first.value;
  const top = stack[stack.length - 1];

  return top !== undefined && top.token === registration.token;
}

/** Builds the slot API around one plain slot object. */
function slotOf(data: HostSlotData): HostSlot {
  const registrationFor = (scope: string, token: symbol): Registration => ({
    scope,
    token,
    dispose: () => disposeIn(data, scope, token),
  });

  return {
    register: (scope, plugin) => registrationFor(scope, registerIn(data, scope, plugin)),
    plugins: (scope) => activeIn(data, scope),
    isLeader: (registration) => leadsIn(data, registration),
  };
}

/**
 * Creates the slot and fixes it at the symbol. Every copy reads and mutates
 * this one slot; no later copy can replace or delete it, so registrations an
 * earlier copy holds cannot be silently detached.
 */
function createSlot(global: HostGlobal): HostSlotData {
  const created: HostSlotData = { protocol: HOST_PROTOCOL, scopes: new Map() };

  Object.defineProperty(global, HOST_KEY, {
    value: created,
    writable: false,
    configurable: false,
    enumerable: false,
  });

  return created;
}

/**
 * Gets or creates the process-wide host slot.
 *
 * A value that is not a tack slot fails the load instead of being used, and a
 * tack slot at another protocol is refused naming both versions, so two
 * incompatible tack copies never combine hook data by accident.
 */
export function hostSlot(): Effect.Effect<HostSlot, ProtocolMismatch | ForeignHostSlot> {
  return Effect.suspend((): Effect.Effect<HostSlot, ProtocolMismatch | ForeignHostSlot> => {
    const global = hostGlobal();
    const existing: unknown = global[HOST_KEY];

    if (existing === undefined) {
      return Effect.succeed(slotOf(createSlot(global)));
    }

    const decoded = Schema.decodeUnknownOption(SlotSchema)(existing);

    if (Option.isNone(decoded)) {
      return Effect.fail(new ForeignHostSlot());
    }

    const { protocol } = decoded.value;

    if (protocol !== HOST_PROTOCOL) {
      return Effect.fail(new ProtocolMismatch({ found: protocol, expected: HOST_PROTOCOL }));
    }

    return Effect.succeed(slotOf(decoded.value));
  });
}
