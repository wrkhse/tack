import { dirname, join } from "node:path";

import { Effect, type Scope } from "effect";

import { standInModel, type StandIn, type StandInOptions } from "../model/stand-in.ts";
import { collectEvidence, type AgentRun, type PluginName, type Scenario } from "../scenarios.ts";
import { bundleScenarioPlugins } from "./bundle.ts";
import { runCommand } from "./run.ts";
import { sandbox, writeText, type Sandbox } from "./sandbox.ts";

/** An OpenCode plugin is a directory whose entry file is index.js. */
const PLUGIN_FILE = "index.js";

/** One scripted model. Two ids are served, so `setModel` has a real target. */
const modelEntry = () => ({
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  limit: { context: 32768, output: 4096 },
});

const projectConfig = (pluginDirectories: ReadonlyArray<string>, baseUrl: string) => ({
  $schema: "https://opencode.ai/config.json",
  model: "fake/scripted",
  update: "disable",
  providers: {
    fake: {
      name: "Fake",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: baseUrl, apiKey: "test" },
      models: {
        scripted: modelEntry(),
        "scripted-2": modelEntry(),
      },
    },
  },
  permissions: [{ action: "shell", resource: "*", effect: "allow" }],
  plugins: pluginDirectories,
});

/** Writes the sandboxed XDG config that loads the scenario's plugin directories. */
const writeConfig = (
  dir: string,
  pluginDirectories: ReadonlyArray<string>,
  baseUrl: string,
): Effect.Effect<void> =>
  writeText(
    join(dir, "xdg", "config", "opencode", "opencode.json"),
    JSON.stringify(projectConfig(pluginDirectories, baseUrl), null, 2) + "\n",
  );

/** A prepared OpenCode run: the sandbox, and the model its config points at. */
export interface PreparedOpenCode {
  readonly box: Sandbox;
  readonly model: StandIn;
}

/**
 * Prepares one OpenCode run: a fresh sandbox, the scripted model, one bundle
 * per plugin, and the config that loads them in the sandbox.
 */
export const prepareOpenCode = (
  plugins: ReadonlyArray<PluginName>,
  standIn?: StandInOptions,
): Effect.Effect<PreparedOpenCode, never, Scope.Scope> =>
  Effect.gen(function* () {
    const box = yield* sandbox;
    const model = yield* standInModel("shell", standIn);

    const bundles = yield* bundleScenarioPlugins(
      box.dir,
      plugins,
      "opencode",
      PLUGIN_FILE,
      box.opencode.env,
    );

    yield* writeConfig(
      box.dir,
      bundles.map((bundle) => dirname(bundle)),
      model.baseUrl,
    );

    return { box, model };
  });

/**
 * Runs one scenario in the real OpenCode CLI: the prepared sandbox, then one
 * standalone run in a fresh project.
 */
export const runOpenCodeScenario = (
  scenario: Scenario,
): Effect.Effect<AgentRun, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { box, model } = yield* prepareOpenCode(scenario.plugins);

    const command = yield* runCommand({
      bin: box.opencode.bin,
      args: ["run", "--standalone", "--format", "json", "-m", "fake/scripted", "push it"],
      cwd: box.projectDir,
      env: box.opencode.env,
    });

    return yield* collectEvidence(box, model, command);
  });
