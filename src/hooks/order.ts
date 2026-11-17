import type { ResolvedPlugin } from "../plugin.ts";

/**
 * Orders plugins for every hook: lower priority first, ties by name.
 *
 * The order is a total function of the definitions, so whichever plugin the
 * agent loads first cannot change how a hook combines.
 */
export function byPriority(a: ResolvedPlugin, b: ResolvedPlugin): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }

  if (a.name === b.name) {
    return 0;
  }

  return a.name < b.name ? -1 : 1;
}
