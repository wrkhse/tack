import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Stream } from "effect";

import { piRpc, piRpcArgs, type PiRpcSpec } from "../conformance/harness/pi-rpc.ts";

/** Answers each prompt, emits `agent_settled`, and fails on demand. */
const FAKE = [
  "let buffer = '';",
  "const send = (record) => process.stdout.write(JSON.stringify(record) + '\\n');",
  "const handle = (line) => {",
  "  const command = JSON.parse(line);",
  "  if (command.type === 'prompt') {",
  "    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });",
  "    send({ type: 'agent_settled', aborted: false });",
  "  }",
  "  if (command.type === 'bad') process.stdout.write('not json\\n');",
  "  if (command.type === 'unknown') send({ hello: 'world' });",
  "};",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  let newline = buffer.indexOf('\\n');",
  "  while (newline >= 0) {",
  "    const line = buffer.slice(0, newline);",
  "    buffer = buffer.slice(newline + 1);",
  "    handle(line);",
  "    newline = buffer.indexOf('\\n');",
  "  }",
  "});",
  "process.stdin.on('end', () => {",
  "  process.stdout.write(JSON.stringify({ type: 'session_shutdown' }) + '\\n', () => process.exit(0));",
  "});",
].join("\n");

/** The test runner's own node-compatible binary, run as a fake child. */
const spec = (script: string): PiRpcSpec => ({
  bin: process.execPath,
  args: ["-e", script],
  cwd: process.cwd(),
  env: {},
});

const PROMPT = { id: "p1", type: "prompt", message: "push it" };

it.effect("builds the RPC argument list", () =>
  Effect.sync(() => {
    expect(piRpcArgs(["/a/plugin.js", "/b/plugin.js"])).toEqual([
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
      "-e",
      "/a/plugin.js",
      "-e",
      "/b/plugin.js",
    ]);
  }),
);

it.live("sends a prompt and waits for its response", () =>
  Effect.gen(function* () {
    const rpc = yield* piRpc(spec(FAKE));

    yield* rpc.send(PROMPT);

    const response = yield* rpc.awaitResponse("p1");

    expect(response.command).toBe("prompt");
    expect(response.success).toBe(true);
    expect(response.data).toEqual({ disposition: "started" });

    yield* rpc.end();
  }),
);

it.live("waits for an event that already arrived", () =>
  Effect.gen(function* () {
    const rpc = yield* piRpc(spec(FAKE));

    yield* rpc.send(PROMPT);
    yield* rpc.awaitResponse("p1");

    const event = yield* rpc.awaitEvent("agent_settled");

    expect(event.type).toBe("agent_settled");
    expect(event.aborted).toBe(false);

    yield* rpc.end();
  }),
);

it.live("streams events without command responses", () =>
  Effect.gen(function* () {
    const rpc = yield* piRpc(spec(FAKE));

    yield* rpc.send(PROMPT);

    const [event] = yield* rpc.events.pipe(Stream.take(1), Stream.runCollect);

    expect(event).toBeDefined();
    expect(event?.type).toBe("agent_settled");
    expect(event?.id).toBeUndefined();

    yield* rpc.end();
  }),
);

it.live("fails a wait and the event stream on a malformed line", () =>
  Effect.gen(function* () {
    const rpc = yield* piRpc(spec(FAKE));

    yield* rpc.send({ id: "bad-1", type: "bad", message: "x" });

    const wait = yield* Effect.exit(rpc.awaitEvent("agent_settled", 5_000));

    if (Exit.isSuccess(wait)) throw new Error("a malformed line must fail the wait");

    expect(Cause.pretty(wait.cause)).toContain("not json");

    const events = yield* Effect.exit(Stream.runCollect(rpc.events));

    if (Exit.isSuccess(events)) throw new Error("a malformed line must fail the event stream");

    expect(Cause.pretty(events.cause)).toContain("not json");
  }),
);

it.live("fails a wait on an unknown record shape with the offending line", () =>
  Effect.gen(function* () {
    const rpc = yield* piRpc(spec(FAKE));

    yield* rpc.send({ id: "unknown-1", type: "unknown", message: "x" });

    const wait = yield* Effect.exit(rpc.awaitEvent("agent_settled", 5_000));

    if (Exit.isSuccess(wait)) throw new Error("an unknown shape must fail the wait");

    expect(Cause.pretty(wait.cause)).toContain('{"hello":"world"}');
  }),
);

it.live("closes stdin and the event stream ends when the child exits", () =>
  Effect.gen(function* () {
    const rpc = yield* piRpc(spec(FAKE));

    yield* rpc.end();

    const events = yield* rpc.events.pipe(Stream.runCollect);

    expect(events.map((event) => event.type)).toEqual(["session_shutdown"]);
  }),
);

it.live("fails a wait naming the events it saw", () =>
  Effect.gen(function* () {
    const rpc = yield* piRpc(spec(FAKE));

    yield* rpc.send(PROMPT);
    yield* rpc.awaitEvent("agent_settled");

    const wait = yield* Effect.exit(rpc.awaitEvent("model_select", 50));

    if (Exit.isSuccess(wait)) throw new Error("a missing event must fail the wait");

    const text = Cause.pretty(wait.cause);

    expect(text).toContain("no model_select event within 50 ms");
    expect(text).toContain("agent_settled");

    yield* rpc.end();
  }),
);
