import { Effect, Queue, Schema, type Stream } from "effect";

import type { ChatRequest, StandIn } from "../model/stand-in.ts";
import { parseLoaded } from "../plugins/loaded.ts";
import { markerFile, markersIn } from "./markers.ts";
import { recorded } from "./recorder.ts";
import { readOptionalText, type Sandbox } from "./sandbox.ts";

/** How long a marker wait may take when a scenario names no bound. */
const MARKER_TIMEOUT_MS = 20_000;

/** How often a marker wait looks for the file. */
const MARKER_POLL_MS = 100;

/** How long a turn, started by a prompt or stopped by an interrupt, may take. */
const SETTLE_TIMEOUT_MS = 30_000;

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
  /** Waits for the turn to end, whichever way it ended. */
  readonly settle: () => Effect.Effect<void>;
  /** Stops the running turn and waits for it to end. */
  readonly interrupt: () => Effect.Effect<void>;
  /** DELETE on OpenCode, stdin close on Pi. */
  readonly endSession: () => Effect.Effect<void>;
  /** Waits for a plugin's marker file and returns its text. */
  readonly waitMarker: (name: string, timeoutMs?: number) => Effect.Effect<string, MarkerTimeout>;
  /** Streams the agent's own events of the given types; empty takes every type. */
  readonly events: (types: ReadonlyArray<string>) => Stream.Stream<Schema.Json>;
}

/** What one long-lived run left behind. */
export interface SessionRun {
  readonly requests: ReadonlyArray<ChatRequest>;
  readonly recorded: ReadonlyArray<string>;
  readonly loaded: ReadonlyArray<string>;
  readonly markers: ReadonlyMap<string, string>;
  /** The harness signals that ended each turn the driver waited on, in order. */
  readonly settled: ReadonlyArray<SettledSignal>;
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

/** Takes the next turn's terminal signal, bounded so a silent agent fails the run. */
export const nextSignal = (signals: Queue.Queue<SettledSignal>): Effect.Effect<SettledSignal> =>
  Queue.take(signals).pipe(
    Effect.timeoutOrElse({
      duration: SETTLE_TIMEOUT_MS,
      orElse: () =>
        Effect.die(
          new Error(
            "tack-conformance: no terminal turn signal within " + SETTLE_TIMEOUT_MS + " ms",
          ),
        ),
    }),
  );

/** Reads what a long-lived run left in its sandbox, with the signals it settled on. */
export const collectSessionRun = (
  box: Sandbox,
  model: StandIn,
  settled: ReadonlyArray<SettledSignal>,
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
    };
  });
