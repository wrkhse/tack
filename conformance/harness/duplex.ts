import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { Cause, Deferred, Effect, Option, Queue, Stream, type Scope } from "effect";

/** The largest line the reader accepts, in bytes. */
const MAX_LINE_BYTES = 1024 * 1024;

/** The most complete lines the stream holds before it fails instead of growing. */
const MAX_BUFFERED_LINES = 10_000;

/** The most of a child's stderr kept for an assertion message, in bytes. */
const MAX_STDERR_BYTES = 8 * 1024;

/** How long the finalizer waits after SIGTERM before it sends SIGKILL. */
const KILL_GRACE_MS = 5_000;

const LF = 0x0a;

type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>;

/** One child to start: what to run, where, and with which environment. */
export interface DuplexSpec {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * How long `exited` waits for the child before it fails with the child's
   * stderr. The scope finalizer still terminates a child that overruns it.
   */
  readonly timeoutMs: number;
  /**
   * How long the scope finalizer waits after SIGTERM before it sends SIGKILL.
   * Default 5 seconds; a test that proves the escalation shortens it.
   */
  readonly graceMs?: number;
}

/**
 * A child kept alive for a conversation. `lines` is one stream from the
 * child's stdout, split only on LF; it fails on a line over 1 MiB, on more
 * than 10 000 buffered lines, and on an unexpected exit.
 */
export interface Duplex {
  /** Sends one line, with its newline, and waits for stdin to accept it. */
  readonly write: (line: string) => Effect.Effect<void>;
  /** Every complete stdout line, in order. Consume it once. */
  readonly lines: Stream.Stream<string>;
  /** The last 8 KiB of stderr, for an assertion message. */
  readonly stderrTail: Effect.Effect<string>;
  /** The exit code; fails if the child outlives `timeoutMs`. */
  readonly exited: Effect.Effect<number>;
  /** Closes stdin, which asks the child to shut down in its own time. */
  readonly end: () => Effect.Effect<void>;
}

interface StderrTail {
  text: string;
}

interface LineBuffer {
  pending: Buffer;
  failed: boolean;
}

interface ChildState {
  readonly queue: Queue.Queue<string, Cause.Done>;
  readonly exit: Deferred.Deferred<number>;
  readonly stderr: StderrTail;
  readonly line: LineBuffer;
  ended: boolean;
}

interface Watchers {
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderr: (chunk: Buffer) => void;
  readonly onClose: (code: number | null) => void;
  readonly onError: (cause: Error) => void;
}

/** The child's command, for a failure message. */
const label = (spec: DuplexSpec): string => spec.bin + " " + spec.args.join(" ");

/** Keeps the last `MAX_STDERR_BYTES` of text. */
const tail = (text: string, chunk: string): string => {
  const joined = Buffer.from(text + chunk, "utf8");

  return (joined.length > MAX_STDERR_BYTES ? joined.subarray(-MAX_STDERR_BYTES) : joined).toString(
    "utf8",
  );
};

/** A failure naming the child, the detail, and the stderr it left. */
const failure = (spec: DuplexSpec, detail: string, state: ChildState): Error =>
  new Error(
    "tack-conformance: " +
      label(spec) +
      " " +
      detail +
      "\nstderr:\n" +
      (state.stderr.text || "(empty)"),
  );

/** Fails the line stream once; a later failure has no reader left. */
const failLines = (state: ChildState, error: Error): void => {
  if (state.line.failed) return;

  state.line.failed = true;
  Queue.failCauseUnsafe(state.queue, Cause.die(error));
};

/** Offers one complete line, failing the stream when its buffer is full. */
const offerLine = (state: ChildState, line: string): void => {
  if (state.line.failed) return;

  if (!Queue.offerUnsafe(state.queue, line)) {
    failLines(
      state,
      new Error("tack-conformance: more than " + MAX_BUFFERED_LINES + " lines buffered"),
    );
  }
};

/** Appends stdout bytes that do not yet end in a newline, within the line cap. */
const appendPending = (state: ChildState, bytes: Buffer): void => {
  const size = state.line.pending.length + bytes.length;

  if (size > MAX_LINE_BYTES) {
    failLines(state, new Error("tack-conformance: a line exceeded " + MAX_LINE_BYTES + " bytes"));

    return;
  }

  state.line.pending = Buffer.concat([state.line.pending, bytes]);
};

/** Splits stdout on LF only; every other byte belongs to the line. */
const splitChunk = (state: ChildState, chunk: Buffer): void => {
  let offset = 0;

  while (offset < chunk.length && !state.line.failed) {
    const newline = chunk.indexOf(LF, offset);

    if (newline === -1) {
      appendPending(state, chunk.subarray(offset));

      return;
    }

    const line = Buffer.concat([state.line.pending, chunk.subarray(offset, newline)]);
    state.line.pending = Buffer.alloc(0);

    if (line.length > MAX_LINE_BYTES) {
      failLines(state, new Error("tack-conformance: a line exceeded " + MAX_LINE_BYTES + " bytes"));

      return;
    }

    offerLine(state, line.toString("utf8"));
    offset = newline + 1;
  }
};

/** Settles the exit code and reports an orderly or unexpected end on the stream. */
const closeChild = (state: ChildState, spec: DuplexSpec, code: number | null): void => {
  const exitCode = code ?? -1;

  Deferred.doneUnsafe(state.exit, Effect.succeed(exitCode));

  if (state.line.failed) return;

  const orderly = state.ended && exitCode === 0 && state.line.pending.length === 0;

  if (orderly) {
    Queue.endUnsafe(state.queue);

    return;
  }

  const midLine = state.line.pending.length > 0 ? " in the middle of a line" : "";

  failLines(state, failure(spec, "exited with " + exitCode + midLine, state));
};

/** Reports a spawn failure on both the exit code and the line stream. */
const errorChild = (state: ChildState, spec: DuplexSpec, cause: Error): void => {
  Deferred.doneUnsafe(state.exit, Effect.succeed(-1));
  failLines(state, failure(spec, "failed to start: " + cause.message, state));
};

/** Closes stdin once; a child already gone is not an error. */
const endWriting = (state: ChildState, child: PipedChild): void => {
  state.ended = true;

  if (child.stdin.destroyed || child.stdin.writableEnded) return;

  child.stdin.end();
};

const start = (spec: DuplexSpec): Effect.Effect<PipedChild> =>
  Effect.sync(() =>
    spawn(spec.bin, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );

/** Writes one line and waits for the pipe to accept it. */
const writeLine = (stdin: Writable, line: string): Effect.Effect<void> =>
  Effect.callback<void>((resume, signal) => {
    if (stdin.destroyed || stdin.writableEnded) {
      resume(Effect.die(new Error("tack-conformance: the child's stdin is closed")));

      return;
    }

    const onError = (cause: Error): void => {
      resume(
        Effect.die(new Error("tack-conformance: writing to the child failed: " + cause.message)),
      );
    };

    stdin.once("error", onError);
    stdin.write(line + "\n", (error) => {
      stdin.off("error", onError);
      resume(error === null || error === undefined ? Effect.void : Effect.die(error));
    });
    signal.addEventListener("abort", () => stdin.off("error", onError), { once: true });
  });

/** Waits for the exit code, failing when the child outlives its timeout. */
const waitForExit = (state: ChildState, spec: DuplexSpec): Effect.Effect<number> =>
  Deferred.await(state.exit).pipe(
    Effect.timeoutOrElse({
      duration: spec.timeoutMs,
      orElse: () =>
        Effect.die(failure(spec, "did not exit within " + spec.timeoutMs + " ms", state)),
    }),
  );

/**
 * Asks the child to stop, then kills it. A child that ignores SIGTERM gets
 * SIGKILL after the grace; the second grace bounds teardown even then.
 */
const terminate = (
  child: PipedChild,
  exit: Deferred.Deferred<number>,
  graceMs: number,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      return Effect.void;
    }

    child.kill("SIGTERM");

    return Deferred.await(exit).pipe(
      Effect.timeoutOption(graceMs),
      Effect.flatMap((stopped) => {
        if (Option.isSome(stopped)) return Effect.void;

        child.kill("SIGKILL");

        return Deferred.await(exit).pipe(Effect.timeoutOption(graceMs), Effect.asVoid);
      }),
    );
  });

/** Terminates the child, then detaches every listener from it. */
const shutdown = (
  child: PipedChild,
  state: ChildState,
  watchers: Watchers,
  graceMs: number,
): Effect.Effect<void> =>
  terminate(child, state.exit, graceMs).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        child.stdout.off("data", watchers.onStdout);
        child.stderr.off("data", watchers.onStderr);
        child.off("close", watchers.onClose);
        child.off("error", watchers.onError);
      }),
    ),
  );

/**
 * Starts a child that stays alive and talks over stdin and stdout. The server
 * closes stdin with `end`, and the surrounding scope always kills the child.
 */
export const duplexChild = (spec: DuplexSpec): Effect.Effect<Duplex, never, Scope.Scope> =>
  Effect.gen(function* () {
    const exit = yield* Deferred.make<number>();
    const queue = yield* Queue.bounded<string, Cause.Done>(MAX_BUFFERED_LINES);

    const state: ChildState = {
      queue,
      exit,
      stderr: { text: "" },
      line: { pending: Buffer.alloc(0), failed: false },
      ended: false,
    };

    const watchers: Watchers = {
      onStdout: (chunk) => splitChunk(state, chunk),
      onStderr: (chunk) => {
        state.stderr.text = tail(state.stderr.text, chunk.toString("utf8"));
      },
      onClose: (code) => closeChild(state, spec, code),
      onError: (cause) => errorChild(state, spec, cause),
    };

    const child = yield* Effect.acquireRelease(start(spec), (started) =>
      shutdown(started, state, watchers, spec.graceMs ?? KILL_GRACE_MS),
    );

    child.stdout.on("data", watchers.onStdout);
    child.stderr.on("data", watchers.onStderr);
    child.once("close", watchers.onClose);
    child.once("error", watchers.onError);

    return {
      write: (line) => writeLine(child.stdin, line),
      lines: Stream.fromQueue(queue),
      stderrTail: Effect.sync(() => state.stderr.text),
      exited: waitForExit(state, spec),
      end: () => Effect.sync(() => endWriting(state, child)),
    };
  });
