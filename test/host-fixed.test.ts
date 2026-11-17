import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ForeignHostSlot, HOST_KEY, hostSlot } from "../src/host/host.ts";

/**
 * A property fixed at the symbol holding `undefined` cannot be removed, so this
 * case needs a global of its own. Its test file starts without a slot, and the
 * property it fixes stays for the rest of this file only.
 */
it.effect("refuses a fixed property holding undefined as foreign", () =>
  Effect.gen(function* () {
    Object.defineProperty(globalThis, HOST_KEY, {
      value: undefined,
      writable: false,
      configurable: false,
    });

    const error = yield* Effect.flip(hostSlot());

    expect(error).toBeInstanceOf(ForeignHostSlot);
    expect(error.message).toContain("something other than a tack host slot");
  }),
);
