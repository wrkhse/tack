import { Effect, Predicate, Queue, Schema, Stream, type Scope } from "effect";

import type { StandIn } from "../model/stand-in.ts";
import type { SessionScenario } from "../session-scenarios.ts";
import {
  collectSessionRun,
  evidenceOf,
  nextSignal,
  waitForMarker,
  type Driver,
  type MarkerTimeout,
  type SessionRun,
  type SettledSignal,
} from "./driver.ts";
import { opencodeServer, type OpenCodeServer } from "./opencode-server.ts";
import { prepareOpenCode } from "./opencode.ts";

/** The most terminal signals one run may queue before the collector waits. */
const SIGNAL_CAPACITY = 64;

/** The events that end one execution, whichever way it ended. */
const TERMINAL_TYPES = [
  "session.execution.succeeded",
  "session.execution.interrupted",
  "session.execution.failed",
] as const;

/** Reads one top-level string field from an OpenCode event. */
const stringField = (event: Schema.Json, key: string): string | null => {
  if (!Predicate.isObject(event)) return null;

  const value = event[key];

  return Predicate.isString(value) ? value : null;
};

/** An interruption is the aborted turn, carried the way Pi carries it. */
const signalOf = (kind: string): SettledSignal => ({
  kind,
  aborted: kind === "session.execution.interrupted",
});

/** Records each of one session's terminal executions, in order. */
const trackExecutions = (
  server: OpenCodeServer,
  sessionID: string,
  signals: Queue.Queue<SettledSignal>,
  settled: Array<SettledSignal>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.forkScoped(
    server.events([...TERMINAL_TYPES]).pipe(
      Stream.filter((event) => stringField(event, "sessionID") === sessionID),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const signal = signalOf(stringField(event, "type") ?? "unknown");

          settled.push(signal);
          yield* Queue.offer(signals, signal);
        }),
      ),
    ),
  ).pipe(Effect.asVoid);

interface OpenCodeDriverInput {
  readonly server: OpenCodeServer;
  readonly sessionID: string;
  readonly projectDir: string;
  readonly signals: Queue.Queue<SettledSignal>;
  readonly model: StandIn;
  readonly settled: ReadonlyArray<SettledSignal>;
}

/** One server session's driver; every action is the client's own call. */
const driverFor = (input: OpenCodeDriverInput): Driver => ({
  ...evidenceOf(input),
  prompt: (text) => input.server.prompt(input.sessionID, text),
  settle: () => nextSignal(input.signals).pipe(Effect.asVoid),
  interrupt: () =>
    input.server
      .interrupt(input.sessionID)
      .pipe(Effect.andThen(nextSignal(input.signals)), Effect.asVoid),
  endSession: () => input.server.deleteSession(input.sessionID),
  waitMarker: (name, timeoutMs) => waitForMarker(input.projectDir, name, timeoutMs),
  events: (types) => input.server.events(types),
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
    const { box, model } = yield* prepareOpenCode(scenario.plugins, scenario.standIn);

    const server = yield* opencodeServer(box);

    yield* server.awaitPlugin(box.projectDir);

    const created = yield* server.createSession({ directory: box.projectDir });
    const signals = yield* Queue.bounded<SettledSignal>(SIGNAL_CAPACITY);
    const settled: Array<SettledSignal> = [];

    yield* trackExecutions(server, created.id, signals, settled);

    const driver = driverFor({
      server,
      sessionID: created.id,
      projectDir: box.projectDir,
      signals,
      model,
      settled,
    });

    yield* scenario.run(driver).pipe(Effect.ensuring(server.stop()));

    return yield* collectSessionRun(box, model, settled);
  });
