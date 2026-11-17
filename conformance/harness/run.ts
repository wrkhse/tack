import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { Effect } from "effect";

/** How long one CLI run, or one bundle, may take. */
const CLI_TIMEOUT_MS = 120_000;

const MAX_STREAM_CHARS = 1024 * 1024;

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

/** One process to start: what to run, where, and with which environment. */
export interface CommandSpec {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** What a finished process produced. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Keeps a stream capture bounded while keeping its tail, which holds the error. */
const appendBounded = (current: string, chunk: string): string => {
  const next = current + chunk;

  return next.length > MAX_STREAM_CHARS ? next.slice(-MAX_STREAM_CHARS) : next;
};

const killQuietly = (child: PipedChild): Effect.Effect<void> =>
  Effect.sync(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;

    child.kill("SIGKILL");
  });

/**
 * Waits for the child to close, capturing bounded stdout and stderr. The
 * returned cleanup detaches every listener when the fiber is interrupted.
 */
const awaitExit = (child: PipedChild): Effect.Effect<CommandResult> =>
  Effect.callback<CommandResult>((resume, signal) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    function onStdout(chunk: Buffer): void {
      stdout = appendBounded(stdout, chunk.toString("utf8"));
    }

    function onStderr(chunk: Buffer): void {
      stderr = appendBounded(stderr, chunk.toString("utf8"));
    }

    function detach(): void {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("close", onClose);
      child.off("error", onFailure);
    }

    function settle(action: () => void): void {
      if (settled) return;

      settled = true;
      detach();
      action();
    }

    function onClose(code: number | null): void {
      settle(() => resume(Effect.succeed({ exitCode: code ?? -1, stdout, stderr })));
    }

    function onFailure(cause: Error): void {
      settle(() => resume(Effect.die(cause)));
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("close", onClose);
    child.on("error", onFailure);
    signal.addEventListener("abort", () => settle(() => undefined), { once: true });

    return Effect.sync(detach);
  });

const start = (spec: CommandSpec): Effect.Effect<PipedChild> =>
  Effect.sync(() =>
    spawn(spec.bin, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

/**
 * Runs one process to completion. A run that outlives the timeout is killed and
 * the failure names the binary.
 */
export const runCommand = (spec: CommandSpec): Effect.Effect<CommandResult> => {
  const run = Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(start(spec), killQuietly);

    return yield* awaitExit(child);
  });

  return run.pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: CLI_TIMEOUT_MS,
      orElse: () =>
        Effect.die(
          new Error("tack-conformance: " + spec.bin + " timed out after " + CLI_TIMEOUT_MS + " ms"),
        ),
    }),
  );
};

/** Runs `<bin> --version` and returns everything it printed. */
export const cliVersion = (
  bin: string,
  env: Readonly<Record<string, string>>,
  cwd: string,
): Effect.Effect<string> =>
  runCommand({ bin, args: ["--version"], cwd, env }).pipe(
    Effect.map((result) => result.stdout + result.stderr),
  );
