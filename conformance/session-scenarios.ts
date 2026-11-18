import assert from "node:assert/strict";

import { Effect, Predicate, Schema } from "effect";

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
  /** The shell permission OpenCode's sandbox config carries; default `allow`. */
  readonly shellPermission?: "allow" | "deny";
  /** The one agent a row runs in; absent means both. */
  readonly only?: AgentName;
  /** Creates the session before the plugin loads; OpenCode only. */
  readonly beforePlugin?: boolean;
  readonly run: (driver: Driver, agent: AgentName) => Effect.Effect<void, MarkerTimeout>;
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

/** A request whose body carries tools. */
const hasTools = (request: ChatRequest): boolean => (request.tools ?? []).length > 0;

/** A request whose body has tools and a message with role tool. */
const isToolBearing = (request: ChatRequest): boolean =>
  hasTools(request) && request.messages.some((message) => message.role === "tool");

/** A tool-bearing request that carries `text`. */
const carries =
  (text: string) =>
  (request: ChatRequest): boolean =>
    isToolBearing(request) && hasText(request, text);

/**
 * A request that starts a new turn: the agent loop carries tools, and its last
 * message is the person's prompt. A title request has no tools, and a synthetic
 * append carries its own text, so neither counts as a second prompt.
 */
const isUserPrompt = (request: ChatRequest, text: string): boolean => {
  const last = request.messages.at(-1);

  return (
    (request.tools ?? []).length > 0 &&
    last?.role === "user" &&
    JSON.stringify(last.content ?? "").includes(text)
  );
};

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

/** What the agent's own stream showed, for a failure message. */
const describeStream = (trail: ReadonlyArray<Schema.Json>): string =>
  trail.length === 0
    ? "stream: none"
    : "stream:\n" + trail.map((frame) => "  " + excerpt(JSON.stringify(frame))).join("\n");

/** What one plugin's marker recorded, for an observation wait that ran out. */
const describeObservations = (
  observations: ReadonlyArray<MarkerObservation>,
  signals: ReadonlyArray<SettledSignal>,
  trail: ReadonlyArray<Schema.Json>,
): string =>
  "recorded: " +
  listed(observations.map((observation) => JSON.stringify(observation))) +
  "\nsettled: " +
  listed(signals.map((signal) => signal.kind)) +
  "\n" +
  describeStream(trail);

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
  timeoutMs?: number,
): Effect.Effect<void> =>
  waitForEvidence(
    what,
    driver.observations(name).pipe(
      Effect.map((observations) => ({
        ready: observations.some(accepts),
        seen: describeObservations(observations, driver.signals(), driver.trail()),
      })),
    ),
    timeoutMs,
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

/** Asserts the permission plugin loaded and was never asked. */
const assertPermissionRegisteredOnly = (
  observations: ReadonlyArray<MarkerObservation>,
  details: string,
  message: string,
): void => {
  assert.deepEqual(observations, [{ event: "registered" }], message + "\n" + details);
};

/** Asserts Pi's push reached the recorder, which has no permission layer. */
const assertPiPushRecorded = (evidence: SessionEvidence, details: string): void => {
  assert.deepEqual(
    evidence.recorded,
    ["push origin main"],
    "Pi's push must reach the recorder\n" + details,
  );
};

/** Ends the lifecycle row's session and waits for its ended observation. */
const endLifecycleSession = (driver: Driver): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* driver.endSession();
    yield* waitForObservation(
      driver,
      "lifecycle-note",
      (observation) => observation["event"] === "ended",
      "the ended session reported ended",
    );
  });

/** Names what a failed assertion saw, across every channel the run left. */
export const describeSession = (evidence: SessionEvidence): string =>
  [
    "agent: " + evidence.agent,
    "requests: " + evidence.requests.length,
    "recorded: " + listed(evidence.recorded),
    "markers: " + listed([...evidence.markers.keys()]),
    "settled: " + listed(evidence.settled.map((signal) => signal.kind)),
    describeStream(evidence.trail),
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

/** Every observation's event name, sorted, so an extra event fails the row. */
const eventNames = (observations: ReadonlyArray<MarkerObservation>): ReadonlyArray<string> =>
  observations
    .flatMap((observation) =>
      Predicate.isString(observation["event"]) ? [observation["event"]] : [],
    )
    .toSorted((left, right) => left.localeCompare(right));

/** One stream frame's type, when it carries one. */
const frameType = (frame: Schema.Json): string | null => {
  if (!Predicate.isObject(frame)) return null;

  const type = frame["type"];

  return Predicate.isString(type) ? type : null;
};

/** Whether one stream frame names the location the adapter scopes events by. */
const frameLocated = (frame: Schema.Json): boolean =>
  Predicate.isObject(frame) && frame["location"] !== undefined;

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

    assert.deepEqual(
      observationsOf(evidence, "append-wake"),
      [{ event: "append", outcome: "accepted" }],
      "the wake append must be accepted exactly once\n" + details,
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

    assert.deepEqual(
      observationsOf(evidence, "append-outside"),
      [{ event: "append", outcome: "accepted" }],
      "the timer's append must be accepted exactly once\n" + details,
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
        (request) => hasTools(request) && hasText(request, NOW),
        "a tool-bearing request carrying the steering text",
      );
    }),
  check: (evidence) => {
    const details = describeSession(evidence);
    const seen = describeRequests(evidence.requests);

    const prompts = evidence.requests.flatMap((request, index) =>
      isUserPrompt(request, PUSH) ? [index] : [],
    );

    const firstPrompt = prompts[0];

    assert.deepEqual(
      observationsOf(evidence, "append-now"),
      [{ event: "append", outcome: "accepted" }],
      "the steering append must be accepted exactly once\n" + details + "\n" + seen,
    );
    assert.equal(
      prompts.length,
      1,
      "the row sends one prompt, so a second one must not appear\n" + details + "\n" + seen,
    );
    assert.ok(
      firstPrompt !== undefined,
      "the first turn must start with a prompt\n" + details + "\n" + seen,
    );

    // Everything from the row's one prompt on is that turn; a second turn
    // would need a second prompt, which the assertion above excludes.
    const turn = evidence.requests.slice(firstPrompt);
    const toolRequests = turn.filter(hasTools);
    const firstToolRequest = toolRequests[0];
    const laterToolRequests = toolRequests.slice(1);

    assert.ok(
      firstToolRequest !== undefined,
      "the first turn must start with a tool-bearing request\n" + details + "\n" + seen,
    );
    assert.ok(
      !hasText(firstToolRequest, NOW),
      "the steering text must be absent from the first tool-bearing request, so it was not " +
        "part of the prompt that started the turn\n" +
        details +
        "\n" +
        seen,
    );
    assert.ok(
      laterToolRequests.some((request) => hasText(request, NOW)),
      "the steering text must land in a later tool-bearing request of the first turn\n" +
        details +
        "\n" +
        seen,
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
    const first = evidence.requests.findIndex(isToolBearing);
    const firstRequest = evidence.requests[first];

    assert.deepEqual(
      observationsOf(evidence, "append-next"),
      [{ event: "append", outcome: "accepted" }],
      "the queued append must be accepted exactly once\n" + details,
    );
    assert.ok(firstRequest !== undefined, "a tool-bearing request must exist\n" + details);
    assert.ok(
      !hasText(firstRequest, NEXT),
      "the queued text must not reach the running turn\n" + details,
    );

    const afterFirst = evidence.requests.slice(first + 1);

    assert.ok(
      afterFirst.some(carries(NEXT)),
      "a later tool-bearing request must carry the queued text\n" + details,
    );
  },
};

/** Prompts once and waits for the permission plugin's load marker. */
const runPermission = (driver: Driver): Effect.Effect<void, MarkerTimeout> =>
  Effect.gen(function* () {
    yield* driver.prompt(PUSH);
    yield* driver.settle();
    yield* driver.waitMarker("permission-deny");
  });

const permission: SessionScenario = {
  name: "t2 permission",
  plugins: ["permission-deny"],
  run: runPermission,
  check: (evidence) => {
    const details = describeSession(evidence);
    const observations = observationsOf(evidence, "permission-deny");

    if (evidence.agent === "pi") {
      assertPermissionRegisteredOnly(
        observations,
        details,
        "Pi has no permission layer, so the plugin loads and is never asked",
      );
      assertPiPushRecorded(evidence, details);

      return;
    }

    const asked = observed(observations, "asked");

    assert.deepEqual(
      observations.map((observation) => observation["event"]),
      ["registered", "asked"],
      "OpenCode must load the plugin and ask it about exactly the shell call\n" + details,
    );
    assert.equal(asked.length, 1, "one shell call must ask the plugin once\n" + details);
    assert.equal(
      asked[0]?.["action"],
      "shell",
      "the request must name the shell action\n" + details,
    );
    assert.deepEqual(evidence.recorded, [], "a denied push must not reach git\n" + details);
    assert.ok(
      textFor(evidence.requests, "tool").includes(DENIED),
      "the model must receive the deny reason\n" + details,
    );
  },
};

const permissionConfigured: SessionScenario = {
  name: "t2 permission configured",
  plugins: ["permission-deny"],
  shellPermission: "deny",
  run: runPermission,
  check: (evidence) => {
    const details = describeSession(evidence);

    assertPermissionRegisteredOnly(
      observationsOf(evidence, "permission-deny"),
      details,
      "a configured deny must skip permissionAsked entirely",
    );

    if (evidence.agent === "pi") {
      assertPiPushRecorded(evidence, details);

      return;
    }

    assert.deepEqual(
      evidence.recorded,
      [],
      "OpenCode's configured deny must refuse the push before git runs\n" + details,
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

    if (evidence.agent === "pi") {
      assert.deepEqual(
        observed(observations, "idle"),
        [{ event: "idle" }, { event: "idle" }],
        "Pi must report one idle per run\n" + details,
      );
      assert.deepEqual(
        observed(observations, "agent_settled"),
        [
          { event: "agent_settled", aborted: false },
          { event: "agent_settled", aborted: true },
        ],
        "Pi must settle a completed run and then an aborted one\n" + details,
      );
      assert.deepEqual(
        eventNames(observations),
        ["agent_settled", "agent_settled", "idle", "idle"],
        "Pi must report no other idle observation\n" + details,
      );

      return;
    }

    assert.deepEqual(
      observed(observations, "idle"),
      [{ event: "idle" }],
      "OpenCode's idle hook must fire once for the completed turn\n" + details,
    );
    assert.deepEqual(
      observed(observations, "agent_settled"),
      [],
      "only Pi records agent_settled\n" + details,
    );
    assert.deepEqual(
      eventNames(observations),
      ["idle"],
      "OpenCode must stay silent for the interrupted turn\n" + details,
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

    assert.deepEqual(
      observationsOf(evidence, "finished-note"),
      [
        { event: "finished", reason: "done" },
        { event: "finished", reason: "done" },
      ],
      "both model requests in the turn must be reported done exactly once\n" + details,
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

    assert.deepEqual(
      observationsOf(evidence, "finished-note"),
      [
        { event: "finished", reason: "done" },
        { event: "finished", reason: "aborted" },
      ],
      "the interrupted request must be reported aborted exactly once, after the finished one\n" +
        details,
    );
  },
};

/**
 * The retry-veto plugin makes the first failed request terminal. Without it
 * OpenCode spends a retry budget of about 67–101 seconds with jitter
 * (`packages/core/src/model-retry.ts:23`).
 */
const finishedError: SessionScenario = {
  name: "t2 finished error",
  plugins: ["finished-note", "retry-veto"],
  standIn: { failMode: "always" },
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
    const details = describeSession(evidence);

    assert.deepEqual(
      observationsOf(evidence, "finished-note"),
      [{ event: "finished", reason: "error" }],
      "the sticky failure must be reported error exactly once\n" + details,
    );

    if (evidence.agent === "pi") {
      assert.equal(
        evidence.markers.has("retry-veto"),
        false,
        "Pi disables retries, so the retry hook must not run\n" + details,
      );

      return;
    }

    assert.deepEqual(
      observationsOf(evidence, "retry-veto"),
      [{ event: "retry", attempt: 2 }],
      "OpenCode must offer exactly one retry, and the veto must refuse it\n" + details,
    );
  },
};

const lifecycle: SessionScenario = {
  name: "t2 lifecycle",
  plugins: ["lifecycle-note"],
  run: (driver, agent) =>
    Effect.gen(function* () {
      yield* driver.waitMarker("lifecycle-note");

      if (agent === "pi") {
        yield* driver.rebind();
        yield* waitForObservation(
          driver,
          "lifecycle-note",
          (observation) => observation["event"] === "ended" && observation["reason"] === "replaced",
          "the rebound session reported replaced",
        );
      }

      yield* endLifecycleSession(driver);
    }),
  check: (evidence) => {
    const details = describeSession(evidence);

    if (evidence.agent === "pi") {
      assert.deepEqual(
        observationsOf(evidence, "lifecycle-note"),
        [
          { event: "created", resumed: false },
          { event: "ended", reason: "replaced" },
          // Pi 1.5.2's RPC `new_session` binds extensions twice: once from
          // `AgentSessionRuntime.finishSessionReplacement`, through the runtime's
          // rebind hook, and once from rpc-mode's own `rebindSession()`. Both
          // emit `session_start` reason `new` for the one replacement session.
          { event: "created", resumed: false },
          { event: "created", resumed: false },
          { event: "ended", reason: "shutdown" },
        ],
        "the rebind must report replaced and two starts for the new session, and closing " +
          "stdin must report shutdown\n" +
          details,
      );

      return;
    }

    assert.deepEqual(
      observationsOf(evidence, "lifecycle-note"),
      [
        { event: "created", resumed: false },
        { event: "ended", reason: "closed" },
      ],
      "the session created after load must report created once and closed once\n" + details,
    );

    const deletes = evidence.trail.filter((frame) => frameType(frame) === "session.deleted");

    assert.ok(
      deletes.length > 0,
      "the server must publish session.deleted for the deleted session\n" + details,
    );
    assert.ok(
      deletes.every((frame) => !frameLocated(frame)),
      "OpenCode 2.3.0 publishes the delete without a location, so the adapter must attribute " +
        "it to the session it already reported; a located delete means the adapter no longer " +
        "needs that rule\n" +
        details,
    );
  },
};

/**
 * A session created before the plugin loaded has no `session.created` to
 * report, so its first event must report `sessionCreated` with `resumed: true`.
 * The OpenCode runner creates the session, then writes the plugin config and
 * reloads the location before prompting it.
 */
const lifecycleResumed: SessionScenario = {
  name: "t2 lifecycle resumed",
  plugins: ["lifecycle-note"],
  only: "opencode",
  beforePlugin: true,
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.settle();
      yield* driver.waitMarker("lifecycle-note");
      yield* endLifecycleSession(driver);
    }),
  check: (evidence) => {
    const details = describeSession(evidence);

    assert.deepEqual(
      observationsOf(evidence, "lifecycle-note"),
      [
        { event: "created", resumed: true },
        { event: "ended", reason: "closed" },
      ],
      "a session created before the plugin loaded must report resumed once\n" + details,
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

    assert.deepEqual(
      observationsOf(evidence, "interrupt-action"),
      [{ event: "interrupt", outcome: "accepted" }],
      "the plugin's interrupt must be accepted exactly once\n" + details,
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

    const turns = [
      { event: "turn", reason: "done" },
      { event: "turn", reason: "done" },
    ];

    const selected =
      evidence.agent === "pi"
        ? [{ event: "model_select", provider: "fake", model: "scripted-2" }]
        : [];

    assert.deepEqual(
      observed(observations, "model_select"),
      selected,
      "only Pi records the model it selected, once, as scripted-2\n" + details,
    );
    assert.deepEqual(
      observed(observations, "switch"),
      [{ event: "switch", outcome: "accepted" }],
      "the switch must be accepted once\n" + details,
    );
    assert.deepEqual(
      observed(observations, "turn"),
      turns,
      "every later request must finish\n" + details,
    );
    assert.deepEqual(
      eventNames(observations),
      evidence.agent === "pi"
        ? ["model_select", "switch", "turn", "turn"]
        : ["switch", "turn", "turn"],
      "no model-switch observation may appear outside the switch and its turns\n" + details,
    );

    const used = evidence.requests.findLast(isToolBearing);

    assert.equal(
      used?.model,
      "scripted-2",
      "the stand-in must see the second model on a later request\n" + details,
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

    const compactions = evidence.requests.filter((request) =>
      isCompactionRequest(request, COMPACTION_MARKER),
    );

    assert.deepEqual(
      observationsOf(evidence, "compact-action"),
      [{ event: "compact", outcome: "accepted" }],
      "the compaction request must be accepted exactly once\n" + details,
    );
    // The scripted reply, "summary", fills none of OpenCode 2.3.0's
    // summary-template headings, so it resends the prompt once with its "fill in
    // the template" nudge; Pi accepts the same reply without a second request.
    assert.equal(
      compactions.length,
      evidence.agent === "pi" ? 1 : 2,
      "Pi must ask the model to summarise once; OpenCode twice, because the scripted reply " +
        "skips its summary template and earns one nudge\n" +
        details,
    );
  },
};

/** T2's table: every long-lived scenario, run in both agents unless `only` says one. */
const sessionScenarios: ReadonlyArray<SessionScenario> = [
  wake,
  outside,
  now,
  next,
  permission,
  permissionConfigured,
  idle,
  finishedDone,
  finishedAborted,
  finishedError,
  lifecycle,
  lifecycleResumed,
  interrupt,
  model,
  compact,
];

/** The rows one agent's test runs, in table order. */
export const sessionScenariosFor = (agent: AgentName): ReadonlyArray<SessionScenario> =>
  sessionScenarios.filter((scenario) => scenario.only === undefined || scenario.only === agent);
