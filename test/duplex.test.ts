import { expect, it } from "@effect/vitest";
import { Cause, Clock, Effect, Exit, Stream } from "effect";

import { duplexChild, type DuplexSpec } from "../conformance/harness/duplex.ts";

/** Echoes every stdin byte, so writes come back as lines. */
const ECHO = "process.stdin.on('data', (chunk) => process.stdout.write(chunk));";

/** Writes one line over the cap and stays alive until the test's scope kills it. */
const FLOOD = "process.stdout.write('x'.repeat(1048577)); setInterval(() => {}, 1000);";

/** Exits with code 3 after half a line, leaving stderr behind. */
const MID_LINE = [
  "process.stdout.write('partial', () => {",
  "  process.stderr.write('boom');",
  "  setTimeout(() => process.exit(3), 10);",
  "});",
].join("\n");

/** Ignores the polite signal, so only SIGKILL can end it. */
const IGNORES_SIGTERM = [
  "process.on('SIGTERM', () => {});",
  "process.stdout.write('ready\\n');",
  "setInterval(() => {}, 1000);",
].join("\n");

/** The test runner's own node-compatible binary, run as a fake child. */
const spec = (script: string, graceMs = 5_000): DuplexSpec => ({
  bin: process.execPath,
  args: ["-e", script],
  cwd: process.cwd(),
  env: {},
  timeoutMs: 30_000,
  graceMs,
});

it.live("writes lines and completes when stdin closes", () =>
  Effect.gen(function* () {
    const child = yield* duplexChild(spec(ECHO));

    yield* child.write("alpha");
    yield* child.write("beta");
    yield* child.end();

    const lines = yield* Stream.runCollect(child.lines);
    const code = yield* child.exited;

    expect(lines).toEqual(["alpha", "beta"]);
    expect(code).toBe(0);
  }),
);

it.live("fails the stream when a line passes the cap", () =>
  Effect.gen(function* () {
    const child = yield* duplexChild(spec(FLOOD));
    const exit = yield* Effect.exit(Stream.runCollect(child.lines));

    if (Exit.isSuccess(exit)) throw new Error("a line over the cap must fail the stream");

    expect(Cause.pretty(exit.cause)).toContain("exceeded 1048576 bytes");
  }),
);

it.live("fails the stream with the exit code and stderr when the child dies mid-line", () =>
  Effect.gen(function* () {
    const child = yield* duplexChild(spec(MID_LINE));
    const exit = yield* Effect.exit(Stream.runCollect(child.lines));

    if (Exit.isSuccess(exit)) throw new Error("an unexpected exit must fail the stream");

    const text = Cause.pretty(exit.cause);

    expect(text).toContain("exited with 3 in the middle of a line");
    expect(text).toContain("boom");
  }),
);

it.live(
  "escalates to SIGKILL when the child ignores SIGTERM",
  () =>
    Effect.gen(function* () {
      const before = yield* Clock.currentTimeMillis;

      const captured = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* duplexChild(spec(IGNORES_SIGTERM, 200));

          yield* child.lines.pipe(Stream.runHead);

          return { exited: child.exited };
        }),
      );

      const code = yield* captured.exited;
      const after = yield* Clock.currentTimeMillis;

      expect(code).toBe(-1);
      // The 200 ms grace proves the escalation; a run on the 5 s default would
      // take seconds longer than this bound allows.
      expect(after - before).toBeGreaterThanOrEqual(150);
      expect(after - before).toBeLessThan(4_000);
    }),
  15_000,
);
