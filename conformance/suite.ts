import { Effect, type Scope } from "effect";

import { cliVersion } from "./harness/run.ts";
import { pinnedVersion, sandbox, type AgentEnvironment, type Sandbox } from "./harness/sandbox.ts";
import {
  assertLoaded,
  assertVersion,
  type AgentName,
  type AgentRun,
  type Scenario,
} from "./scenarios.ts";

/** Checks that one CLI reports the version its package is pinned to. */
export const checkPinnedVersion = (
  agent: AgentName,
  packageName: string,
  cli: (box: Sandbox) => AgentEnvironment,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const box = yield* sandbox;
    const pin = yield* pinnedVersion(packageName);
    const environment = cli(box);
    const output = yield* cliVersion(environment.bin, environment.env, box.dir);

    assertVersion(agent, output, pin);
  });

/** Runs one scenario in one agent, then checks what the run left behind. */
export const checkScenario = (
  agent: AgentName,
  runScenario: (scenario: Scenario) => Effect.Effect<AgentRun, never, Scope.Scope>,
  scenario: Scenario,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const run = yield* runScenario(scenario);

    yield* Effect.sync(() => {
      const evidence = { agent, ...run };

      assertLoaded(evidence, scenario.plugins);
      scenario.check(evidence);
    });
  });
