import assert from "node:assert/strict";

import { Effect, Schema } from "effect";

import {
  waitForEvidence,
  type Driver,
  type MarkerTimeout,
  type SessionRun,
  type SettledSignal,
} from "./harness/driver.ts";
import { MarkerObservations, type MarkerObservation } from "./harness/markers.ts";
import {
  isCompactionRequest,
  MAX_POST_TOOL_DELAY_MS,
  type ChatRequest,
  type StandInOptions,
} from "./model/stand-in.ts";
import { textFor, type AgentName, type PluginName } from "./scenarios.ts";

/** One long-lived run plus the agent that made it. */
export interface SessionEvidence extends SessionRun {
  readonly agent: AgentName;
}

/** One row of T2's table: the plugins, the steps, and what must be true after. */
export interface SessionScenario {
  readonly name: string;
  readonly plugins: ReadonlyArray<PluginName>;
  /** How the scripted model answers this row; absent means the T1 behaviour. */
  readonly standIn?: StandInOptions;
  readonly run: (driver: Driver) => Effect.Effect<void, MarkerTimeout>;
  readonly check: (evidence: SessionEvidence) => void;
}

const PUSH = "push it";
const WAKE = "tack-conformance: wake";
const OUTSIDE = "tack-conformance: outside";
const NOW = "tack-conformance: now";
const NEXT = "tack-conformance: next";
const DENIED = "tack-conformance: permission denied";

/** A fragment both agents' own compaction prompts carry. */
const COMPACTION_MARKER = "summar";

/**
 * The second prompt, large enough that Pi's compaction has a turn to
 * summarize. Pi cuts at the newest user-message span once the entries after
 * the cut reach `keepRecentTokens` (20 000 by default), and refuses with
 * "Nothing to compact (session too small)" when the cut leaves nothing before
 * it (`dist/core/compaction/compaction.js`, `prepareCompaction`). At about
 * 300 KB this prompt is some 75 000 estimated tokens, so the cut lands on it
 * and the first turn is what the summary is made of.
 */
const COMPACTION_PROMPT = "push it " + "x".repeat(300_000);

/** How long a turn stays open after its tool result, for the mid-turn rows. */
const MID_TURN_MS = 2_000;

/**
 * How long the model owes its post-tool answer when a scenario interrupts the
 * turn. The whole bounded delay is the window the interrupt has to land in.
 */
const SLOW_TURN_MS = MAX_POST_TOOL_DELAY_MS;

/** Matches a request the way the conformance table describes one. */
const hasText = (request: ChatRequest, text: string): boolean =>
  JSON.stringify(request.messages).includes(text);

/** A request whose body has tools and a message with role tool. */
const isToolBearing = (request: ChatRequest): boolean =>
  (request.tools ?? []).length > 0 && request.messages.some((message) => message.role === "tool");

/** A tool-bearing request that carries `text`. */
const carries =
  (text: string) =>
  (request: ChatRequest): boolean =>
    isToolBearing(request) && hasText(request, text);

const listed = (names: ReadonlyArray<string>): string =>
  names.length === 0 ? "none" : names.join(", ");

/** The most of one message a failure message quotes. */
const MAX_QUOTED_CHARS = 400;

const excerpt = (text: string): string =>
  text.length > MAX_QUOTED_CHARS ? text.slice(0, MAX_QUOTED_CHARS) + "..." : text;

/** What the model has been asked so far, for a request wait that ran out. */
const describeRequests = (requests: ReadonlyArray<ChatRequest>): string => {
  const last = requests.at(-1)?.messages.at(-1);

  return (
    "requests: " +
    requests.length +
    "\nlast message: " +
    (last === undefined ? "none" : excerpt(JSON.stringify(last.content ?? last.role)))
  );
};

/** What one plugin's marker recorded, for an observation wait that ran out. */
const describeObservations = (
  observations: ReadonlyArray<MarkerObservation>,
  signals: ReadonlyArray<SettledSignal>,
): string =>
  "recorded: " +
  listed(observations.map((observation) => JSON.stringify(observation))) +
  "\nsettled: " +
  listed(signals.map((signal) => signal.kind));

/** Waits until the stand-in holds a request the predicate accepts. */
const waitForRequest = (
  driver: Driver,
  accepts: (request: ChatRequest) => boolean,
  what: string,
): Effect.Effect<void> =>
  waitForEvidence(
    what,
    driver.requests.pipe(
      Effect.map((requests) => ({
        ready: requests.some(accepts),
        seen: describeRequests(requests),
      })),
    ),
  );

/** Waits until one plugin's marker holds an observation the predicate accepts. */
const waitForObservation = (
  driver: Driver,
  name: string,
  accepts: (observation: MarkerObservation) => boolean,
  what: string,
): Effect.Effect<void> =>
  waitForEvidence(
    what,
    driver.observations(name).pipe(
      Effect.map((observations) => ({
        ready: observations.some(accepts),
        seen: describeObservations(observations, driver.signals()),
      })),
    ),
  );

/**
 * Starts a turn and interrupts it while the scripted model still owes its
 * post-tool response, so the interrupt lands inside a running turn. The wait
 * for that request proves the turn is running; a fixed pause would only hope.
 */
const interruptSlowTurn = (driver: Driver): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* driver.prompt(PUSH);
    yield* waitForRequest(driver, isToolBearing, "the turn's post-tool request");
    yield* driver.interrupt();
  });

/** Names what a failed assertion saw, across every channel the run left. */
export const describeSession = (evidence: SessionEvidence): string =>
  [
    "agent: " + evidence.agent,
    "requests: " + evidence.requests.length,
    "recorded: " + listed(evidence.recorded),
    "markers: " + listed([...evidence.markers.keys()]),
    "settled: " + listed(evidence.settled.map((signal) => signal.kind)),
  ].join("\n");

const observationsOf = (
  evidence: SessionEvidence,
  name: string,
): ReadonlyArray<MarkerObservation> => {
  const text = evidence.markers.get(name);

  assert.ok(text !== undefined, "the " + name + " marker must exist\n" + describeSession(evidence));

  return Schema.decodeUnknownSync(MarkerObservations)(JSON.parse(text));
};

const observed = (
  observations: ReadonlyArray<MarkerObservation>,
  event: string,
): ReadonlyArray<MarkerObservation> =>
  observations.filter((observation) => observation["event"] === event);

const hasValue = (
  observations: ReadonlyArray<MarkerObservation>,
  key: string,
  value: string | boolean,
): boolean => observations.some((observation) => observation[key] === value);

const lastReason = (
  observations: ReadonlyArray<MarkerObservation>,
): MarkerObservation[string] | undefined => observations.at(-1)?.["reason"];

/** A finished-note check: some request must have ended the given way. */
const assertFinished = (evidence: SessionEvidence, reason: "aborted" | "error"): void => {
  const details = describeSession(evidence);
  const finished = observationsOf(evidence, "finished-note");

  assert.ok(
    finished.some((observation) => observation["reason"] === reason),
    "a request must be reported " + reason + "\n" + details,
  );
};

const wake: SessionScenario = {
  name: "t2 wake",
  plugins: ["append-wake"],
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.settle();
      yield* driver.waitMarker("append-wake");
      yield* waitForRequest(driver, carries(WAKE), "a tool-bearing request carrying the wake text");
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "append-wake");

    assert.ok(
      hasValue(observations, "outcome", "accepted"),
      "the wake append must be accepted\n" + details,
    );
    assert.ok(
      evidence.requests.some(carries(WAKE)),
      "a tool-bearing request must carry the wake text\n" + details,
    );
  },
};

const outside: SessionScenario = {
  name: "t2 outside hook",
  plugins: ["append-outside"],
  standIn: { postToolDelayMs: MID_TURN_MS },
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.settle();
      yield* driver.waitMarker("append-outside");
      yield* waitForRequest(
        driver,
        carries(OUTSIDE),
        "a tool-bearing request carrying the outside text",
      );
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "append-outside");

    assert.ok(
      hasValue(observations, "outcome", "accepted"),
      "the timer's append must be accepted\n" + details,
    );
    assert.ok(
      evidence.requests.some(carries(OUTSIDE)),
      "a tool-bearing request must carry the outside text\n" + details,
    );
  },
};

const now: SessionScenario = {
  name: "t2 now",
  plugins: ["append-now"],
  standIn: { postToolDelayMs: 1_000 },
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.settle();
      yield* driver.waitMarker("append-now");
      yield* waitForRequest(
        driver,
        carries(NOW),
        "a tool-bearing request carrying the steering text",
      );
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "append-now");

    assert.ok(
      hasValue(observations, "outcome", "accepted"),
      "the steering append must be accepted\n" + details,
    );
    assert.ok(
      evidence.requests.some(carries(NOW)),
      "a tool-bearing request must carry the steering text\n" + details,
    );
  },
};

const next: SessionScenario = {
  name: "t2 next",
  plugins: ["append-next"],
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.settle();
      yield* driver.waitMarker("append-next");
      yield* driver.prompt(PUSH);
      yield* driver.settle();
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "append-next");
    const first = evidence.requests.find(isToolBearing);

    assert.ok(
      hasValue(observations, "outcome", "accepted"),
      "the queued append must be accepted\n" + details,
    );
    assert.ok(first !== undefined, "a tool-bearing request must exist\n" + details);
    assert.ok(!hasText(first, NEXT), "the queued text must not reach the running turn\n" + details);

    const afterFirst = evidence.requests.slice(evidence.requests.indexOf(first) + 1);

    assert.ok(
      afterFirst.some(carries(NEXT)),
      "a later tool-bearing request must carry the queued text\n" + details,
    );
  },
};

const permission: SessionScenario = {
  name: "t2 permission",
  plugins: ["permission-deny"],
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.settle();
      yield* driver.waitMarker("permission-deny");
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "permission-deny");

    if (evidence.agent === "pi") {
      assert.ok(
        hasValue(observations, "event", "registered"),
        "the plugin must load and mark itself registered\n" + details,
      );
      assert.equal(
        observed(observations, "asked").length,
        0,
        "Pi has no permission layer, so permissionAsked must never run\n" + details,
      );
      assert.deepEqual(
        evidence.recorded,
        ["push origin main"],
        "Pi's push must reach the recorder\n" + details,
      );

      return;
    }

    assert.ok(
      hasValue(observations, "event", "asked"),
      "OpenCode must ask the plugin about the shell call\n" + details,
    );
    assert.deepEqual(evidence.recorded, [], "a denied push must not reach git\n" + details);
    assert.ok(
      textFor(evidence.requests, "tool").includes(DENIED),
      "the model must receive the deny reason\n" + details,
    );
  },
};

const idle: SessionScenario = {
  name: "t2 idle",
  plugins: ["idle-note"],
  standIn: { postToolDelayMs: SLOW_TURN_MS },
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.settle();
      yield* driver.waitMarker("idle-note");
      yield* interruptSlowTurn(driver);
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "idle-note");
    const idles = observed(observations, "idle");

    if (evidence.agent === "pi") {
      const settles = observed(observations, "agent_settled");

      assert.equal(idles.length, 2, "Pi must report both idle transitions\n" + details);
      assert.equal(settles.length, 2, "Pi must report both settled runs\n" + details);
      assert.equal(
        settles.at(-1)?.["aborted"],
        true,
        "the interrupted run must settle aborted\n" + details,
      );

      return;
    }

    assert.equal(
      idles.length,
      1,
      "OpenCode's idle hook must stay silent for the interrupted turn\n" + details,
    );
    assert.equal(
      observed(observations, "agent_settled").length,
      0,
      "only Pi records agent_settled\n" + details,
    );
  },
};

const finishedDone: SessionScenario = {
  name: "t2 finished done",
  plugins: ["finished-note"],
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.settle();
      yield* waitForObservation(
        driver,
        "finished-note",
        (observation) => observation["reason"] === "done",
        "a finished request reported done",
      );
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const finished = observationsOf(evidence, "finished-note");

    assert.ok(finished.length > 0, "a finished request must be recorded\n" + details);
    assert.ok(
      finished.every((observation) => observation["reason"] === "done"),
      "every finished request must be done\n" + details,
    );
  },
};

const finishedAborted: SessionScenario = {
  name: "t2 finished aborted",
  plugins: ["finished-note"],
  standIn: { postToolDelayMs: SLOW_TURN_MS },
  run: (driver) =>
    Effect.gen(function* () {
      yield* interruptSlowTurn(driver);
      yield* waitForObservation(
        driver,
        "finished-note",
        (observation) => observation["reason"] === "aborted",
        "the interrupted request reported aborted",
      );
    }),
  check: (evidence) => {
    const details = describeSession(evidence);

    assertFinished(evidence, "aborted");
    assert.equal(
      lastReason(observationsOf(evidence, "finished-note")),
      "aborted",
      "the last request must be the interrupted one\n" + details,
    );
  },
};

const finishedError: SessionScenario = {
  name: "t2 finished error",
  plugins: ["finished-note"],
  standIn: { failNext: true },
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.settle();
      yield* waitForObservation(
        driver,
        "finished-note",
        (observation) => observation["reason"] === "error",
        "the failed request reported error",
      );
    }),
  check: (evidence) => {
    assertFinished(evidence, "error");
  },
};

const lifecycle: SessionScenario = {
  name: "t2 lifecycle",
  plugins: ["lifecycle-note"],
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.waitMarker("lifecycle-note");
      yield* driver.endSession();
      yield* waitForObservation(
        driver,
        "lifecycle-note",
        (observation) => observation["event"] === "ended",
        "the lifecycle-note marker's ended event",
      );
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "lifecycle-note");
    const created = observed(observations, "created");
    const ended = observed(observations, "ended");

    assert.ok(
      created.some((observation) => observation["resumed"] === false),
      "the session must be created after the plugin loads\n" + details,
    );
    assert.equal(created.length, 1, "one session must be reported created\n" + details);
    assert.equal(ended.length, 1, "one session must be reported ended\n" + details);
    assert.equal(
      ended[0]?.["reason"],
      evidence.agent === "pi" ? "shutdown" : "closed",
      "the end reason must match the harness\n" + details,
    );
  },
};

const interrupt: SessionScenario = {
  name: "t2 interrupt",
  plugins: ["interrupt-action"],
  standIn: { postToolDelayMs: SLOW_TURN_MS },
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.waitMarker("interrupt-action");
      yield* driver.settle();
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "interrupt-action");

    assert.ok(
      hasValue(observations, "outcome", "accepted"),
      "the plugin's interrupt must be accepted\n" + details,
    );

    const aborted = evidence.settled.some((signal) =>
      evidence.agent === "pi"
        ? signal.kind === "agent_settled" && signal.aborted
        : signal.kind === "session.execution.interrupted",
    );

    assert.ok(aborted, "the turn must settle aborted\n" + details);
  },
};

const model: SessionScenario = {
  name: "t2 model",
  plugins: ["model-switch"],
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.settle();
      yield* waitForObservation(
        driver,
        "model-switch",
        (observation) => observation["event"] === "turn",
        "the model-switch marker's finished turn",
      );
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "model-switch");

    assert.ok(
      hasValue(observations, "outcome", "accepted"),
      "the model switch must be accepted\n" + details,
    );
    assert.ok(
      observed(observations, "turn").length > 0,
      "a turn must finish after the switch\n" + details,
    );

    if (evidence.agent !== "pi") return;

    assert.ok(
      observed(observations, "model_select").some(
        (observation) => observation["model"] === "scripted-2",
      ),
      "Pi must report the model switch it saw\n" + details,
    );
  },
};

const compact: SessionScenario = {
  name: "t2 compact",
  plugins: ["compact-action"],
  standIn: { compactionMarker: COMPACTION_MARKER },
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.settle();
      yield* driver.prompt(COMPACTION_PROMPT);
      yield* driver.waitMarker("compact-action");
      yield* waitForRequest(
        driver,
        (request) => isCompactionRequest(request, COMPACTION_MARKER),
        "a compaction request",
      );
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "compact-action");

    assert.ok(
      hasValue(observations, "outcome", "accepted"),
      "the compaction request must be accepted\n" + details,
    );
    assert.ok(
      evidence.requests.some((request) => isCompactionRequest(request, COMPACTION_MARKER)),
      "the model must receive a compaction request\n" + details,
    );
  },
};

/** T2's table: every long-lived scenario, run in both agents. */
export const sessionScenarios: ReadonlyArray<SessionScenario> = [
  wake,
  outside,
  now,
  next,
  permission,
  idle,
  finishedDone,
  finishedAborted,
  finishedError,
  lifecycle,
  interrupt,
  model,
  compact,
];
