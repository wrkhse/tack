import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Option,
  Predicate,
  PubSub,
  Queue,
  Schema,
  Stream,
  type Scope,
} from "effect";

import { duplexChild } from "./duplex.ts";

/** How long a response or event wait may take before the test fails. */
const DEFAULT_WAIT_MS = 30_000;

/** How long the child may run after `end` closes its stdin. */
const EXIT_TIMEOUT_MS = 120_000;

/** The most event records kept for a wait that starts after the event. */
const MAX_HISTORY = 256;

/** The most events buffered for the `events` stream. */
const EVENT_BUFFER = 10_000;

/** The most unclaimed responses kept before the oldest is dropped. */
const MAX_UNCLAIMED = 100;

const ResponseSchema = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.String,
  success: Schema.Boolean,
  data: Schema.optional(Schema.Json),
  error: Schema.optional(Schema.String),
});

const EventSchema = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  aborted: Schema.optional(Schema.Boolean),
});

const KindSchema = Schema.Struct({ type: Schema.String });

const CommandSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  message: Schema.optional(Schema.String),
  streamingBehavior: Schema.optional(Schema.Literals(["steer", "followUp"])),
});

/** One command written to Pi's stdin, correlated by its id. */
export type PiCommand = typeof CommandSchema.Type;

/** One command response: the record that repeats the command's id. */
export type PiResponse = typeof ResponseSchema.Type;

/** One session event: every record that is not a command response. */
export type PiEvent = typeof EventSchema.Type;

/** A record Pi wrote on stdout. */
type PiRecord = PiResponse | PiEvent;

/** What an event wait looks for: a type name, or a predicate over the event. */
export type EventMatch = string | ((event: PiEvent) => boolean);

/** One Pi JSONL client, bound to the child it talks to. */
export interface PiRpc {
  /** Writes one command as a line and waits for stdin to accept it. */
  readonly send: (command: PiCommand) => Effect.Effect<void>;
  /** Waits for the response that repeats `id`, including one already received. */
  readonly awaitResponse: (id: string, timeoutMs?: number) => Effect.Effect<PiResponse>;
  /** Every event Pi emits, without command responses. Consume it once. */
  readonly events: Stream.Stream<PiEvent>;
  /** Waits for the first matching event, including one already received. */
  readonly awaitEvent: (match: EventMatch, timeoutMs?: number) => Effect.Effect<PiEvent>;
  /** Closes stdin, which is Pi's orderly shutdown request. */
  readonly end: () => Effect.Effect<void>;
}

/** How to start Pi in RPC mode. */
export interface PiRpcSpec {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

interface RpcState {
  readonly pubsub: PubSub.PubSub<PiRecord>;
  readonly events: Queue.Queue<PiEvent, Cause.Done>;
  readonly failure: Deferred.Deferred<never, Error>;
  readonly responses: Map<string, PiResponse>;
  readonly waiters: Map<string, Deferred.Deferred<PiResponse>>;
  readonly history: Array<PiEvent>;
}

/**
 * The arguments that start Pi in RPC mode. CLI options still select the model
 * and load the extensions; the positional prompt is print mode only, so it is
 * never passed here.
 */
export const piRpcArgs = (bundles: ReadonlyArray<string>): ReadonlyArray<string> => [
  "--mode",
  "rpc",
  "--no-session",
  "--provider",
  "fake",
  "--model",
  "scripted",
  "-ns",
  "-np",
  "-nc",
  "--no-mcp",
  ...bundles.flatMap((bundle) => ["-e", bundle]),
];

const malformed = (line: string, detail: string): Error =>
  new Error("tack-conformance: unreadable Pi record: " + line + "\n" + detail);

/** Decodes one stdout line, failing with the line when its shape is unknown. */
const parseRecord = (line: string): Effect.Effect<PiRecord> =>
  Effect.suspend(() => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      return Effect.die(malformed(line, "not JSON"));
    }

    return Schema.decodeUnknownEffect(KindSchema)(parsed).pipe(
      Effect.mapError(() => malformed(line, "a record must carry a string type")),
      Effect.orDie,
      Effect.flatMap((record) => {
        const schema = record.type === "response" ? ResponseSchema : EventSchema;

        return Schema.decodeUnknownEffect(schema)(parsed).pipe(
          Effect.mapError((cause) => malformed(line, cause.message)),
          Effect.orDie,
        );
      }),
    );
  });

const isResponse = (record: PiRecord): record is PiResponse => record.type === "response";

/** Keeps the unclaimed response map bounded; the oldest response goes first. */
const dropOldestResponse = (state: RpcState): void => {
  if (state.responses.size <= MAX_UNCLAIMED) return;

  const oldest = state.responses.keys().next();

  if (!oldest.done) state.responses.delete(oldest.value);
};

/** Hands a response to its waiter, or keeps it for a wait that starts later. */
const deliverResponse = (state: RpcState, response: PiResponse): Effect.Effect<void> =>
  Effect.suspend(() => {
    const waiter = state.waiters.get(response.id);

    if (waiter !== undefined) {
      state.waiters.delete(response.id);

      return Deferred.succeed(waiter, response).pipe(Effect.asVoid);
    }

    state.responses.set(response.id, response);
    dropOldestResponse(state);

    return Effect.void;
  });

/** Records one event for later waits and publishes it to every subscriber. */
const dispatch = (record: PiRecord, state: RpcState): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (isResponse(record)) return deliverResponse(state, record);

    state.history.push(record);

    if (state.history.length > MAX_HISTORY) state.history.shift();

    if (!Queue.offerUnsafe(state.events, record)) {
      return Effect.die(
        new Error("tack-conformance: more than " + EVENT_BUFFER + " events buffered"),
      );
    }

    return PubSub.publish(state.pubsub, record).pipe(Effect.asVoid);
  });

/**
 * Reads stdout until it ends. A malformed record fails the client: the
 * `events` stream fails, and every wait fails with the same message.
 */
const reader = (lines: Stream.Stream<string>, state: RpcState): Effect.Effect<void> =>
  Stream.runForEach(lines, (line) =>
    parseRecord(line).pipe(Effect.flatMap((record) => dispatch(record, state))),
  ).pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit)) return Queue.end(state.events).pipe(Effect.asVoid);

      if (Cause.hasInterruptsOnly(exit.cause)) return Effect.void;

      return finishFailure(state, exit.cause);
    }),
  );

/** Reports a protocol failure once, on the events stream and on every wait. */
const finishFailure = (state: RpcState, cause: Cause.Cause<never>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const error = new Error("tack-conformance: the Pi protocol failed:\n" + Cause.pretty(cause));

    Queue.failCauseUnsafe(state.events, Cause.die(error));
    yield* Deferred.fail(state.failure, error).pipe(Effect.ignore);
  });

/** Waits for one response, replaying one that arrived before the wait. */
const awaitResponse = (state: RpcState, id: string, timeoutMs: number): Effect.Effect<PiResponse> =>
  Effect.gen(function* () {
    const stored = state.responses.get(id);

    if (stored !== undefined) {
      state.responses.delete(id);

      return stored;
    }

    const waiter = yield* Deferred.make<PiResponse>();
    const raced = state.responses.get(id);

    if (raced !== undefined) {
      state.responses.delete(id);

      return raced;
    }

    state.waiters.set(id, waiter);

    return yield* Effect.raceFirst(
      Deferred.await(waiter),
      Deferred.await(state.failure).pipe(Effect.orDie),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          state.waiters.delete(id);
        }),
      ),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.die(
          new Error("tack-conformance: no response for " + id + " within " + timeoutMs + " ms"),
        ),
    }),
  );

const eventName = (match: EventMatch): string =>
  Predicate.isString(match) ? match : "the requested";

const matches =
  (match: EventMatch) =>
  (event: PiEvent): boolean =>
    Predicate.isString(match) ? event.type === match : match(event);

/** Names the recent event types, for a failed wait's message. */
const sawTypes = (state: RpcState): string =>
  state.history.length === 0
    ? "none"
    : state.history
        .slice(-10)
        .map((event) => event.type)
        .join(", ");

/** Waits for one event, replaying one that arrived before the wait. */
const awaitEvent = (
  state: RpcState,
  match: EventMatch,
  timeoutMs: number,
): Effect.Effect<PiEvent> =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(state.pubsub);
      const past = state.history.find(matches(match));

      if (past !== undefined) return past;

      const next = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(matches(match)),
        Stream.runHead,
      );

      if (Option.isNone(next)) {
        return yield* Effect.die(
          new Error(
            "tack-conformance: the Pi event stream ended while waiting for " +
              eventName(match) +
              " event",
          ),
        );
      }

      return next.value;
    }),
  ).pipe(
    Effect.raceFirst(Deferred.await(state.failure).pipe(Effect.orDie)),
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.die(
          new Error(
            "tack-conformance: no " +
              eventName(match) +
              " event within " +
              timeoutMs +
              " ms; saw " +
              sawTypes(state),
          ),
        ),
    }),
  );

/**
 * Starts Pi in RPC mode and returns the client for it. The child, the reader
 * fiber, and the subscriptions all close with the surrounding scope.
 */
export const piRpc = (spec: PiRpcSpec): Effect.Effect<PiRpc, never, Scope.Scope> =>
  Effect.gen(function* () {
    const child = yield* duplexChild({ ...spec, timeoutMs: EXIT_TIMEOUT_MS });
    const pubsub = yield* PubSub.bounded<PiRecord>(EVENT_BUFFER);
    const events = yield* Queue.bounded<PiEvent, Cause.Done>(EVENT_BUFFER);
    const failure = yield* Deferred.make<never, Error>();

    const state: RpcState = {
      pubsub,
      events,
      failure,
      responses: new Map(),
      waiters: new Map(),
      history: [],
    };

    yield* Effect.forkScoped(reader(child.lines, state));

    return {
      send: (command) => child.write(JSON.stringify(command)),
      awaitResponse: (id, timeoutMs = DEFAULT_WAIT_MS) => awaitResponse(state, id, timeoutMs),
      events: Stream.fromQueue(events).pipe(Stream.filter((event) => event.id === undefined)),
      awaitEvent: (match, timeoutMs = DEFAULT_WAIT_MS) => awaitEvent(state, match, timeoutMs),
      end: child.end,
    };
  });
