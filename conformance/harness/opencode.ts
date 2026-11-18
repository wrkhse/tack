import { dirname, join } from "node:path";

import { Effect, type Scope } from "effect";

import { standInModel, type StandIn, type StandInOptions } from "../model/stand-in.ts";
import { collectEvidence, type AgentRun, type PluginName, type Scenario } from "../scenarios.ts";
import { bundleScenarioPlugins } from "./bundle.ts";
import type { OpenCodeServer } from "./opencode-server.ts";
import { runCommand } from "./run.ts";
import { sandbox, writeText, type Sandbox } from "./sandbox.ts";

/** An OpenCode plugin is a directory whose entry file is index.js. */
const PLUGIN_FILE = "index.js";

/** One scripted model. Two ids are served, so `setModel` has a real target. */
const modelEntry = () => ({
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  limit: { context: 32768, output: 4096 },
});

const projectConfig = (
  pluginDirectories: ReadonlyArray<string>,
  baseUrl: string,
  shellPermission: "allow" | "deny",
) => ({
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
  permissions: [{ action: "shell", resource: "*", effect: shellPermission }],
  // Only the compaction a row's plugin asks for runs, so a request the
  // context threshold made cannot stand in for it. Manual compaction works
  // with auto off.
  compaction: { auto: false },
  plugins: pluginDirectories,
});

/** Writes the sandboxed XDG config that loads the scenario's plugin directories. */
const writeConfig = (
  dir: string,
  pluginDirectories: ReadonlyArray<string>,
  baseUrl: string,
  shellPermission: "allow" | "deny",
): Effect.Effect<void> =>
  writeText(
    join(dir, "xdg", "config", "opencode", "opencode.json"),
    JSON.stringify(projectConfig(pluginDirectories, baseUrl, shellPermission), null, 2) + "\n",
  );

/** A prepared OpenCode run: the sandbox, its model, and its plugin bundles. */
export interface PreparedOpenCode {
  readonly box: Sandbox;
  readonly model: StandIn;
  readonly bundles: ReadonlyArray<string>;
  readonly shellPermission: "allow" | "deny";
}

/** The config line that loads every bundle into the sandbox location. */
const writePlugins = (prepared: PreparedOpenCode): Effect.Effect<void> =>
  writeConfig(
    prepared.box.dir,
    prepared.bundles.map((bundle) => dirname(bundle)),
    prepared.model.baseUrl,
    prepared.shellPermission,
  );

/**
 * Prepares the sandbox, the scripted model, and one bundle per plugin, without
 * writing the config yet. A run that must create its session before the plugin
 * loads writes the empty config first, then calls loadOpenCodePlugins.
 */
const prepareRun = (
  plugins: ReadonlyArray<PluginName>,
  standIn: StandInOptions | undefined,
  shellPermission: "allow" | "deny",
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

    return { box, model, bundles, shellPermission };
  });

/**
 * Writes the config a prepared run needs, either the plugin directories or an
 * empty list that leaves a pre-existing session without a plugin subscriber.
 */
const prepareConfigured = (
  plugins: ReadonlyArray<PluginName>,
  standIn: StandInOptions | undefined,
  shellPermission: "allow" | "deny",
  load: "plugins" | "empty",
): Effect.Effect<PreparedOpenCode, never, Scope.Scope> =>
  Effect.gen(function* () {
    const prepared = yield* prepareRun(plugins, standIn, shellPermission);

    if (load === "plugins") {
      yield* writePlugins(prepared);
    } else {
      yield* writeConfig(prepared.box.dir, [], prepared.model.baseUrl, prepared.shellPermission);
    }

    return prepared;
  });

/**
 * Prepares one OpenCode run: a fresh sandbox, the scripted model, one bundle
 * per plugin, and the config that loads them, unless `load` asks for the empty
 * config a session created before the plugin needs.
 */
export const prepareOpenCode = (
  plugins: ReadonlyArray<PluginName>,
  standIn?: StandInOptions,
  shellPermission: "allow" | "deny" = "allow",
  load: "plugins" | "empty" = "plugins",
): Effect.Effect<PreparedOpenCode, never, Scope.Scope> =>
  prepareConfigured(plugins, standIn, shellPermission, load);

/**
 * Prepares one OpenCode run with the plugin config empty, so its first session
 * exists before any plugin subscribes to it.
 */
export const prepareOpenCodeUnloaded = (
  plugins: ReadonlyArray<PluginName>,
  standIn?: StandInOptions,
  shellPermission: "allow" | "deny" = "allow",
): Effect.Effect<PreparedOpenCode, never, Scope.Scope> =>
  prepareOpenCode(plugins, standIn, shellPermission, "empty");

/**
 * Writes the plugin config and reloads the server's locations, then waits for
 * the plugin to be listed. The session created before this call keeps running.
 */
export const loadOpenCodePlugins = (
  prepared: PreparedOpenCode,
  server: OpenCodeServer,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* writePlugins(prepared);
    yield* server.reloadLocations();
    yield* server.awaitPlugin(prepared.box.projectDir);
  });

/**
 * Runs one scenario in the real OpenCode CLI: the prepared sandbox, then one
 * standalone run in a fresh project.
 */
export const runOpenCodeScenario = (
  scenario: Scenario,
): Effect.Effect<AgentRun, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { box, model } = yield* prepareOpenCode(scenario.plugins, scenario.standIn);

    const command = yield* runCommand({
      bin: box.opencode.bin,
      args: ["run", "--standalone", "--format", "json", "-m", "fake/scripted", "push it"],
      cwd: box.projectDir,
      env: box.opencode.env,
    });

    return yield* collectEvidence(box, model, command);
  });
