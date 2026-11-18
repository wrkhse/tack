import { Config, Effect, type Scope } from "effect";

import type { MarkerTimeout, SessionRun } from "./harness/driver.ts";
import { cliVersion } from "./harness/run.ts";
import { pinnedVersion, sandbox, type AgentEnvironment, type Sandbox } from "./harness/sandbox.ts";
import {
  assertLoaded,
  assertVersion,
  describeRun,
  type AgentName,
  type AgentRun,
  type Scenario,
} from "./scenarios.ts";
import {
  describeSession,
  type SessionEvidence,
  type SessionScenario,
} from "./session-scenarios.ts";

/** The repeat setting a run without `TACK_CONFORMANCE_REPEAT` uses: one run per row. */
const REPEAT_DEFAULT = "1";

/** The most a row may repeat in one run, so a mistyped variable stops before CI does. */
const MAX_REPEAT = 100;

/** One run of a row: a test of its own, named for its place when the row repeats. */
export interface Iteration {
  /** The row's test name, numbered only when the row runs more than once. */
  readonly name: (row: string) => string;
}

/** How many times each row runs, read from `TACK_CONFORMANCE_REPEAT`. */
const repeatCount = (): number => {
  const setting = Effect.runSync(
    Config.String("TACK_CONFORMANCE_REPEAT").pipe(Config.withDefault(REPEAT_DEFAULT)),
  );

  const count = Number(setting);

  if (!Number.isInteger(count) || count < 1 || count > MAX_REPEAT) {
    throw new Error(
      "tack-conformance: TACK_CONFORMANCE_REPEAT must be an integer from 1 to " +
        MAX_REPEAT +
        ", not " +
        JSON.stringify(setting),
    );
  }

  return count;
};

/**
 * Every run of every row this process owes: one per repeat. Each iteration is a
 * test of its own, so it gets its own sandbox and its own failure.
 */
export const iterations = (): ReadonlyArray<Iteration> => {
  const count = repeatCount();

  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;

    return { name: (row: string) => (count === 1 ? row : row + " (" + index + "/" + count + ")") };
  });
};

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

/** Runs one one-shot scenario in one agent, then checks what the run left behind. */
export const checkScenario = (
  agent: AgentName,
  runScenario: (scenario: Scenario) => Effect.Effect<AgentRun, never, Scope.Scope>,
  scenario: Scenario,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const run = yield* runScenario(scenario);

    yield* Effect.sync(() => {
      const evidence = { agent, ...run };

      assertLoaded(evidence, scenario.plugins, describeRun(evidence));
      scenario.check(evidence);
    });
  });

/** Runs one long-lived scenario in one agent, then checks what the run left behind. */
export const checkSessionScenario = (
  agent: AgentName,
  runScenario: (scenario: SessionScenario) => Effect.Effect<SessionRun, MarkerTimeout, Scope.Scope>,
  scenario: SessionScenario,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const run = yield* runScenario(scenario).pipe(
      Effect.catchTag("MarkerTimeout", (failure) => Effect.die(new Error(failure.message))),
    );

    yield* Effect.sync(() => {
      const evidence: SessionEvidence = { agent, ...run };

      assertLoaded(evidence, scenario.plugins, describeSession(evidence));
      scenario.check(evidence);
    });
  });
