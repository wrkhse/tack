import assert from "node:assert/strict";

import { Effect, Schema } from "effect";

import type { Driver, MarkerTimeout, SessionRun } from "./harness/driver.ts";
import { MarkerObservations, type MarkerObservation } from "./harness/markers.ts";
import { isCompactionRequest, type ChatRequest, type StandInOptions } from "./model/stand-in.ts";
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

/** A conversation large enough that Pi can compact it rather than refuse. */
const COMPACTION_PROMPT = "push it " + "x".repeat(120_000);

/** How long a turn stays open after its tool result, for the mid-turn rows. */
const MID_TURN_MS = 2_000;

/** How long a turn waits after its tool result when the scenario interrupts it. */
const SLOW_TURN_MS = 2_000;

/** How long after a prompt the scenario interrupts a slow turn. */
const INTERRUPT_AFTER_MS = 800;

/** A bounded pause so a plugin's marker catches up with a harness signal. */
const MARKER_PAUSE_MS = 300;

/** The pause that lets an agent shut down and write its ended marker. */
const END_PAUSE_MS = 500;

/** The pause that lets the scripted compaction request reach the model. */
const COMPACTION_PAUSE_MS = 1_000;

const pause = (ms: number): Effect.Effect<void> => Effect.sleep(ms);

/**
 * Starts a turn and interrupts it while the scripted model still owes its
 * post-tool response, so the interrupt lands inside a running turn.
 */
const interruptSlowTurn = (driver: Driver): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* driver.prompt(PUSH);
    yield* pause(INTERRUPT_AFTER_MS);
    yield* driver.interrupt();
    yield* pause(MARKER_PAUSE_MS);
  });

/** Matches a request the way the conformance table describes one. */
const hasText = (request: ChatRequest, text: string): boolean =>
  JSON.stringify(request.messages).includes(text);

/** A request whose body has tools and a message with role tool. */
const isToolBearing = (request: ChatRequest): boolean =>
  (request.tools ?? []).length > 0 && request.messages.some((message) => message.role === "tool");

const someToolText = (requests: ReadonlyArray<ChatRequest>, text: string): boolean =>
  requests.some((request) => isToolBearing(request) && hasText(request, text));

const listed = (names: ReadonlyArray<string>): string =>
  names.length === 0 ? "none" : names.join(", ");

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
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "append-wake");

    assert.ok(
      hasValue(observations, "outcome", "accepted"),
      "the wake append must be accepted\n" + details,
    );
    assert.ok(
      someToolText(evidence.requests, WAKE),
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
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "append-outside");

    assert.ok(
      hasValue(observations, "outcome", "accepted"),
      "the timer's append must be accepted\n" + details,
    );
    assert.ok(
      someToolText(evidence.requests, OUTSIDE),
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
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "append-now");

    assert.ok(
      hasValue(observations, "outcome", "accepted"),
      "the steering append must be accepted\n" + details,
    );
    assert.ok(
      someToolText(evidence.requests, NOW),
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
      afterFirst.some((request) => isToolBearing(request) && hasText(request, NEXT)),
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
      yield* driver.waitMarker("finished-note");
      yield* pause(MARKER_PAUSE_MS);
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
  run: interruptSlowTurn,
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
      yield* pause(MARKER_PAUSE_MS);
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
      yield* pause(END_PAUSE_MS);
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
      yield* driver.waitMarker("model-switch");
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
      yield* driver.prompt(COMPACTION_PROMPT);
      yield* driver.waitMarker("compact-action");
      yield* pause(COMPACTION_PAUSE_MS);
      yield* driver.settle();
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
