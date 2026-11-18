import { Effect, Option, Predicate, Schema } from "effect";

import type { ResolvedPlugin } from "../plugin.ts";
import type { CompiledTool } from "../tools/tool.ts";

/** The registered name the slot symbol is created from. */
const HOST_KEY_NAME = "@workhorse/tack/host";

/** The one symbol every copy of tack reads on `globalThis`. */
export const HOST_KEY = Symbol.for(HOST_KEY_NAME);

/** The host protocol version this copy of tack speaks. */
const HOST_PROTOCOL = 1;

/** One live registration, the only definition in force for its name in a scope. */
interface HostEntry {
  readonly token: symbol;
  readonly plugin: ResolvedPlugin;
  readonly source: string;
}

/** The slot's plain shape. Only data and functions, never a class instance. */
interface HostSlotData {
  readonly protocol: number;
  readonly scopes: Map<string, Map<string, HostEntry>>;
}

/**
 * A tool another plugin in the scope declares, by name. A guard's whole-input
 * rewrite asks this so it can rewrite a tool its own registry does not hold.
 */
export function scopedTool(
  slot: HostSlot,
  scope: string,
  plugin: string,
  name: string,
): CompiledTool | undefined {
  for (const other of slot.plugins(scope)) {
    if (other.name === plugin) {
      continue;
    }

    const found = other.tools.find((tool) => tool.name === name);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/** One plugin's live registration in a scope. */
export interface Registration {
  readonly scope: string;
  readonly token: symbol;
  readonly dispose: () => void;
}

/** The host slot an agent adapter reads and registers through. */
export interface HostSlot {
  readonly register: (
    scope: string,
    plugin: ResolvedPlugin,
    source: string,
  ) => Effect.Effect<Registration, DuplicatePlugin>;
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
 * A second live registration of a name in one scope. Two different plugins
 * cannot share a name, and a reload disposes before it registers again, so the
 * existing registration is never replaced silently.
 */
export class DuplicatePlugin extends Schema.TaggedError<
  DuplicatePlugin,
  { readonly brand: unique symbol }
>()("DuplicatePlugin", {
  name: Schema.String,
  scope: Schema.String,
  existing: Schema.String,
  incoming: Schema.String,
}) {
  override get message(): string {
    return `tack: two plugins named "${this.name}" are loaded in ${this.scope} (${this.existing} and ${this.incoming}); give them different names.`;
  }
}

/**
 * A slot's scopes map: one map per scope of that scope's live registrations. A
 * scope whose value is not a map cannot serve the reads below, so it is
 * refused.
 */
const ScopesSchema = Schema.declare(
  (value): value is Map<string, Map<string, HostEntry>> =>
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
 * Adds the scope's one live registration for a name. A name already in force in
 * the scope is refused, naming both sources: two plugins never share a name.
 */
function registerIn(
  data: HostSlotData,
  scope: string,
  plugin: ResolvedPlugin,
  source: string,
): Effect.Effect<Registration, DuplicatePlugin> {
  return Effect.suspend(() => {
    const names = data.scopes.get(scope) ?? new Map<string, HostEntry>();
    const existing = names.get(plugin.name);

    if (existing !== undefined) {
      return Effect.fail(
        new DuplicatePlugin({
          name: plugin.name,
          scope,
          existing: existing.source,
          incoming: source,
        }),
      );
    }

    const token = Symbol();

    names.set(plugin.name, { token, plugin, source });
    data.scopes.set(scope, names);

    return Effect.succeed({ scope, token, dispose: () => disposeIn(data, scope, token) });
  });
}

/** Removes one live registration; a token that is no longer live removes nothing. */
function disposeIn(data: HostSlotData, scope: string, token: symbol): void {
  const names = data.scopes.get(scope);

  if (names === undefined) {
    return;
  }

  for (const [name, entry] of names) {
    if (entry.token !== token) {
      continue;
    }

    names.delete(name);
    break;
  }

  if (names.size === 0) {
    data.scopes.delete(scope);
  }
}

/** One definition per name, in first-registration order. */
function activeIn(data: HostSlotData, scope: string): ReadonlyArray<ResolvedPlugin> {
  const names = data.scopes.get(scope);

  if (names === undefined) {
    return [];
  }

  return [...names.values()].map((entry) => entry.plugin);
}

/** True only for the earliest live registration in the scope: its leader. */
function leadsIn(data: HostSlotData, registration: Registration): boolean {
  const names = data.scopes.get(registration.scope);

  if (names === undefined) {
    return false;
  }

  const first = names.values().next();

  if (first.done) {
    return false;
  }

  return first.value.token === registration.token;
}

/** Builds the slot API around one plain slot object. */
function slotOf(data: HostSlotData): HostSlot {
  return {
    register: (scope, plugin, source) => registerIn(data, scope, plugin, source),
    plugins: (scope) => activeIn(data, scope),
    isLeader: (registration) => leadsIn(data, registration),
  };
}

/**
 * Creates the slot and fixes it at the symbol. Every copy reads and mutates
 * this one slot; no later copy can replace or delete it, so registrations an
 * earlier copy holds cannot be silently detached. The slot object is frozen
 * too, so assigning `scopes` cannot split the process's registrations.
 */
function createSlot(global: HostGlobal): Effect.Effect<HostSlotData, ForeignHostSlot> {
  const created: HostSlotData = Object.freeze({ protocol: HOST_PROTOCOL, scopes: new Map() });

  try {
    Object.defineProperty(global, HOST_KEY, {
      value: created,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch {
    // A non-extensible globalThis, or a property fixed another way, cannot
    // hold tack's slot; that is a foreign value like any other.
    return Effect.fail(new ForeignHostSlot());
  }

  return Effect.succeed(created);
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

    if (!(HOST_KEY in global)) {
      return Effect.map(createSlot(global), slotOf);
    }

    const decoded = Schema.decodeUnknownOption(SlotSchema)(global[HOST_KEY]);

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
