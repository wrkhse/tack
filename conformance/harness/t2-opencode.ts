import { Effect, Predicate, Schema, Stream, type Scope } from "effect";

import type { StandIn } from "../model/stand-in.ts";
import type { SessionScenario } from "../session-scenarios.ts";
import {
  collectSessionRun,
  evidenceOf,
  SETTLE_TIMEOUT_MS,
  TRAIL_LIMIT,
  waitForEvidence,
  waitForMarker,
  type Driver,
  type MarkerTimeout,
  type SessionRun,
  type SettledSignal,
} from "./driver.ts";
import {
  opencodeServer,
  type OpenCodeServer,
  type SessionOutcome,
  type SessionTurn,
} from "./opencode-server.ts";
import {
  loadOpenCodePlugins,
  prepareOpenCode,
  prepareOpenCodeUnloaded,
  type PreparedOpenCode,
} from "./opencode.ts";

/** The events a session's turns, its start and its end are told through. */
const WITNESS_TYPES = [
  "session.created",
  "session.deleted",
  "session.archived",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

/** How often a wait for a turn to end reads the session again. */
const TURN_POLL_MS = 100;

/** How long the delete's own event may take to arrive. */
const DELETE_TIMEOUT_MS = 10_000;

/** The most of one frame a failure message quotes. */
const MAX_QUOTED_CHARS = 400;

const excerpt = (text: string): string =>
  text.length > MAX_QUOTED_CHARS ? text.slice(0, MAX_QUOTED_CHARS) + "..." : text;

/** Reads one top-level string field from an event. */
const stringField = (event: Schema.Json, key: string): string | null => {
  if (!Predicate.isObject(event)) return null;

  const value = event[key];

  return Predicate.isString(value) ? value : null;
};

/** Reads one string field from an event's `data`, where a session's own fields live. */
const dataField = (event: Schema.Json, key: string): string | null => {
  if (!Predicate.isObject(event)) return null;

  const data = event["data"];

  if (data === undefined || !Predicate.isObject(data)) return null;

  const value = data[key];

  return Predicate.isString(value) ? value : null;
};

/** Keeps the newest frames, dropping the oldest. */
const remember = (frames: Array<Schema.Json>, event: Schema.Json): void => {
  frames.push(event);

  if (frames.length > TRAIL_LIMIT) frames.shift();
};

/** A value a failure message shows, or the word for its absence. */
const shownValue = (value: number | string | undefined): string =>
  value === undefined ? "none" : String(value);

/** The frames a failure message prints, one per line. */
const shownFrames = (frames: ReadonlyArray<Schema.Json>): string =>
  frames.length === 0 ? "none" : frames.map((frame) => excerpt(JSON.stringify(frame))).join("\n");

/** What the event stream showed: this session's frames, and the latest of any session. */
interface Witness {
  readonly frames: () => ReadonlyArray<Schema.Json>;
  readonly recent: () => ReadonlyArray<Schema.Json>;
}

/**
 * Records what the server's event stream says about one session. The stream is
 * this driver's diagnostic channel: a wait that runs out prints the frames it
 * saw, so a missing signal names the server's answer instead of silence.
 */
const trackEvents = (
  server: OpenCodeServer,
  sessionID: string,
  mine: Array<Schema.Json>,
  recent: Array<Schema.Json>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.forkScoped(
    server.events([...WITNESS_TYPES]).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          remember(recent, event);

          if (dataField(event, "sessionID") === sessionID) remember(mine, event);
        }),
      ),
    ),
  ).pipe(Effect.asVoid);

/**
 * The outcome the session reports once the turn that began after `before` has
 * ended. The end this driver already saw left `idle` at `before`, so only a
 * later end counts; while an execution runs, `idle` still holds the previous
 * one's end, so a `busy` later than `idle` says the turn is still running.
 */
const finishedOutcome = (
  before: number | undefined,
  turn: SessionTurn,
): SessionOutcome | undefined => {
  const { outcome, time } = turn;

  if (outcome === undefined || time.idle === undefined) return undefined;

  if (time.busy !== undefined && time.idle < time.busy) return undefined;

  if (before !== undefined && time.idle <= before) return undefined;

  return outcome;
};

/** Waits for the turn to end, then names how it ended. */
const waitForTurn = (
  server: OpenCodeServer,
  sessionID: string,
  before: number | undefined,
  witness: Witness,
  timeoutMs = SETTLE_TIMEOUT_MS,
): Effect.Effect<SessionOutcome> =>
  Effect.gen(function* () {
    const attempts = Math.max(1, Math.ceil(timeoutMs / TURN_POLL_MS));
    let seen: SessionTurn | undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const turn = yield* server.session(sessionID);
      const outcome = finishedOutcome(before, turn);

      if (outcome !== undefined) return outcome;

      seen = turn;

      yield* Effect.sleep(TURN_POLL_MS);
    }

    return yield* Effect.die(
      new Error(
        "tack-conformance: the turn on session " +
          sessionID +
          " did not end within " +
          timeoutMs +
          " ms" +
          "\nlast read: outcome " +
          shownValue(seen?.outcome) +
          ", busy " +
          shownValue(seen?.time.busy) +
          ", idle " +
          shownValue(seen?.time.idle) +
          ", after " +
          shownValue(before) +
          "\nframes for this session:\n" +
          shownFrames(witness.frames()) +
          "\nlast frames on the stream:\n" +
          shownFrames(witness.recent()),
      ),
    );
  });

/** Waits for the server's own `session.deleted` frame for this session. */
const waitForDeleted = (witness: Witness): Effect.Effect<void> =>
  waitForEvidence(
    "the server's session.deleted frame",
    Effect.sync(() => {
      const frames = witness.frames();

      return {
        ready: frames.some((frame) => stringField(frame, "type") === "session.deleted"),
        seen:
          "frames for this session:\n" +
          shownFrames(frames) +
          "\nlast frames on the stream:\n" +
          shownFrames(witness.recent()),
      };
    }),
    DELETE_TIMEOUT_MS,
  );

/** One turn's end: the terminal event the session's outcome names, and its abort. */
const signalOf = (outcome: SessionOutcome): SettledSignal => ({
  kind: "session.execution." + outcome,
  aborted: outcome === "interrupted",
});

interface OpenCodeDriverInput {
  readonly server: OpenCodeServer;
  readonly sessionID: string;
  readonly projectDir: string;
  readonly model: StandIn;
  readonly settled: Array<SettledSignal>;
  readonly witness: Witness;
}

/**
 * One server session's driver; every action is the client's own call. A turn
 * is followed through the session's own record, so a turn that never ends is a
 * session that never reported one, not a missed stream event.
 */
const driverFor = (input: OpenCodeDriverInput): Driver => {
  let before: number | undefined;

  const settle = (timeoutMs?: number): Effect.Effect<void> =>
    Effect.flatMap(
      waitForTurn(input.server, input.sessionID, before, input.witness, timeoutMs),
      (outcome) =>
        Effect.sync(() => {
          input.settled.push(signalOf(outcome));
        }),
    );

  return {
    ...evidenceOf(input),
    prompt: (text) =>
      Effect.gen(function* () {
        const turn = yield* input.server.session(input.sessionID);

        yield* input.server.prompt(input.sessionID, text);

        before = turn.time.idle;
      }),
    settle,
    interrupt: () => input.server.interrupt(input.sessionID).pipe(Effect.andThen(settle())),
    rebind: () =>
      Effect.die(new Error("tack-conformance: OpenCode has no session rebind for a row to use")),
    endSession: () =>
      input.server
        .deleteSession(input.sessionID)
        .pipe(Effect.andThen(waitForDeleted(input.witness))),
    waitMarker: (name, timeoutMs) => waitForMarker(input.projectDir, name, timeoutMs),
    events: (types) => input.server.events(types),
    trail: () => input.witness.frames(),
  };
};

/** Runs one scenario on a server session and collects what the run left. */
const runOnSession = (
  server: OpenCodeServer,
  sessionID: string,
  prepared: PreparedOpenCode,
  scenario: SessionScenario,
): Effect.Effect<SessionRun, MarkerTimeout, Scope.Scope> =>
  Effect.gen(function* () {
    const settled: Array<SettledSignal> = [];
    const mine: Array<Schema.Json> = [];
    const recent: Array<Schema.Json> = [];

    yield* trackEvents(server, sessionID, mine, recent);

    const witness: Witness = { frames: () => [...mine], recent: () => [...recent] };

    const driver = driverFor({
      server,
      sessionID,
      projectDir: prepared.box.projectDir,
      model: prepared.model,
      settled,
      witness,
    });

    yield* scenario.run(driver, "opencode").pipe(Effect.ensuring(server.stop()));

    return yield* collectSessionRun(prepared.box, prepared.model, settled, witness.frames());
  });

/**
 * Runs one scenario against a private OpenCode server: the scripted model, one
 * bundle per plugin, a session created after the plugin loads, and the actions
 * the scenario's steps make through the driver.
 */
export const runOpenCodeSessionScenario = (
  scenario: SessionScenario,
): Effect.Effect<SessionRun, MarkerTimeout, Scope.Scope> =>
  Effect.gen(function* () {
    const prepared = yield* prepareOpenCode(
      scenario.plugins,
      scenario.standIn,
      scenario.shellPermission,
    );

    const server = yield* opencodeServer(prepared.box);

    yield* server.awaitPlugin(prepared.box.projectDir);

    const created = yield* server.createSession({ directory: prepared.box.projectDir });

    return yield* runOnSession(server, created.id, prepared, scenario);
  });

/**
 * Runs one scenario on a session created before its plugin loaded: start the
 * server without the plugin, create the session, then write the plugin config
 * and reload the location before the scenario's first action.
 */
export const runOpenCodeResumedScenario = (
  scenario: SessionScenario,
): Effect.Effect<SessionRun, MarkerTimeout, Scope.Scope> =>
  Effect.gen(function* () {
    const prepared = yield* prepareOpenCodeUnloaded(
      scenario.plugins,
      scenario.standIn,
      scenario.shellPermission,
    );

    const server = yield* opencodeServer(prepared.box);
    const created = yield* server.createSession({ directory: prepared.box.projectDir });

    yield* loadOpenCodePlugins(prepared, server);

    return yield* runOnSession(server, created.id, prepared, scenario);
  });
