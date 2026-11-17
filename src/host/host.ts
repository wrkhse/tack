import { Effect, Option, Schema } from "effect";

import type { ResolvedPlugin } from "../plugin.ts";

/** The one symbol every copy of tack reads on `globalThis`. */
export const HOST_KEY = Symbol.for("@workhorse/tack/host");

/** The host protocol version this copy of tack speaks. */
const HOST_PROTOCOL = 1;

interface HostEntry {
  readonly token: symbol;
  readonly plugin: ResolvedPlugin;
}

/** The slot's plain shape. Only data and functions, never a class instance. */
interface HostSlotData {
  readonly protocol: number;
  readonly scopes: Map<string, Array<HostEntry>>;
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

const SlotProtocolSchema = Schema.Struct({ protocol: Schema.Finite });

type HostGlobal = {
  [key: symbol]: HostSlotData | undefined;
};

/**
 * The single, narrow globalThis access. The slot is the only symbol-keyed
 * property tack reads; its `protocol` field is decoded before it is trusted.
 */
function hostGlobal(): HostGlobal {
  // SAFETY: globalThis always exists and every tack copy writes this symbol
  // with the plain HostSlotData shape; the protocol is validated on read.
  return globalThis;
}

/** Builds the slot API around one plain slot object. */
function slotOf(data: HostSlotData): HostSlot {
  const registrationFor = (scope: string, token: symbol): Registration => ({
    scope,
    token,
    dispose: () => {
      const entries = data.scopes.get(scope);

      if (entries === undefined) {
        return;
      }

      const index = entries.findIndex((entry) => entry.token === token);

      if (index === -1) {
        return;
      }

      entries.splice(index, 1);

      if (entries.length === 0) {
        data.scopes.delete(scope);
      }
    },
  });

  const register = (scope: string, plugin: ResolvedPlugin): Registration => {
    const entries = data.scopes.get(scope) ?? [];
    const index = entries.findIndex((entry) => entry.plugin.name === plugin.name);
    const token = Symbol();
    const entry = { token, plugin };

    if (index === -1) {
      entries.push(entry);
    } else {
      entries[index] = entry;
    }

    data.scopes.set(scope, entries);

    return registrationFor(scope, token);
  };

  const plugins = (scope: string): ReadonlyArray<ResolvedPlugin> =>
    (data.scopes.get(scope) ?? []).map((entry) => entry.plugin);

  const isLeader = (registration: Registration): boolean => {
    const entries = data.scopes.get(registration.scope);

    if (entries === undefined) {
      return false;
    }

    const first = entries[0];

    return first !== undefined && first.token === registration.token;
  };

  return { register, plugins, isLeader };
}

/**
 * Gets or creates the process-wide host slot.
 *
 * A foreign slot at another protocol fails the load instead of being used, so
 * two incompatible tack copies never combine hook data by accident.
 */
export function hostSlot(): Effect.Effect<HostSlot, ProtocolMismatch> {
  return Effect.suspend(() => {
    const global = hostGlobal();
    const existing = global[HOST_KEY];

    if (existing === undefined) {
      const created = {
        protocol: HOST_PROTOCOL,
        scopes: new Map<string, Array<HostEntry>>(),
      };

      global[HOST_KEY] = created;

      return Effect.succeed(slotOf(created));
    }

    const decoded = Schema.decodeOption(SlotProtocolSchema)(existing);

    const protocol = Option.match(decoded, {
      onNone: () => 0,
      onSome: (value) => value.protocol,
    });

    if (protocol !== HOST_PROTOCOL) {
      return Effect.fail(new ProtocolMismatch({ found: protocol, expected: HOST_PROTOCOL }));
    }

    return Effect.succeed(slotOf(existing));
  });
}
