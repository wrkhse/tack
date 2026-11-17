import { Effect, Queue, Schema, type Stream } from "effect";

import type { ChatRequest, StandIn } from "../model/stand-in.ts";
import { parseLoaded } from "../plugins/loaded.ts";
import { MarkerFile, markerFile, markersIn, type MarkerObservation } from "./markers.ts";
import { recorded } from "./recorder.ts";
import { readOptionalText, type Sandbox } from "./sandbox.ts";

/** How long a marker wait may take when a scenario names no bound. */
const MARKER_TIMEOUT_MS = 20_000;

/** How often a marker wait looks for the file. */
const MARKER_POLL_MS = 100;

/** How long a wait for a run's evidence may take. */
const EVIDENCE_TIMEOUT_MS = 25_000;

/** How often a wait for a run's evidence looks again. */
const EVIDENCE_POLL_MS = 100;

/** How long a turn, started by a prompt or stopped by an interrupt, may take. */
export const SETTLE_TIMEOUT_MS = 30_000;

/** How many of an agent's own events a driver keeps for a failure message. */
export const TRAIL_LIMIT = 5;

/** How a turn ended, named by the harness signal that reported it. */
export interface SettledSignal {
  readonly kind: string;
  /** Pi's `agent_settled.aborted`; OpenCode's interruption, carried the same way. */
  readonly aborted: boolean;
}

/** The turn did not end within the bound, so the scenario cannot prove its steps. */
export class MarkerTimeout extends Schema.TaggedError<
  MarkerTimeout,
  { readonly brand: unique symbol }
>()("MarkerTimeout", {
  marker: Schema.String,
  timeoutMs: Schema.Finite,
}) {
  override get message(): string {
    return (
      "tack-conformance: the " +
      this.marker +
      " marker did not appear within " +
      this.timeoutMs +
      " ms"
    );
  }
}

/**
 * What a scenario drives: one long-lived session, whichever agent holds it.
 * Actions are the harness's own calls, never a plugin's.
 */
export interface Driver {
  /** Sends one prompt. It returns when the agent admits the prompt. */
  readonly prompt: (text: string) => Effect.Effect<void>;
  /** Waits for the turn to end, whichever way it ended; `timeoutMs` overrides the bound. */
  readonly settle: (timeoutMs?: number) => Effect.Effect<void>;
  /** Stops the running turn and waits for it to end. */
  readonly interrupt: () => Effect.Effect<void>;
  /** DELETE on OpenCode, stdin close on Pi. */
  readonly endSession: () => Effect.Effect<void>;
  /** Waits for a plugin's marker file and returns its text. */
  readonly waitMarker: (name: string, timeoutMs?: number) => Effect.Effect<string, MarkerTimeout>;
  /** The stand-in's requests so far, in arrival order; each run reads them again. */
  readonly requests: Effect.Effect<ReadonlyArray<ChatRequest>>;
  /** One plugin's observations so far; empty before it records the first. */
  readonly observations: (name: string) => Effect.Effect<ReadonlyArray<MarkerObservation>>;
  /** The terminal signals collected so far, in order. */
  readonly signals: () => ReadonlyArray<SettledSignal>;
  /** Streams the agent's own events of the given types; empty takes every type. */
  readonly events: (types: ReadonlyArray<string>) => Stream.Stream<Schema.Json>;
  /**
   * The last few events the agent's own stream showed of this session, for a
   * wait that has to say what it saw instead of reporting silence.
   */
  readonly trail: () => ReadonlyArray<Schema.Json>;
}

/** Reads one plugin's observations as they stand; empty before it records the first. */
const readObservations = (
  dir: string,
  name: string,
): Effect.Effect<ReadonlyArray<MarkerObservation>> =>
  Effect.gen(function* () {
    const text = yield* readOptionalText(markerFile(dir, name));

    if (text === null) return [];

    return yield* Schema.decodeEffect(MarkerFile)(text).pipe(Effect.orDie);
  });

/** What the evidence reads need: the stand-in, the project directory, and the signals. */
export interface EvidenceSource {
  readonly model: StandIn;
  readonly projectDir: string;
  readonly settled: ReadonlyArray<SettledSignal>;
}

/**
 * The three reads every driver offers over one run's evidence: the stand-in's
 * requests, one plugin's observations, and the turn signals collected so far.
 */
export const evidenceOf = (
  source: EvidenceSource,
): Pick<Driver, "requests" | "observations" | "signals"> => ({
  requests: source.model.requests,
  observations: (name) => readObservations(source.projectDir, name),
  signals: () => [...source.settled],
});

/** What one long-lived run left behind. */
export interface SessionRun {
  readonly requests: ReadonlyArray<ChatRequest>;
  readonly recorded: ReadonlyArray<string>;
  readonly loaded: ReadonlyArray<string>;
  readonly markers: ReadonlyMap<string, string>;
  /** The harness signals that ended each turn the driver waited on, in order. */
  readonly settled: ReadonlyArray<SettledSignal>;
  /** The last events the agent's own stream showed of the session, in order. */
  readonly trail: ReadonlyArray<Schema.Json>;
}

/** Waits for one plugin's marker file, polling until the bound runs out. */
export const waitForMarker = (
  dir: string,
  name: string,
  timeoutMs = MARKER_TIMEOUT_MS,
): Effect.Effect<string, MarkerTimeout> =>
  Effect.gen(function* () {
    const file = markerFile(dir, name);
    const attempts = Math.max(1, Math.ceil(timeoutMs / MARKER_POLL_MS));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const text = yield* readOptionalText(file);

      if (text !== null) return text;

      yield* Effect.sleep(MARKER_POLL_MS);
    }

    return yield* new MarkerTimeout({ marker: name, timeoutMs });
  });

/** What one evidence probe saw: whether the wait is over, and what to report if it is not. */
export interface EvidenceProbe {
  readonly ready: boolean;
  readonly seen: string;
}

/**
 * Polls one probe until the evidence its row asserts has arrived. A fixed
 * pause cannot decide a pass: on a slower runner the moment arrives late, so
 * the wait looks again every 100 ms and fails at its bound with what it saw.
 */
export const waitForEvidence = (
  what: string,
  probe: Effect.Effect<EvidenceProbe>,
  timeoutMs = EVIDENCE_TIMEOUT_MS,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const attempts = Math.max(1, Math.ceil(timeoutMs / EVIDENCE_POLL_MS));
    let seen = "no probe answered";

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const found = yield* probe;

      if (found.ready) return;

      seen = found.seen;

      yield* Effect.sleep(EVIDENCE_POLL_MS);
    }

    yield* gaveUp(what, timeoutMs, seen);
  });

/** A wait that ran out, named for its row and carrying what the last probe saw. */
const gaveUp = (what: string, timeoutMs: number, seen: string): Effect.Effect<void> =>
  Effect.die(
    new Error("tack-conformance: " + what + " did not arrive within " + timeoutMs + " ms\n" + seen),
  );

/** Takes the next turn's terminal signal, bounded so a silent agent fails the run. */
export const nextSignal = (
  signals: Queue.Queue<SettledSignal>,
  timeoutMs = SETTLE_TIMEOUT_MS,
): Effect.Effect<SettledSignal> =>
  Queue.take(signals).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.die(
          new Error("tack-conformance: no terminal turn signal within " + timeoutMs + " ms"),
        ),
    }),
  );

/** Reads what a long-lived run left in its sandbox, with the signals it settled on. */
export const collectSessionRun = (
  box: Sandbox,
  model: StandIn,
  settled: ReadonlyArray<SettledSignal>,
  trail: ReadonlyArray<Schema.Json>,
): Effect.Effect<SessionRun> =>
  Effect.gen(function* () {
    const requests = yield* model.requests;
    const recorderLines = yield* recorded(box.recorderFile);
    const loadedText = yield* readOptionalText(box.loadedFile);
    const markers = yield* markersIn(box.projectDir);

    return {
      requests,
      recorded: recorderLines,
      loaded: loadedText === null ? [] : parseLoaded(loadedText),
      markers,
      settled,
      trail,
    };
  });
