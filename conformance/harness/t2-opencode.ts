import { DateTime, Deferred, Effect, Predicate, Schema, Stream, type Scope } from "effect";

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
  type EventStreamObserver,
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

/** How long the server may take to answer the witness stream. */
const OPEN_TIMEOUT_MS = 10_000;

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

/** One connection the witness stream made: when it opened, and when it ended. */
interface WitnessConnection {
  readonly openedAt: string;
  closedAt?: string;
}

/** What the witness stream did: its connections, its frames, and when the DELETE went out. */
interface WitnessStream {
  readonly connections: Array<WitnessConnection>;
  frames: number;
  deleteAt?: string;
}

/** The session a witness attributes its frames to; unset until the server creates it. */
interface WitnessTarget {
  id?: string;
}

/**
 * Records every connection and every frame of one witness stream, and completes
 * `opened` on the first, so a caller can wait for the subscription to exist.
 */
const watchStream = (
  stream: WitnessStream,
  opened: Deferred.Deferred<void>,
): EventStreamObserver => ({
  opened: (at) => {
    stream.connections.push({ openedAt: at });

    Deferred.doneUnsafe(opened, Effect.void);
  },
  closed: (at) => {
    const open = stream.connections.findLast((connection) => connection.closedAt === undefined);

    if (open !== undefined) open.closedAt = at;
  },
  frame: () => {
    stream.frames += 1;
  },
});

/** Whether the stream had already ended when the DELETE went out. */
const retiredBeforeDelete = (stream: WitnessStream): string => {
  if (stream.deleteAt === undefined) return "no DELETE was sent";

  const closedAt = stream.connections.at(-1)?.closedAt;

  return closedAt !== undefined && closedAt <= stream.deleteAt ? "yes" : "no";
};

/** One line on the witness stream itself, for a failure that has to say whether it was there. */
const describeWitnessStream = (stream: WitnessStream): string => {
  const first = stream.connections[0];
  const reconnects = stream.connections.slice(1);

  return (
    "witness stream: connected " +
    (first?.openedAt ?? "never") +
    ", closed " +
    (stream.connections.at(-1)?.closedAt ?? "never") +
    ", reconnects " +
    (reconnects.length === 0
      ? "none"
      : reconnects.map((connection) => connection.openedAt).join(", ")) +
    ", frames " +
    stream.frames +
    ", delete at " +
    (stream.deleteAt ?? "never") +
    ", retired before the DELETE: " +
    retiredBeforeDelete(stream)
  );
};

/** What the event stream showed: this session's frames, and the latest of any session. */
interface Witness {
  readonly frames: () => ReadonlyArray<Schema.Json>;
  readonly recent: () => ReadonlyArray<Schema.Json>;
  /** Stamps the DELETE's send time, so the stream's state at that moment is known. */
  readonly beginDelete: Effect.Effect<void>;
  /** One line on the witness stream: its connection, its close and its frames. */
  readonly stream: () => string;
}

/**
 * Records what the server's event stream says about one session. The stream is
 * this driver's diagnostic channel: a wait that runs out prints the frames it
 * saw, so a missing signal names the server's answer instead of silence.
 */
const trackEvents = (
  server: OpenCodeServer,
  target: WitnessTarget,
  mine: Array<Schema.Json>,
  recent: Array<Schema.Json>,
  stream: WitnessStream,
  opened: Deferred.Deferred<void>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.forkScoped(
    server.events([...WITNESS_TYPES], watchStream(stream, opened)).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          remember(recent, event);

          if (target.id !== undefined && dataField(event, "sessionID") === target.id) {
            remember(mine, event);
          }
        }),
      ),
    ),
  ).pipe(Effect.asVoid);

/**
 * A witness the server has answered, carrying the session it attributes later
 * frames to. It opens before the session exists: the subscription replays
 * nothing, so a frame published before it registers is lost for good.
 */
export interface WatchedSession extends Witness {
  /** Attributes frames from now on to this session. */
  readonly attribute: (sessionID: string) => void;
}

/**
 * Opens the witness stream and waits until the server has answered it. Call
 * this before the session, or before the first action that can end one: the
 * wait is the guarantee that the subscription exists before any frame.
 */
export const watchSession = (
  server: OpenCodeServer,
): Effect.Effect<WatchedSession, never, Scope.Scope> =>
  Effect.gen(function* () {
    const target: WitnessTarget = {};
    const mine: Array<Schema.Json> = [];
    const recent: Array<Schema.Json> = [];
    const stream: WitnessStream = { connections: [], frames: 0 };
    const opened = yield* Deferred.make<void>();

    yield* trackEvents(server, target, mine, recent, stream, opened);

    yield* Deferred.await(opened).pipe(
      Effect.timeoutOrElse({
        duration: OPEN_TIMEOUT_MS,
        orElse: () =>
          Effect.die(
            new Error(
              "tack-conformance: the OpenCode event stream did not open within " +
                OPEN_TIMEOUT_MS +
                " ms\n" +
                describeWitnessStream(stream),
            ),
          ),
      }),
    );

    return {
      frames: () => [...mine],
      recent: () => [...recent],
      beginDelete: DateTime.now.pipe(
        Effect.map((now) => {
          stream.deleteAt = DateTime.formatIso(now);
        }),
      ),
      stream: () => describeWitnessStream(stream),
      attribute: (sessionID) => {
        target.id = sessionID;
      },
    };
  });

/**
 * Creates the session after its witness is open, then attributes it. The order
 * is the guarantee: no frame about the session can be published before the
 * subscription exists, and every later frame is kept.
 */
export const createWatchedSession = (
  server: OpenCodeServer,
  directory: string,
): Effect.Effect<{ readonly id: string; readonly witness: WatchedSession }, never, Scope.Scope> =>
  Effect.gen(function* () {
    const witness = yield* watchSession(server);
    const created = yield* server.createSession({ directory });

    witness.attribute(created.id);

    return { id: created.id, witness };
  });

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
          shownFrames(witness.recent()) +
          "\n" +
          witness.stream(),
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
          shownFrames(witness.recent()) +
          "\n" +
          witness.stream(),
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
      Effect.gen(function* () {
        yield* input.witness.beginDelete;
        yield* input.server.deleteSession(input.sessionID);
        yield* waitForDeleted(input.witness);
      }),
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
  witness: WatchedSession,
): Effect.Effect<SessionRun, MarkerTimeout, Scope.Scope> =>
  Effect.gen(function* () {
    const settled: Array<SettledSignal> = [];

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

    // The witness opens before the session, so the server's subscription is in
    // place before the first frame about it can be published.
    const created = yield* createWatchedSession(server, prepared.box.projectDir);

    return yield* runOnSession(server, created.id, prepared, scenario, created.witness);
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

    // As in the loaded path, the witness is open before the session exists.
    const created = yield* createWatchedSession(server, prepared.box.projectDir);

    yield* loadOpenCodePlugins(prepared, server);

    return yield* runOnSession(server, created.id, prepared, scenario, created.witness);
  });
