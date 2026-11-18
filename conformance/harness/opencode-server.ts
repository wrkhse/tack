import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";

import { Cause, Deferred, Effect, Exit, Schema, Scope, Stream } from "effect";

import { duplexChild, type Duplex } from "./duplex.ts";
import type { Sandbox } from "./sandbox.ts";

/** The largest JSON body the adapter reads, in bytes. */
const MAX_BODY_BYTES = 1024 * 1024;

/** The largest single event the reader accepts, in bytes. */
const MAX_EVENT_BYTES = 1024 * 1024;

/** The most events buffered for a consumer that falls behind. */
const MAX_BUFFERED_EVENTS = 1_000;

/** The most characters of a body or event a failure message quotes. */
const MAX_QUOTED_CHARS = 400;

/** How long the server may take to announce itself or answer `/api/info`. */
const READY_TIMEOUT_MS = 30_000;

/** How long the listening line gets before `/api/info` is polled instead. */
const ANNOUNCE_GRACE_MS = 2_000;

/** How long one JSON request may take. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How long the event stream may stay open. */
const STREAM_TIMEOUT_MS = 120_000;

/** How long `stop` waits for the child after the scope asks it to quit. */
const STOP_TIMEOUT_MS = 10_000;

/** How long the child may live; the scope's finalizer kills it at the end. */
const EXIT_TIMEOUT_MS = 120_000;

/** How long one wait sleeps between polls, and how many polls it makes. */
const POLL_INTERVAL_MS = 100;
const POLL_ATTEMPTS = 300;

/** The prefix `tack` gives every OpenCode plugin it registers. */
const PLUGIN_PREFIX = "tack.";

/** The record separator between two server-sent events. */
const FRAME_SEPARATOR = "\n\n";

/** The documented readiness line: `server listening on http://host:port`. */
const LISTENING = /server listening on (http:\/\/\S+)/;

/** How a session's last execution ended. */
const SessionOutcomeSchema = Schema.Literals(["succeeded", "failed", "interrupted"]);

export type SessionOutcome = typeof SessionOutcomeSchema.Type;

/** The OpenCode server one scenario drives, bound to its port and password. */
export interface OpenCodeServer {
  /** Creates a session at `directory` for the fake provider and scripted model. */
  readonly createSession: (input: {
    readonly directory: string;
  }) => Effect.Effect<{ readonly id: string }>;
  /**
   * Sends one prompt. The response admits the prompt; it does not wait for the
   * turn to finish.
   */
  readonly prompt: (sessionID: string, text: string) => Effect.Effect<void>;
  /** Interrupts the session's running execution. */
  readonly interrupt: (sessionID: string) => Effect.Effect<void>;
  /** Deletes the session, which is what emits `session.deleted`. */
  readonly deleteSession: (sessionID: string) => Effect.Effect<void>;
  /** Reads the session's own record of its last turn: its outcome and when it ran. */
  readonly session: (sessionID: string) => Effect.Effect<SessionTurn>;
  /**
   * Streams the server's events of the given types; an empty list takes every
   * event. The stream ends when the server closes the connection.
   */
  readonly events: (types: ReadonlyArray<string>) => Stream.Stream<Schema.Json>;
  /** Waits until a tack plugin is listed for `directory`. */
  readonly awaitPlugin: (directory: string) => Effect.Effect<void>;
  /** Reloads every location's configuration, keeping its running sessions. */
  readonly reloadLocations: () => Effect.Effect<void>;
  /** Asks the child to quit and waits for it, bounded. */
  readonly stop: () => Effect.Effect<void>;
}

type HttpMethod = "GET" | "POST" | "DELETE";

/** One request the harness makes of the server. */
interface HttpRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: Schema.Json;
  readonly accept?: string;
}

/** A response's status and its body as a lazily read byte stream. */
interface HttpResponse {
  readonly status: number;
  readonly body: Stream.Stream<Uint8Array>;
}

/** The one HTTP adapter every request goes through. */
interface Client {
  readonly request: (input: HttpRequest, timeoutMs: number) => Effect.Effect<HttpResponse>;
  readonly json: <A>(input: HttpRequest, schema: Schema.Codec<A, unknown>) => Effect.Effect<A>;
}

/** One decoded event: its type, and the payload the caller sees. */
interface EventRecord {
  readonly type: string;
  readonly json: Schema.Json;
}

const InfoSchema = Schema.Struct({ version: Schema.String });

const CreatedSchema = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) });

const SessionSchema = Schema.Struct({
  data: Schema.Struct({
    outcome: Schema.optional(SessionOutcomeSchema),
    time: Schema.Struct({
      busy: Schema.optional(Schema.Finite),
      idle: Schema.optional(Schema.Finite),
    }),
  }),
});

/**
 * A session read's turn fields. `outcome` is how the last completed execution
 * ended, recorded at `time.idle`; `busy` is when the most recent execution
 * started, and while one runs `idle` still holds the previous execution's end.
 */
export type SessionTurn = (typeof SessionSchema.Type)["data"];

const PluginSchema = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.optional(Schema.String) })),
});

const InterruptSchema = Schema.Struct({ interrupted: Schema.Boolean });

const EventSchema = Schema.Struct({ type: Schema.String });

const baseUrl = (port: number): string => "http://127.0.0.1:" + port;

/** The password goes in the password slot; the username is always `opencode`. */
const basicAuth = (password: string): string =>
  "Basic " + Buffer.from("opencode:" + password, "utf8").toString("base64");

/** Names a request in every failure about it. */
const describe = (input: HttpRequest): string => input.method + " " + input.path;

/** Keeps a failure message readable when the body is large. */
const excerpt = (text: string): string =>
  text.length > MAX_QUOTED_CHARS ? text.slice(0, MAX_QUOTED_CHARS) + "..." : text;

const quotedBody = (text: string): string =>
  "\nbody:\n" + (text === "" ? "(empty)" : excerpt(text));

/** A failure naming the status, the path and the body that produced it. */
const badResponse = (input: HttpRequest, status: number, text: string, detail: string): Error =>
  new Error(
    "tack-conformance: " +
      describe(input) +
      " answered " +
      status +
      (detail === "" ? "" : " (" + detail + ")") +
      quotedBody(text),
  );

/** A failure naming the port when the server never answered at all. */
const transportFailure = (url: string, port: number, cause: string): Error =>
  new Error(
    "tack-conformance: the OpenCode server on port " +
      port +
      " did not answer " +
      url +
      ": " +
      cause,
  );

/** Reads a response body as bytes, refusing more than `MAX_BODY_BYTES`. */
const readText = (input: HttpRequest, body: Stream.Stream<Uint8Array>): Effect.Effect<string> =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let size = 0;

    yield* Stream.runForEach(body, (chunk) =>
      Effect.suspend(() => {
        size += chunk.length;

        if (size > MAX_BODY_BYTES) {
          return Effect.die(
            new Error(
              "tack-conformance: " +
                describe(input) +
                " returned more than " +
                MAX_BODY_BYTES +
                " bytes",
            ),
          );
        }

        chunks.push(chunk);

        return Effect.void;
      }),
    );

    return Buffer.concat(chunks).toString("utf8");
  });

/**
 * The response body, ended rather than failed when the connection closes: the
 * server stopping is how an event stream ends.
 */
const bodyOf = (response: Response): Stream.Stream<Uint8Array> => {
  const body = response.body;

  if (body === null) return Stream.empty;

  return Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => String(cause),
  }).pipe(Stream.catchCause(() => Stream.empty));
};

/** Parses a JSON body, dying with the status, the path and the body. */
const parseJson = (input: HttpRequest, status: number, text: string): Effect.Effect<Schema.Json> =>
  Effect.suspend(() => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      return Effect.die(badResponse(input, status, text, "not JSON"));
    }

    return Schema.decodeUnknownEffect(Schema.Json)(parsed).pipe(
      Effect.mapError(() => badResponse(input, status, text, "not JSON")),
      Effect.orDie,
    );
  });

/** The harness's HTTP adapter, with Basic auth on every request. */
const httpClient = (port: number, password: string): Client => {
  const authorization = basicAuth(password);

  const request = (input: HttpRequest, timeoutMs: number): Effect.Effect<HttpResponse> =>
    Effect.gen(function* () {
      const url = baseUrl(port) + input.path;

      const headers = new Headers({
        authorization,
        accept: input.accept ?? "application/json",
      });

      if (input.body !== undefined) headers.set("content-type", "application/json");

      const init: RequestInit = {
        method: input.method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      };

      const sent: RequestInit =
        input.body === undefined ? init : { ...init, body: JSON.stringify(input.body) };

      // The harness's HTTP adapter: Effect's diagnostics forbid a bare fetch, so
      // this is the only call site in the harness and everything else goes here.
      // @effect-diagnostics globalFetch:off
      // @effect-diagnostics globalFetchInEffect:off
      const response = yield* Effect.tryPromise({
        try: () => fetch(url, sent),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(Effect.catch((cause) => Effect.die(transportFailure(url, port, cause))));

      return { status: response.status, body: bodyOf(response) };
    });

  const json = <A>(input: HttpRequest, schema: Schema.Codec<A, unknown>): Effect.Effect<A> =>
    Effect.gen(function* () {
      const response = yield* request(input, REQUEST_TIMEOUT_MS);
      const text = yield* readText(input, response.body);

      if (response.status < 200 || response.status > 299) {
        return yield* Effect.die(badResponse(input, response.status, text, ""));
      }

      const parsed = yield* parseJson(input, response.status, text);

      return yield* Schema.decodeEffect(schema)(parsed).pipe(
        Effect.mapError((cause) => badResponse(input, response.status, text, cause.message)),
        Effect.orDie,
      );
    });

  return { request, json };
};

/** Repeats `check` until it succeeds, then gives up with `giveUp`. */
const pollUntil = <A>(check: Effect.Effect<A>, giveUp: () => Effect.Effect<A>): Effect.Effect<A> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const settled = yield* Effect.exit(check);

      if (Exit.isSuccess(settled)) return settled.value;

      if (Cause.hasInterruptsOnly(settled.cause)) return yield* Effect.failCause(settled.cause);

      if (attempt < POLL_ATTEMPTS - 1) yield* Effect.sleep(POLL_INTERVAL_MS);
    }

    return yield* giveUp();
  });

const sessionPath = (sessionID: string): string => "/api/session/" + encodeURIComponent(sessionID);

const createSession = (client: Client, directory: string): Effect.Effect<{ readonly id: string }> =>
  client
    .json(
      {
        method: "POST",
        path: "/api/session",
        body: { model: { providerID: "fake", id: "scripted" }, location: { directory } },
      },
      CreatedSchema,
    )
    .pipe(Effect.map((created) => ({ id: created.data.id })));

const prompt = (client: Client, sessionID: string, text: string): Effect.Effect<void> =>
  client
    .json({ method: "POST", path: sessionPath(sessionID) + "/prompt", body: { text } }, Schema.Json)
    .pipe(Effect.asVoid);

const interrupt = (client: Client, sessionID: string): Effect.Effect<void> =>
  client
    .json({ method: "POST", path: sessionPath(sessionID) + "/interrupt" }, InterruptSchema)
    .pipe(Effect.asVoid);

/** Sends one request that must answer 204 No Content. */
const expectNoContent = (client: Client, input: HttpRequest): Effect.Effect<void> =>
  Effect.gen(function* () {
    const response = yield* client.request(input, REQUEST_TIMEOUT_MS);
    const text = yield* readText(input, response.body);

    if (response.status !== 204) {
      return yield* Effect.die(badResponse(input, response.status, text, "expected 204"));
    }

    return yield* Effect.void;
  });

const reloadLocations = (client: Client): Effect.Effect<void> =>
  expectNoContent(client, { method: "POST", path: "/api/location/reload" });

const deleteSession = (client: Client, sessionID: string): Effect.Effect<void> =>
  expectNoContent(client, { method: "DELETE", path: sessionPath(sessionID) });

const session = (client: Client, sessionID: string): Effect.Effect<SessionTurn> =>
  client
    .json({ method: "GET", path: sessionPath(sessionID) }, SessionSchema)
    .pipe(Effect.map((info) => info.data));

const pluginIds = (plugins: typeof PluginSchema.Type): ReadonlyArray<string> =>
  plugins.data.flatMap((plugin) => (plugin.id === undefined ? [] : [plugin.id]));

const awaitPlugin = (client: Client, directory: string): Effect.Effect<void> => {
  const input: HttpRequest = {
    method: "GET",
    path: "/api/plugin?location[directory]=" + encodeURIComponent(directory),
  };

  let listed = "no reply";

  const check = client.json(input, PluginSchema).pipe(
    Effect.flatMap((plugins) => {
      const ids = pluginIds(plugins);

      listed = ids.length === 0 ? "none" : ids.join(", ");

      return ids.some((id) => id.startsWith(PLUGIN_PREFIX))
        ? Effect.void
        : Effect.die(new Error("tack-conformance: no tack plugin is listed yet"));
    }),
  );

  return pollUntil(check, () =>
    Effect.die(
      new Error(
        "tack-conformance: no tack plugin is listed for " +
          directory +
          " within " +
          READY_TIMEOUT_MS +
          " ms; listed: " +
          listed,
      ),
    ),
  );
};

/** The `data:` payloads of one event record, joined as the SSE spec joins them. */
const dataOf = (record: string): string => {
  const lines: Array<string> = [];

  for (const line of record.split("\n")) {
    if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
  }

  return lines.join("\n");
};

/**
 * Splits text chunks on the record separator. A partial record already over
 * the cap fails rather than buffering without a bound.
 */
const splitFrames = (
  input: HttpRequest,
  buffer: string,
): Effect.Effect<readonly [string, ReadonlyArray<string>]> =>
  Effect.suspend(() => {
    const parts = buffer.split(FRAME_SEPARATOR);
    const pending = parts.pop() ?? "";

    const overCap =
      parts.some((part) => Buffer.byteLength(part, "utf8") > MAX_EVENT_BYTES) ||
      Buffer.byteLength(pending, "utf8") > MAX_EVENT_BYTES;

    if (overCap) {
      return Effect.die(
        new Error(
          "tack-conformance: an event from " +
            describe(input) +
            " exceeded " +
            MAX_EVENT_BYTES +
            " bytes",
        ),
      );
    }

    return Effect.succeed([pending, parts] as const);
  });

/** Turns the body's text chunks into complete event records. */
const frames =
  (input: HttpRequest) =>
  (chunks: Stream.Stream<string>): Stream.Stream<string> =>
    chunks.pipe(
      Stream.mapAccumEffect(
        () => "",
        (pending, chunk) => splitFrames(input, pending + chunk),
        { onHalt: (pending) => (pending.trim() === "" ? [] : [pending]) },
      ),
      Stream.map(dataOf),
      Stream.filter((text) => text !== ""),
    );

const badEvent = (input: HttpRequest, text: string, detail: string): Error =>
  new Error(
    "tack-conformance: an event from " + describe(input) + " is " + detail + quotedBody(text),
  );

/** Decodes one event payload, keeping the whole payload for the caller. */
const readEvent = (input: HttpRequest, text: string): Effect.Effect<EventRecord> =>
  Effect.suspend(() => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      return Effect.die(badEvent(input, text, "not JSON"));
    }

    return Effect.gen(function* () {
      const json = yield* Schema.decodeUnknownEffect(Schema.Json)(parsed).pipe(
        Effect.mapError(() => badEvent(input, text, "not JSON")),
      );

      const envelope = yield* Schema.decodeUnknownEffect(EventSchema)(json).pipe(
        Effect.mapError(() => badEvent(input, text, "missing its type")),
      );

      return { type: envelope.type, json };
    }).pipe(Effect.orDie);
  });

const events = (client: Client, types: ReadonlyArray<string>): Stream.Stream<Schema.Json> => {
  const input: HttpRequest = { method: "GET", path: "/api/event", accept: "text/event-stream" };

  return Stream.unwrap(
    Effect.gen(function* () {
      const response = yield* client.request(input, STREAM_TIMEOUT_MS);

      if (response.status !== 200) {
        const text = yield* readText(input, response.body);

        return yield* Effect.die(
          badResponse(input, response.status, text, "expected an event stream"),
        );
      }

      return response.body.pipe(
        Stream.decodeText(),
        frames(input),
        Stream.mapEffect((text) => readEvent(input, text)),
        Stream.filter((event) => types.length === 0 || types.includes(event.type)),
        Stream.map((event) => event.json),
        Stream.buffer({ capacity: MAX_BUFFERED_EVENTS }),
      );
    }),
  );
};

const AddressSchema = Schema.Struct({ port: Schema.Finite });
const isAddress = Schema.is(AddressSchema);

/** Closes the probe when the reservation ends before the port is read. */
const closeProbe = (server: Server): Effect.Effect<void> =>
  Effect.sync(() => {
    if (server.listening) server.close();
  });

/**
 * Reserves a free loopback port without holding it: listen on port 0, read the
 * port, close, and pass that port to the child.
 */
const freePort = (): Effect.Effect<number> =>
  Effect.callback<number>((resume, signal) => {
    const server = createServer();

    server.once("error", (cause) => resume(Effect.die(cause)));

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || !isAddress(address)) {
        resume(Effect.die(new Error("tack-conformance: the reserved port has no address")));

        return;
      }

      const port = address.port;

      server.close(() => resume(Effect.succeed(port)));
    });

    signal.addEventListener("abort", () => server.close(), { once: true });

    return closeProbe(server);
  }).pipe(
    Effect.timeoutOrElse({
      duration: 5_000,
      orElse: () =>
        Effect.die(new Error("tack-conformance: no free port was reserved within 5000 ms")),
    }),
  );

const listeningUrl = (line: string): string | null => {
  const match = LISTENING.exec(line);

  return match === null ? null : (match[1] ?? null);
};

const notReady = (child: Duplex, port: number): Effect.Effect<never> =>
  child.stderrTail.pipe(
    Effect.flatMap((tail) =>
      Effect.die(
        new Error(
          "tack-conformance: the OpenCode server on port " +
            port +
            " was not ready within " +
            READY_TIMEOUT_MS +
            " ms\nstderr:\n" +
            (tail === "" ? "(empty)" : tail),
        ),
      ),
    ),
  );

const exitedEarly = (child: Duplex, port: number, code: number): Effect.Effect<never> =>
  child.stderrTail.pipe(
    Effect.flatMap((tail) =>
      Effect.die(
        new Error(
          "tack-conformance: the OpenCode server on port " +
            port +
            " exited with " +
            code +
            " before it was ready\nstderr:\n" +
            (tail === "" ? "(empty)" : tail),
        ),
      ),
    ),
  );

const infoCheck = (client: Client): Effect.Effect<void> =>
  client.json({ method: "GET", path: "/api/info" }, InfoSchema).pipe(Effect.asVoid);

/**
 * Waits for the listening line, then for `/api/info` if the line does not
 * come; a child that exits first fails with its stderr tail, as does a server
 * that never answers within the bound.
 */
const waitForReady = (
  child: Duplex,
  client: Client,
  port: number,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();

    yield* Effect.forkScoped(
      child.lines.pipe(
        Stream.runForEach((line) =>
          listeningUrl(line) === null
            ? Effect.void
            : Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
        ),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.void,
        ),
      ),
    );

    const announced = Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: ANNOUNCE_GRACE_MS,
        orElse: () => pollUntil(infoCheck(client), () => notReady(child, port)),
      }),
    );

    yield* Effect.raceFirst(
      announced,
      child.exited.pipe(Effect.flatMap((code) => exitedEarly(child, port, code))),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: READY_TIMEOUT_MS,
      orElse: () => notReady(child, port),
    }),
  );

/**
 * Starts `opencode serve` on a reserved loopback port with a private password,
 * and returns the client a scenario drives. The child lives in its own scope,
 * which `stop` closes early: SIGTERM, then SIGKILL after the duplex's grace.
 * The surrounding scope closes it too, so a failed scenario leaves no process.
 */
export const opencodeServer = (box: Sandbox): Effect.Effect<OpenCodeServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const port = yield* freePort();
    const password = randomUUID();

    const lifetime = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );

    const child = yield* duplexChild({
      bin: box.opencode.bin,
      args: ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      cwd: box.projectDir,
      env: { ...box.opencode.env, OPENCODE_PASSWORD: password },
      timeoutMs: EXIT_TIMEOUT_MS,
      // The server spawns helpers of its own; killing only the child leaves
      // them behind. This suite runs in CI or a disposable container, never on
      // a developer's Mac.
      detached: true,
    }).pipe(Scope.provide(lifetime));

    const client = httpClient(port, password);

    yield* waitForReady(child, client, port);

    const stop = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Scope.close(lifetime, Exit.void);

        yield* child.exited.pipe(
          Effect.timeoutOrElse({
            duration: STOP_TIMEOUT_MS,
            orElse: () =>
              Effect.die(
                new Error(
                  "tack-conformance: the OpenCode server on port " +
                    port +
                    " outlived stop by " +
                    STOP_TIMEOUT_MS +
                    " ms",
                ),
              ),
          }),
        );
      });

    return {
      createSession: (input) => createSession(client, input.directory),
      prompt: (sessionID, text) => prompt(client, sessionID, text),
      interrupt: (sessionID) => interrupt(client, sessionID),
      deleteSession: (sessionID) => deleteSession(client, sessionID),
      session: (sessionID) => session(client, sessionID),
      events: (types) => events(client, types),
      awaitPlugin: (directory) => awaitPlugin(client, directory),
      reloadLocations: () => reloadLocations(client),
      stop,
    };
  });
