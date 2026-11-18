import { Buffer } from "node:buffer";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema, Stream, type Scope } from "effect";

import { opencodeServer, type OpenCodeServer } from "../conformance/harness/opencode-server.ts";
import type { Sandbox } from "../conformance/harness/sandbox.ts";

/**
 * A plain node:http server standing in for `opencode serve`: it records every
 * request, refuses a wrong password, and answers the routes the driver uses.
 * The "huge" mode makes the event stream carry one event over 1 MiB.
 */
const FAKE = [
  'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
  'import { createServer } from "node:http";',
  "",
  "const args = process.argv.slice(2);",
  'const port = Number(args[args.indexOf("--port") + 1]);',
  "const log = process.env.FAKE_LOG;",
  "const modeFile = process.env.FAKE_MODE;",
  "const stoppedFile = process.env.FAKE_STOPPED;",
  'const password = process.env.OPENCODE_PASSWORD ?? "";',
  'const expected = "Basic " + Buffer.from("opencode:" + password).toString("base64");',
  "",
  "const record = (entry) => {",
  '  appendFileSync(log, JSON.stringify(entry) + "\\n");',
  "};",
  "",
  "const mode = () => {",
  "  try {",
  '    return readFileSync(modeFile, "utf8").trim();',
  "  } catch {",
  '    return "normal";',
  "  }",
  "};",
  "",
  "const send = (response, status, body) => {",
  '  response.writeHead(status, { "content-type": "application/json" });',
  "  response.end(JSON.stringify(body));",
  "};",
  "",
  "const event = (response, value) => {",
  '  response.write("data: " + JSON.stringify(value) + "\\n\\n");',
  "};",
  "",
  "let pluginPolls = 0;",
  "",
  "const handle = (request, response, body) => {",
  '  const url = new URL(request.url, "http://127.0.0.1");',
  "  const path = url.pathname;",
  "  const match = /^\\/api\\/session\\/([^/]+)(\\/[a-z]+)?$/.exec(path);",
  "  const id = match === null ? undefined : match[1];",
  '  const action = match === null ? "" : match[2] ?? "";',
  "",
  '  if (request.method === "GET" && path === "/api/info") {',
  '    send(response, 200, { version: "2.3.0", pid: process.pid, urls: [], paths: { tmp: "/tmp" } });',
  "",
  "    return;",
  "  }",
  "",
  '  if (request.method === "GET" && path === "/api/plugin") {',
  "    pluginPolls += 1;",
  "",
  "    const data =",
  "      pluginPolls <= 2",
  "        ? []",
  "        : [",
  "            {",
  '              id: "tack.deny-push",',
  '              source: { type: "local", path: "/plugins/deny-push" },',
  "              features: { server: true },",
  '              state: { status: "active" },',
  "            },",
  "          ];",
  "",
  "    send(response, 200, {",
  '      location: { directory: url.searchParams.get("location[directory]") },',
  "      data,",
  "    });",
  "",
  "    return;",
  "  }",
  "",
  '  if (request.method === "GET" && path === "/api/event") {',
  '    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });',
  "",
  '    if (mode() === "huge") {',
  '      event(response, { type: "session.huge", data: "x".repeat(1048577) });',
  "      response.end();",
  "",
  "      return;",
  "    }",
  "",
  '    event(response, { type: "session.idle", data: { sessionID: "session-1" } });',
  '    event(response, { type: "session.step.ended", data: { sessionID: "session-1" } });',
  "    response.end();",
  "",
  "    return;",
  "  }",
  "",
  '  if (request.method === "POST" && path === "/api/session") {',
  "    const directory = JSON.parse(body).location.directory;",
  "",
  '    send(response, 200, { data: { id: directory.endsWith("/broken") ? "malformed" : "session-1" } });',
  "",
  "    return;",
  "  }",
  "",
  '  if (request.method === "POST" && id !== undefined && action === "/prompt") {',
  '    send(response, 200, { data: { id: "message-1" } });',
  "",
  "    return;",
  "  }",
  "",
  '  if (request.method === "POST" && id !== undefined && action === "/interrupt") {',
  "    send(response, 200, { interrupted: true });",
  "",
  "    return;",
  "  }",
  "",
  '  if (request.method === "DELETE" && id !== undefined && action === "") {',
  "    response.writeHead(204);",
  "    response.end();",
  "",
  "    return;",
  "  }",
  "",
  '  if (request.method === "GET" && id !== undefined && action === "") {',
  '    if (id === "malformed") {',
  '      send(response, 200, { data: { outcome: "weird", time: {} } });',
  "",
  "      return;",
  "    }",
  "",
  '    if (id === "missing") {',
  '      send(response, 404, { error: "session not found" });',
  "",
  "      return;",
  "    }",
  "",
  "    send(response, 200, {",
  '      data: { id, outcome: "succeeded", time: { busy: 1700000000000, idle: 1700000000001 } },',
  "    });",
  "",
  "    return;",
  "  }",
  "",
  '  send(response, 404, { error: "not found" });',
  "};",
  "",
  "const server = createServer((request, response) => {",
  "  const chunks = [];",
  "",
  '  request.on("data", (chunk) => chunks.push(chunk));',
  '  request.on("end", () => {',
  '    const body = Buffer.concat(chunks).toString("utf8");',
  '    const authorization = request.headers.authorization ?? "";',
  "",
  "    record({ method: request.method, url: request.url, authorization, body });",
  "",
  "    if (authorization !== expected) {",
  '      send(response, 401, { error: "unauthorized", seen: authorization });',
  "",
  "      return;",
  "    }",
  "",
  "    handle(request, response, body);",
  "  });",
  "});",
  "",
  'process.on("SIGTERM", () => {',
  '  writeFileSync(stoppedFile, "stopped\\n");',
  "  server.close();",
  "  process.exit(0);",
  "});",
  "",
  'server.listen(port, "127.0.0.1", () => {',
  '  if (process.env.FAKE_QUIET !== "1") {',
  '    process.stdout.write("server listening on http://127.0.0.1:" + port + "\\n");',
  "  }",
  "});",
].join("\n");

const RecordSchema = Schema.Struct({
  method: Schema.String,
  url: Schema.String,
  authorization: Schema.String,
  body: Schema.String,
});

type RequestRecord = typeof RecordSchema.Type;

interface MockServer {
  readonly box: Sandbox;
  readonly log: string;
  readonly stopped: string;
  readonly setMode: (mode: string) => Effect.Effect<void>;
}

/** A directory deleted when the scope closes. */
const tempDir = (): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "tack-opencode-"))),
    (created) =>
      Effect.sync(() => {
        rmSync(created, { recursive: true, force: true });
      }),
  );

/** Writes an executable script whose interpreter is the test runner's own. */
const writeScript = (dir: string, name: string, script: string): string => {
  const path = join(dir, name);

  writeFileSync(path, "#!" + process.execPath + "\n" + script + "\n");
  chmodSync(path, 0o755);

  return path;
};

/** The sandbox a scenario would hand the driver, over a fake binary. */
const boxFor = (dir: string, bin: string, env: Readonly<Record<string, string>>): Sandbox => ({
  dir,
  projectDir: dir,
  recorderFile: join(dir, "recorder.log"),
  loadedFile: join(dir, "loaded.log"),
  opencode: { bin, env },
  pi: { bin: "", env: {} },
});

const fakeServer = (
  env: Readonly<Record<string, string>>,
): Effect.Effect<MockServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const dir = yield* tempDir();
    const log = join(dir, "requests.jsonl");
    const mode = join(dir, "mode");
    const stopped = join(dir, "stopped");

    const bin = yield* Effect.sync(() => {
      writeFileSync(log, "");
      writeFileSync(mode, "normal");

      return writeScript(dir, "opencode-fake.mjs", FAKE);
    });

    const box = boxFor(dir, bin, {
      FAKE_LOG: log,
      FAKE_MODE: mode,
      FAKE_STOPPED: stopped,
      ...env,
    });

    return {
      box,
      log,
      stopped,
      setMode: (next) =>
        Effect.sync(() => {
          writeFileSync(mode, next);
        }),
    };
  });

const withServer = <A>(
  env: Readonly<Record<string, string>>,
  body: (fake: MockServer, server: OpenCodeServer) => Effect.Effect<A>,
): Effect.Effect<A> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* fakeServer(env);
      const server = yield* opencodeServer(fake.box);

      return yield* body(fake, server);
    }),
  );

/** Every request the fake answered, in arrival order. */
const recorded = (log: string): ReadonlyArray<RequestRecord> =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => Schema.decodeUnknownSync(RecordSchema)(JSON.parse(line)));

/** The user and password a Basic auth header carries. */
const credentials = (authorization: string): string =>
  Buffer.from(authorization.replace("Basic ", ""), "base64").toString("utf8");

it.live("sends Basic auth and the exact request of each action", () =>
  withServer({}, (fake, server) =>
    Effect.gen(function* () {
      const created = yield* server.createSession({ directory: "/work/project" });

      yield* server.prompt(created.id, "second turn");
      yield* server.interrupt(created.id);

      const info = yield* server.session(created.id);

      yield* server.deleteSession(created.id);

      const requests = recorded(fake.log);
      const actions = requests.filter((request) => request.url.startsWith("/api/session"));

      expect(created).toEqual({ id: "session-1" });
      expect(info).toEqual({
        outcome: "succeeded",
        time: { busy: 1_700_000_000_000, idle: 1_700_000_000_001 },
      });
      expect(actions.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
        {
          method: "POST",
          url: "/api/session",
          body: '{"model":{"providerID":"fake","id":"scripted"},"location":{"directory":"/work/project"}}',
        },
        {
          method: "POST",
          url: "/api/session/session-1/prompt",
          body: '{"text":"second turn"}',
        },
        { method: "POST", url: "/api/session/session-1/interrupt", body: "" },
        { method: "GET", url: "/api/session/session-1", body: "" },
        { method: "DELETE", url: "/api/session/session-1", body: "" },
      ]);

      expect(requests.length).toBeGreaterThan(0);

      for (const request of requests) {
        const value = credentials(request.authorization);

        expect(value.startsWith("opencode:")).toBe(true);
        expect(value.length).toBeGreaterThan("opencode:".length);
      }
    }),
  ),
);

it.live("fails a decoded response with its status, path and body", () =>
  withServer({}, (_fake, server) =>
    Effect.gen(function* () {
      const exited = yield* Effect.exit(server.session("malformed"));

      if (Exit.isSuccess(exited)) throw new Error("a malformed outcome must fail");

      const text = Cause.pretty(exited.cause);

      expect(text).toContain("GET /api/session/malformed");
      expect(text).toContain("answered 200");
      expect(text).toContain("weird");
    }),
  ),
);

it.live("fails a non-2xx response with its status, path and body", () =>
  withServer({}, (_fake, server) =>
    Effect.gen(function* () {
      const exited = yield* Effect.exit(server.session("missing"));

      if (Exit.isSuccess(exited)) throw new Error("a 404 must fail");

      const text = Cause.pretty(exited.cause);

      expect(text).toContain("GET /api/session/missing");
      expect(text).toContain("answered 404");
      expect(text).toContain("session not found");
    }),
  ),
);

it.live("streams only the requested event types and ends with the server's reply", () =>
  withServer({}, (_fake, server) =>
    Effect.gen(function* () {
      const opened: Array<string> = [];
      const closed: Array<string> = [];
      let frames = 0;

      const chosen = yield* server
        .events(["session.step.ended"], {
          opened: (at) => {
            opened.push(at);
          },
          closed: (at) => {
            closed.push(at);
          },
          frame: () => {
            frames += 1;
          },
        })
        .pipe(Stream.runCollect);

      expect(chosen).toEqual([{ type: "session.step.ended", data: { sessionID: "session-1" } }]);

      // Both frames arrive, though only one type is kept: the count says the
      // connection was alive when a witness has no frame of its own to show.
      expect(frames).toBe(2);
      expect(opened).toHaveLength(1);
      expect(closed).toHaveLength(1);
      expect(opened[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(closed[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      const all = yield* server.events([]).pipe(Stream.runCollect);

      expect(all).toEqual([
        { type: "session.idle", data: { sessionID: "session-1" } },
        { type: "session.step.ended", data: { sessionID: "session-1" } },
      ]);
    }),
  ),
);

it.live("fails an event over 1 MiB", () =>
  withServer({}, (fake, server) =>
    Effect.gen(function* () {
      yield* fake.setMode("huge");

      const exited = yield* Effect.exit(server.events(["session.huge"]).pipe(Stream.runCollect));

      if (Exit.isSuccess(exited)) throw new Error("an event over the cap must fail");

      expect(Cause.pretty(exited.cause)).toContain("1048576");
    }),
  ),
);

it.live("polls until the tack plugin is listed for the directory", () =>
  withServer({}, (fake, server) =>
    Effect.gen(function* () {
      yield* server.awaitPlugin("/work/project");

      const polls = recorded(fake.log).filter((request) => request.url.startsWith("/api/plugin"));

      expect(polls).toHaveLength(3);
      expect(polls.map((poll) => poll.method)).toEqual(["GET", "GET", "GET"]);

      for (const poll of polls) {
        const directory = new URL(poll.url, "http://127.0.0.1").searchParams.get(
          "location[directory]",
        );

        expect(directory).toBe("/work/project");
      }
    }),
  ),
);

it.live("stop ends the server process", () =>
  withServer({}, (fake, server) =>
    Effect.gen(function* () {
      yield* server.stop();

      expect(readFileSync(fake.stopped, "utf8").trim()).toBe("stopped");
    }),
  ),
);

it.live(
  "falls back to /api/info when the listening line never comes",
  () =>
    withServer({ FAKE_QUIET: "1" }, (fake, server) =>
      Effect.gen(function* () {
        const created = yield* server.createSession({ directory: "/work/quiet" });

        expect(created).toEqual({ id: "session-1" });

        const requests = recorded(fake.log);

        expect(requests.some((request) => request.url === "/api/info")).toBe(true);
      }),
    ),
  15_000,
);

it.live("fails readiness with the port and the stderr a child leaves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* tempDir();

      const bin = yield* Effect.sync(() =>
        writeScript(
          dir,
          "crash.mjs",
          ['process.stderr.write("boom\\n");', "process.exit(3);"].join("\n"),
        ),
      );

      const exited = yield* Effect.exit(opencodeServer(boxFor(dir, bin, {})));

      if (Exit.isSuccess(exited)) throw new Error("a child that exits early must fail readiness");

      const text = Cause.pretty(exited.cause);

      expect(text).toMatch(/port \d+/);
      expect(text).toContain("exited with 3");
      expect(text).toContain("boom");
    }),
  ),
);
