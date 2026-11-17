import { appendFileSync } from "node:fs";

import { Config, Effect, Option } from "effect";

/**
 * Records that the module holding a plugin was evaluated, so a scenario proves
 * every plugin loaded and not merely that nothing contradicts it. The file is
 * one name per line, appended because a run holds one plugin per bundle. A run
 * without TACK_LOADED, such as a person loading the plugin by hand, records
 * nothing.
 */
export const markLoaded = (name: string): void => {
  const requested = Effect.runSync(Config.option(Config.String("TACK_LOADED")));
  const file = Option.getOrUndefined(requested);

  if (file === undefined) return;

  appendFileSync(file, name + "\n");
};

/** The names a marker file holds, in the order they were written. */
export const parseLoaded = (text: string): ReadonlyArray<string> =>
  text.split("\n").filter((line) => line.length > 0);
