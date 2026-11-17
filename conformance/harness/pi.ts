import { join } from "node:path";

import { Effect, type Scope } from "effect";

import { standInModel } from "../model/stand-in.ts";
import { collectEvidence, type AgentRun, type Scenario } from "../scenarios.ts";
import { bundleScenarioPlugins } from "./bundle.ts";
import { runCommand } from "./run.ts";
import { sandbox, writeText } from "./sandbox.ts";

/** A Pi extension loaded with -e is one file. */
export const PLUGIN_FILE = "plugin.js";

/** Both scripted model ids, so `setModel` has a real target. */
const MODELS = [
  { id: "scripted", name: "Scripted" },
  { id: "scripted-2", name: "Scripted 2" },
];

const modelsJson = (baseUrl: string) => ({
  providers: {
    fake: {
      baseUrl,
      api: "openai-completions",
      apiKey: "fake-key",
      models: MODELS.map(({ id, name }) => ({
        id,
        name,
        reasoning: false,
        input: ["text"],
        contextWindow: 32768,
        maxTokens: 4096,
      })),
    },
  },
});

/** A scripted failure must end a turn; a retry would hide it behind a later answer. */
const settingsJson = () => ({ retry: { enabled: false } });

/** Writes the sandboxed Pi models file that serves both scripted ids, and its settings. */
export const writePiConfig = (dir: string, baseUrl: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* writeText(
      join(dir, "pi-agent", "models.json"),
      JSON.stringify(modelsJson(baseUrl), null, 2) + "\n",
    );
    yield* writeText(
      join(dir, "pi-agent", "settings.json"),
      JSON.stringify(settingsJson(), null, 2) + "\n",
    );
  });

const extensionArgs = (bundles: ReadonlyArray<string>): ReadonlyArray<string> =>
  bundles.flatMap((bundle) => ["-e", bundle]);

const piArgs = (bundles: ReadonlyArray<string>): ReadonlyArray<string> => [
  "-p",
  "--no-session",
  "--provider",
  "fake",
  "--model",
  "scripted",
  "-ns",
  "-np",
  "-nc",
  "--no-mcp",
  ...extensionArgs(bundles),
  "push it",
];

/**
 * Runs one scenario in the real Pi CLI: a fresh sandbox, the scripted model, one
 * bundle per plugin loaded with -e, and one print-mode run.
 */
export const runPiScenario = (scenario: Scenario): Effect.Effect<AgentRun, never, Scope.Scope> =>
  Effect.gen(function* () {
    const box = yield* sandbox;
    const model = yield* standInModel("bash");

    const bundles = yield* bundleScenarioPlugins(
      box.dir,
      scenario.plugins,
      "pi",
      PLUGIN_FILE,
      box.pi.env,
    );

    yield* writePiConfig(box.dir, model.baseUrl);

    const command = yield* runCommand({
      bin: box.pi.bin,
      args: piArgs(bundles),
      cwd: box.projectDir,
      env: box.pi.env,
    });

    return yield* collectEvidence(box, model, command);
  });
