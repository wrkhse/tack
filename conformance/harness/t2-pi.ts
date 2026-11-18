import { Effect, PubSub, Queue, Schema, Stream, type Scope } from "effect";

import { standInModel, type StandIn } from "../model/stand-in.ts";
import type { SessionScenario } from "../session-scenarios.ts";
import {
  collectSessionRun,
  evidenceOf,
  nextSignal,
  TRAIL_LIMIT,
  waitForMarker,
  type Driver,
  type MarkerTimeout,
  type SessionRun,
  type SettledSignal,
} from "./driver.ts";
import { bundleScenarioPlugins } from "./bundle.ts";
import { PLUGIN_FILE, writePiConfig } from "./pi.ts";
import { piRpc, piRpcArgs, type PiEvent, type PiResponse, type PiRpc } from "./pi-rpc.ts";
import { sandbox } from "./sandbox.ts";

/** The most terminal signals one run may queue before the collector waits. */
const SIGNAL_CAPACITY = 64;

/** The most events kept for a stream that subscribes after them. */
const MAX_HISTORY = 256;

/** The most events buffered for the `events` stream. */
const EVENT_BUFFER = 1024;

/** How long Pi may take to exit once its stdin closes. */
const EXIT_TIMEOUT_MS = 30_000;

/** One event stream served from the single reader that also records signals. */
interface PiEventLog {
  readonly events: (types: ReadonlyArray<string>) => Stream.Stream<Schema.Json>;
  /** The last few events Pi's stream showed, for a wait that has to say what it saw. */
  readonly trail: () => ReadonlyArray<Schema.Json>;
}

/** Pi's wire records are JSON; the driver hands them on as JSON values. */
const asJson = (event: PiEvent): Schema.Json => Schema.decodeUnknownSync(Schema.Json)(event);

const matches =
  (types: ReadonlyArray<string>) =>
  (event: PiEvent): boolean =>
    types.length === 0 || types.includes(event.type);

/**
 * Reads Pi's events once, records each terminal signal, and serves a stream
 * from the history plus what arrives later, so a wait can start after its
 * event and still see it.
 */
const trackEvents = (
  rpc: PiRpc,
  signals: Queue.Queue<SettledSignal>,
  settled: Array<SettledSignal>,
): Effect.Effect<PiEventLog, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.bounded<PiEvent>(EVENT_BUFFER);
    const history: Array<PiEvent> = [];

    yield* Effect.forkScoped(
      rpc.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            history.push(event);

            if (history.length > MAX_HISTORY) history.shift();

            if (event.type === "agent_settled") {
              const signal: SettledSignal = {
                kind: "agent_settled",
                aborted: event.aborted === true,
              };

              settled.push(signal);
              yield* Queue.offer(signals, signal);
            }

            yield* PubSub.publish(pubsub, event);
          }).pipe(Effect.asVoid),
        ),
      ),
    );

    const events = (types: ReadonlyArray<string>): Stream.Stream<Schema.Json> =>
      Stream.suspend(() => {
        const past = history.flatMap((event) => (matches(types)(event) ? [asJson(event)] : []));

        return Stream.concat(
          Stream.fromIterable(past),
          Stream.fromPubSub(pubsub).pipe(Stream.filter(matches(types)), Stream.map(asJson)),
        );
      });

    const trail = (): ReadonlyArray<Schema.Json> =>
      history.slice(-TRAIL_LIMIT).map((event) => asJson(event));

    return { events, trail };
  });

interface PiDriverInput {
  readonly rpc: PiRpc;
  readonly projectDir: string;
  readonly signals: Queue.Queue<SettledSignal>;
  readonly log: PiEventLog;
  readonly model: StandIn;
  readonly settled: ReadonlyArray<SettledSignal>;
}

/**
 * Waits until Pi has bound its extensions and can take commands. RPC mode
 * forwards the agent's session events only; `session_start` is an extension
 * event and never reaches stdout, so one `get_state` answer is the barrier.
 */
const awaitReady = (rpc: PiRpc): Effect.Effect<void> =>
  Effect.gen(function* () {
    const id = "t2-ready";

    yield* rpc.send({ id, type: "get_state" });

    const response = yield* rpc.awaitResponse(id);

    if (!response.success) {
      return yield* Effect.die(
        new Error("tack-conformance: Pi is not ready: " + (response.error ?? "no reason")),
      );
    }

    return yield* Effect.void;
  });

/** A command Pi refuses fails the run with the harness's own reason. */
const refused = (response: PiResponse): Effect.Effect<void> =>
  response.success
    ? Effect.void
    : Effect.die(
        new Error("tack-conformance: Pi refused the command: " + (response.error ?? "no reason")),
      );

/** One RPC session's driver; ids correlate every command with its response. */
const driverFor = (input: PiDriverInput): Driver => {
  let issued = 0;

  const request = (command: {
    readonly type: string;
    readonly message?: string;
  }): Effect.Effect<PiResponse> => {
    issued += 1;

    const id = "t2-" + issued;

    return input.rpc.send({ ...command, id }).pipe(Effect.andThen(input.rpc.awaitResponse(id)));
  };

  return {
    ...evidenceOf(input),
    prompt: (text) => request({ type: "prompt", message: text }).pipe(Effect.flatMap(refused)),
    settle: (timeoutMs) => nextSignal(input.signals, timeoutMs).pipe(Effect.asVoid),
    interrupt: () =>
      request({ type: "abort" }).pipe(
        Effect.flatMap(refused),
        Effect.andThen(nextSignal(input.signals)),
        Effect.asVoid,
      ),
    rebind: () => request({ type: "new_session" }).pipe(Effect.flatMap(refused), Effect.asVoid),
    endSession: () =>
      input.rpc.end().pipe(
        Effect.andThen(input.rpc.exited),
        Effect.timeoutOrElse({
          duration: EXIT_TIMEOUT_MS,
          orElse: () =>
            Effect.die(
              new Error("tack-conformance: Pi did not exit within " + EXIT_TIMEOUT_MS + " ms"),
            ),
        }),
        Effect.asVoid,
      ),
    waitMarker: (name, timeoutMs) => waitForMarker(input.projectDir, name, timeoutMs),
    events: input.log.events,
    trail: input.log.trail,
  };
};

/**
 * Runs one scenario in Pi's RPC mode: the scripted model, one bundle per
 * plugin, a session proven ready before the first prompt, and the actions the
 * scenario's steps make through the driver.
 */
export const runPiSessionScenario = (
  scenario: SessionScenario,
): Effect.Effect<SessionRun, MarkerTimeout, Scope.Scope> =>
  Effect.gen(function* () {
    const box = yield* sandbox;
    const model = yield* standInModel("bash", scenario.standIn);

    const bundles = yield* bundleScenarioPlugins(
      box.dir,
      scenario.plugins,
      "pi",
      PLUGIN_FILE,
      box.pi.env,
    );

    yield* writePiConfig(box.dir, model.baseUrl);

    const rpc = yield* piRpc({
      bin: box.pi.bin,
      args: piRpcArgs(bundles),
      cwd: box.projectDir,
      env: box.pi.env,
    });

    yield* awaitReady(rpc);

    const signals = yield* Queue.bounded<SettledSignal>(SIGNAL_CAPACITY);
    const settled: Array<SettledSignal> = [];
    const log = yield* trackEvents(rpc, signals, settled);

    const driver = driverFor({ rpc, projectDir: box.projectDir, signals, log, model, settled });

    yield* scenario.run(driver, "pi").pipe(Effect.ensuring(rpc.end()));

    return yield* collectSessionRun(box, model, settled, log.trail());
  });
