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

/** The filter a run without `TACK_CONFORMANCE_ONLY` uses: every row. */
const ONLY_DEFAULT = "";

/** The most a row may repeat in one run, so a mistyped variable stops before CI does. */
const MAX_REPEAT = 100;

/** The row filter as written: empty keeps every row. */
const onlySetting = (): string =>
  Effect.runSync(
    Config.String("TACK_CONFORMANCE_ONLY").pipe(Config.withDefault(ONLY_DEFAULT)),
  ).trim();

/** Whether a row's name carries the filter, case-insensitively. */
const rowSelected = (row: string): boolean => {
  const filter = onlySetting().toLowerCase();

  return filter === "" || row.toLowerCase().includes(filter);
};

/** The rows this run keeps, in table order; every row unless the filter names one. */
export const selectedRows = <A extends { readonly name: string }>(
  rows: ReadonlyArray<A>,
): ReadonlyArray<A> => rows.filter((row) => rowSelected(row.name));

/** The rows one agent runs, in table order: a row may name a single agent. */
export const rowsFor = <A extends { readonly name: string; readonly only?: AgentName }>(
  rows: ReadonlyArray<A>,
  agent: AgentName,
): ReadonlyArray<A> =>
  selectedRows(rows).filter((row) => row.only === undefined || row.only === agent);

/** A filtered run that selected no row: it would check nothing but a version. */
class EmptySelection extends Error {
  override name = "EmptySelection";

  constructor(agent: string, only: string) {
    super(
      "tack-conformance: TACK_CONFORMANCE_ONLY " +
        JSON.stringify(only) +
        " selected no " +
        agent +
        " row",
    );
  }
}

/**
 * Refuses a filtered run that selected nothing, where the pinned-version test
 * would be the whole run. Each group is one table's selected rows, so a filter
 * may name a row in any of them.
 */
export const requireSelection = (
  agent: string,
  groups: ReadonlyArray<ReadonlyArray<{ readonly name: string }>>,
): void => {
  const only = onlySetting();

  if (only === "" || groups.some((rows) => rows.length > 0)) return;

  throw new EmptySelection(agent, only);
};

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
 * test of its own, so it gets its own sandbox and its own failure. A filtered
 * run names its filter, so its log cannot be mistaken for a full one.
 */
export const iterations = (): ReadonlyArray<Iteration> => {
  const count = repeatCount();
  const only = onlySetting();

  const suffix = only === "" ? "" : " [only: " + only + "]";

  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;

    return {
      name: (row: string) => (count === 1 ? row : row + " (" + index + "/" + count + ")") + suffix,
    };
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
