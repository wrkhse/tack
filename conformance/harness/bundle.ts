import { dirname, join } from "node:path";

import { Effect } from "effect";

import type { AgentName, PluginName } from "../scenarios.ts";
import { runCommand } from "./run.ts";
import { ensureDirectory, repoRoot } from "./sandbox.ts";

/**
 * Bundles one plugin entry with Bun. Every entry gets its own bundle, so every
 * plugin carries its own copy of tack and the host slot is proven across copies.
 */
const bundleEntry = (
  entry: string,
  outfile: string,
  env: Readonly<Record<string, string>>,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    yield* ensureDirectory(dirname(outfile));

    const result = yield* runCommand({
      bin: "bun",
      args: ["build", entry, "--target=node", "--format=esm", "--outfile", outfile],
      cwd: repoRoot,
      env,
    });

    if (result.exitCode !== 0) {
      return yield* Effect.die(
        new Error("tack-conformance: bundling " + entry + " failed: " + result.stderr),
      );
    }

    return outfile;
  });

/**
 * Bundles every plugin of one scenario for one agent, in the scenario load
 * order, and returns the bundle files.
 */
export const bundleScenarioPlugins = (
  dir: string,
  plugins: ReadonlyArray<PluginName>,
  agent: AgentName,
  filename: string,
  env: Readonly<Record<string, string>>,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.forEach(plugins, (name) => {
    const entry = join(repoRoot, "conformance", "plugins", "entries", name + "." + agent + ".ts");

    return bundleEntry(entry, join(dir, "plugins", name, filename), env);
  });
