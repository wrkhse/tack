import { Buffer } from "node:buffer";
import { join } from "node:path";

import {
  Client,
  type CallToolResult,
  type DiscoverResult,
  type ListToolsResult,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Effect, Schema, type Scope } from "effect";

import { parseLoaded } from "../plugins/loaded.ts";
import { bundleEntry } from "./bundle.ts";
import { recorded } from "./recorder.ts";
import { readOptionalText, repoRoot, sandbox, type Sandbox } from "./sandbox.ts";

/**
 * The SDK exposes a pid, not an exit status. A shell parent waits for the real
 * generated entry and records its actual status without touching stdout.
 * Each parent uses its pid in the filename: the SDK's disposable discovery
 * probe cannot supply the session process's exit evidence.
 */
const SUPERVISE = [
  'bun "$1"',
  "code=$?",
  'printf "%s\\n" "$code" > "$2/mcp-exit-$$"',
  'exit "$code"',
].join("\n");

const MAX_STDERR_BYTES = 8 * 1024;
const EXIT_TIMEOUT_MS = 10_000;

interface McpProcess {
  readonly box: Sandbox;
  readonly transport: StdioClientTransport;
  readonly stderr: () => string;
}

export interface McpEvidence {
  readonly era: "modern" | "legacy" | undefined;
  readonly discover: DiscoverResult;
  readonly listed: ListToolsResult;
  readonly called: CallToolResult;
  readonly recorded: ReadonlyArray<string>;
  readonly loaded: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stderr: string;
}

export interface BrokenMcpEvidence {
  readonly exitCode: number;
  readonly stderr: string;
}

/** A bounded stderr tail kept from before the child starts until it closes. */
function capture(transport: StdioClientTransport): () => string {
  let tail = "";

  transport.stderr?.on("data", (chunk: Buffer) => {
    const bytes = Buffer.from(tail + chunk.toString("utf8"), "utf8");
    tail = bytes.subarray(-MAX_STDERR_BYTES).toString("utf8");
  });

  return () => tail;
}

/** One generated entry, its SDK transport, and a fresh isolated environment. */
const prepare = Effect.fnUntraced(function* (
  name: "mcp-monitor" | "mcp-broken",
): Effect.fn.Return<McpProcess, never, Scope.Scope> {
  const box = yield* sandbox;

  const entry = yield* bundleEntry(
    join(repoRoot, "conformance", "plugins", "entries", name + ".ts"),
    join(box.dir, "plugins", name, "mcp.js"),
    box.pi.env,
  );

  const transport = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new StdioClientTransport({
          command: "/bin/sh",
          args: ["-c", SUPERVISE, "tack-mcp", entry, box.dir],
          cwd: box.projectDir,
          env: { ...box.pi.env },
          stderr: "pipe",
        }),
    ),
    (active) => Effect.promise(() => active.close()),
  );

  return { box, transport, stderr: capture(transport) };
});

/** The status the supervisor saw, not an inference from the MCP connection closing. */
const exitStatus = Effect.fnUntraced(function* (process: McpProcess, pid: number | null) {
  if (pid === null) {
    return yield* Effect.die(new Error("tack-conformance: MCP child has no pid"));
  }

  const text = yield* readOptionalText(join(process.box.dir, "mcp-exit-" + pid));

  if (text === null) {
    return yield* Effect.die(
      new Error("tack-conformance: MCP child did not exit normally\nstderr:\n" + process.stderr()),
    );
  }

  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Int))(text).pipe(Effect.orDie);
});

/** The independent T3 stdio row: no agent process, provider or scripted model. */
export const runMcpScenario = Effect.fnUntraced(function* (): Effect.fn.Return<
  McpEvidence,
  never,
  Scope.Scope
> {
  const process = yield* prepare("mcp-monitor");

  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Client(
          { name: "tack-conformance", version: "1.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        ),
    ),
    (active) => Effect.promise(() => active.close()),
  );

  yield* Effect.promise(() => client.connect(process.transport));

  const pid = process.transport.pid;
  const era = client.getProtocolEra();
  const discover = yield* Effect.promise(() => client.discover());
  const listed = yield* Effect.promise(() => client.listTools());

  const called = yield* Effect.promise(() =>
    client.callTool({
      name: "monitor_create",
      arguments: { key: "PROJ-1" },
    }),
  );

  yield* Effect.promise(() => client.close());

  const exitCode = yield* exitStatus(process, pid);
  const lines = yield* recorded(process.box.recorderFile);
  const loaded = yield* readOptionalText(process.box.loadedFile);

  return {
    era,
    discover,
    listed,
    called,
    exitCode,
    recorded: lines,
    loaded: loaded === null ? [] : parseLoaded(loaded),
    stderr: process.stderr(),
  };
});

/** Refusal occurs before any handshake; watch the real child's close event. */
export const runBrokenMcpScenario = Effect.fnUntraced(function* (): Effect.fn.Return<
  BrokenMcpEvidence,
  never,
  Scope.Scope
> {
  const process = yield* prepare("mcp-broken");
  const closed = Promise.withResolvers<void>();

  Object.assign(process.transport, { onclose: () => closed.resolve() });

  yield* Effect.promise(() => process.transport.start());

  const pid = process.transport.pid;

  yield* Effect.promise(() => closed.promise).pipe(
    Effect.timeoutOrElse({
      duration: EXIT_TIMEOUT_MS,
      orElse: () => Effect.die(new Error("tack-conformance: broken MCP entry did not exit")),
    }),
  );

  const exitCode = yield* exitStatus(process, pid);

  return { exitCode, stderr: process.stderr() };
});
