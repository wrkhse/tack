import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const fixture = JSON.parse(
  readFileSync(new URL("./fixture-values.json", import.meta.url), "utf8"),
);
const { DENY_REASONS: reasonNames, PROTOCOL_VERSION } = fixture;

function template(name) {
  return readFileSync(new URL("./" + name, import.meta.url), "utf8");
}

function fill(source) {
  for (const [name, value] of Object.entries(fixture)) {
    source = source.replaceAll(`__TACK_${name}__`, () => JSON.stringify(value));
  }

  return source;
}

// Replace only the module boundary and the entry call. Every run uses an
// injected spawn, file writer, clock and streams; no process starts.
function load(source, entry, result) {
  const body = fill(source)
    .replace('import { spawn } from "node:child_process";', "")
    .replace('import { appendFileSync } from "node:fs";', "")
    .replace(entry, "");

  assert.equal(body.includes("__TACK_"), false);

  return new Function(
    "spawn",
    "appendFileSync",
    "process",
    "setTimeout",
    "clearTimeout",
    '"use strict";\n' + body + "\nreturn " + result + ";",
  );
}

const client = template("client.js");
const loadHook = load(
  client + template("pre-tool-use.js"),
  "main(process.stdin, process.stdout, (code) => process.exit(code));",
  "main",
);
const loadMcp = load(
  client + template("mcp.js"),
  `serve(process.stdin, (message) => {
  process.stdout.write(JSON.stringify(message) + "\\n");
});`,
  "serve",
);
const loadSession = load(
  template("session-start.js"),
  "main(process.stdin, process.env, (code) => process.exit(code));",
  "main",
);

function fakeChild(onInput, kills) {
  const child = new EventEmitter();

  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (line) => onInput(line, child);
  child.kill = (signal) => kills.push(signal);

  return child;
}

function world(respond, options = {}) {
  const w = { starts: [], lines: [], kills: [], writes: [], timers: [] };

  w.spawn = (...args) => {
    w.starts.push(args);

    if (options.spawnError) throw options.spawnError;

    return fakeChild((line, child) => {
      w.lines.push(line);
      respond(JSON.parse(line), child);
    }, w.kills);
  };
  w.append = (...args) => {
    if (options.recordError) throw options.recordError;

    w.writes.push(args);
  };
  w.setTimer = (fn, ms) => {
    const timer = { fn, ms, cleared: false };
    w.timers.push(timer);

    return timer;
  };
  w.clearTimer = (timer) => {
    if (timer) timer.cleared = true;
  };
  w.process = { env: { TACK_RECORDER: "/recorder" } };

  return w;
}

function reply({ id, version, kind }, body) {
  return { id, version, kind, ...body };
}

function emitLine(child, value) {
  child.stdout.emit("data", Buffer.from(JSON.stringify(value) + "\n"));
}

function answer(body) {
  return (request, child) => {
    emitLine(child, reply(request, body));
    child.emit("close", 0);
  };
}

const ALLOW = { outcome: { kind: "allow" } };
const DENY = { outcome: { kind: "deny", reason: "  push blocked \n" } };
const STATUS = { content: [{ kind: "text", text: "guard_status: daemon ok" }] };

function bashEvent(command = "git push origin main") {
  return {
    session_id: "s",
    turn_id: "t",
    cwd: "/repo",
    model: "m",
    permission_mode: "default",
    transcript_path: null,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "u",
    tool_input: { command },
  };
}

// Start the hook; feed it stdin with feed(stdin). Resolves with its output.
function startHook(w, feed) {
  const main = loadHook(w.spawn, w.append, w.process, w.setTimer, w.clearTimer);
  const stdin = new EventEmitter();
  const out = [];

  const done = new Promise((resolve) => {
    main(
      stdin,
      {
        write(text, callback) {
          out.push(text);
          callback();
        },
      },
      (code) => resolve({ code, out }),
    );
  });

  feed(stdin);
  return done;
}

function send(event) {
  return (stdin) => {
    stdin.emit("data", Buffer.from(JSON.stringify(event)));
    stdin.emit("end");
  };
}

function block(reason) {
  return {
    code: 0,
    out: [
      JSON.stringify({ decision: "block", reason: "tack: " + reason }) + "\n",
    ],
  };
}

const ALLOWED = { code: 0, out: ["{}\n"] };

test("allow prints an empty object and records the call", async () => {
  const w = world(answer(ALLOW));

  assert.deepEqual(await startHook(w, send(bashEvent())), ALLOWED);
  assert.deepEqual(w.starts, [
    [
      "tack-hook",
      ["--plugin", "/plugins/safe-push"],
      { stdio: ["pipe", "pipe", "ignore"] },
    ],
  ]);
  assert.deepEqual(w.lines, [
    JSON.stringify({
      kind: "hook",
      id: 1,
      version: 1,
      hook: "toolBefore",
      call: {
        tool: "shell",
        name: "Bash",
        input: { command: "git push origin main" },
        session_id: null,
      },
    }) + "\n",
  ]);
  assert.deepEqual(w.writes, [["/recorder", '{"call":"bash","id":1}\n']]);
  assert.deepEqual(
    w.timers.map(({ ms, cleared }) => [ms, cleared]),
    [[8000, true]],
  );
});

test("deny prints the one block form with a trimmed reason", async () => {
  const w = world(answer(DENY));

  assert.deepEqual(
    await startHook(w, send(bashEvent())),
    block("push blocked"),
  );
  assert.deepEqual(w.writes, [["/recorder", '{"call":"bash","id":1}\n']]);
});

test("every Bash command goes to tack-hook, which decides", async () => {
  for (const [command, body, expected] of [
    ["git status", ALLOW, ALLOWED],
    ["echo git push", ALLOW, ALLOWED],
    ["git push origin main", DENY, block("push blocked")],
  ]) {
    const w = world(answer(body));

    assert.deepEqual(await startHook(w, send(bashEvent(command))), expected);
    assert.deepEqual(w.starts, [
      [
        "tack-hook",
        ["--plugin", "/plugins/safe-push"],
        { stdio: ["pipe", "pipe", "ignore"] },
      ],
    ]);
    assert.deepEqual(w.lines, [
      JSON.stringify({
        kind: "hook",
        id: 1,
        version: 1,
        hook: "toolBefore",
        call: {
          tool: "shell",
          name: "Bash",
          input: { command },
          session_id: null,
        },
      }) + "\n",
    ]);
    assert.deepEqual(w.writes, [["/recorder", '{"call":"bash","id":1}\n']]);
  }
});

test("a call that is not a Bash command string skips tack-hook", async () => {
  for (const event of [
    { ...bashEvent(), tool_name: "apply_patch" },
    { ...bashEvent(), tool_input: { command: ["git", "push"] } },
  ]) {
    const w = world(answer(DENY));

    assert.deepEqual(await startHook(w, send(event)), ALLOWED);
    assert.deepEqual(w.starts, []);
    assert.deepEqual(w.writes, []);
  }
});

test("unreadable hook input blocks before tack-hook", async () => {
  for (const [feed, reason] of [
    [
      (stdin) => {
        stdin.emit("data", Buffer.from("not json"));
        stdin.emit("end");
      },
      "malformed",
    ],
    [
      (stdin) => {
        stdin.emit("data", Buffer.from([0xff]));
        stdin.emit("end");
      },
      "malformed",
    ],
    [(stdin) => stdin.emit("data", Buffer.alloc(1048577)), "malformed"],
    [(stdin) => stdin.emit("error", new Error("read failed")), "aborted"],
  ]) {
    const w = world(answer(ALLOW));

    assert.deepEqual(await startHook(w, feed), block(reason));
    assert.deepEqual(w.starts, []);
  }
});

for (const error of [
  ...reasonNames,
  "malformed",
  "too_large",
  "unrecognized",
]) {
  test("error envelope blocks without a record: " + error, async () => {
    const reason = reasonNames.includes(error) ? error : "daemon_error";
    const w = world(answer({ kind: "error", error, message: "test error" }));

    assert.deepEqual(await startHook(w, send(bashEvent())), block(reason));
    assert.deepEqual(w.writes, []);
  });
}

test("an id-0 busy reply blocks as busy", async () => {
  const w = world(
    answer({
      id: 0,
      version: PROTOCOL_VERSION,
      kind: "error",
      error: "busy",
      message: "tack: busy",
    }),
  );

  assert.deepEqual(await startHook(w, send(bashEvent())), block("busy"));
});

const badReplies = [
  [
    "empty output",
    (_request, child) => child.emit("close", 0),
    "malformed_reply",
  ],
  [
    "invalid JSON",
    (_request, child) => {
      child.stdout.emit("data", Buffer.from("not json\n"));
      child.emit("close", 0);
    },
    "malformed_reply",
  ],
  ["wrong id", answer({ ...ALLOW, id: 2 }), "malformed_reply"],
  ["wrong version", answer({ ...ALLOW, version: 2 }), "protocol_version"],
  ["wrong kind", answer({ kind: "tool", ...STATUS }), "malformed_reply"],
  [
    "blank deny",
    answer({ outcome: { kind: "deny", reason: " \n" } }),
    "malformed_reply",
  ],
  [
    "rewrite",
    answer({
      outcome: { kind: "rewrite", input: { command: "git push --dry-run" } },
    }),
    "malformed_reply",
  ],
  [
    "nonzero exit",
    (request, child) => {
      emitLine(child, reply(request, ALLOW));
      child.emit("close", 1);
    },
    "daemon_error",
  ],
];

for (const [label, respond, reason] of badReplies) {
  test(label + " blocks without recording", async () => {
    const w = world(respond);

    assert.deepEqual(await startHook(w, send(bashEvent())), block(reason));
    assert.deepEqual(w.writes, []);
  });
}

test("a pipe error does not hide a malformed reply", async () => {
  const w = world((_request, child) => {
    child.stdin.emit(
      "error",
      Object.assign(new Error("closed"), { code: "EPIPE" }),
    );
    child.stdout.emit("data", Buffer.from("not JSON\n"));
    child.emit("close", 0);
  });

  assert.deepEqual(
    await startHook(w, send(bashEvent())),
    block("malformed_reply"),
  );
});

test("a pipe error with no stdout blocks as daemon_error", async () => {
  const w = world((_request, child) => {
    child.stdout.emit("error", Object.assign(new Error("io"), { code: "EIO" }));
    child.emit("close", 0);
  });

  assert.deepEqual(
    await startHook(w, send(bashEvent())),
    block("daemon_error"),
  );
});

test("the one 8000 ms deadline kills tack-hook and blocks", async () => {
  const w = world(() => {});
  const pending = startHook(w, send(bashEvent()));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    w.timers.map(({ ms }) => ms),
    [8000],
  );
  w.timers[0].fn();

  assert.deepEqual(await pending, block("timeout"));
  assert.deepEqual(w.kills, ["SIGKILL"]);
  assert.deepEqual(w.writes, []);
});

test("the deadline also covers input that never ends", async () => {
  const w = world(answer(ALLOW));
  const pending = startHook(w, () => {});

  w.timers[0].fn();

  assert.deepEqual(await pending, block("timeout"));
  assert.deepEqual(w.starts, []);
});

test("a missing tack-hook and a failing recorder both block", async () => {
  const enoent = Object.assign(new Error("not found"), { code: "ENOENT" });

  assert.deepEqual(
    await startHook(
      world(() => {}, { spawnError: enoent }),
      send(bashEvent()),
    ),
    block("hook_missing"),
  );
  assert.deepEqual(
    await startHook(
      world(answer(ALLOW), { recordError: new Error("full") }),
      send(bashEvent()),
    ),
    block("daemon_error"),
  );
});

// The MCP server, driven with the messages Codex 0.172.0 sends a stdio server.
function startMcp(w) {
  const serve = loadMcp(w.spawn, w.append, w.process, w.setTimer, w.clearTimer);
  const stdin = new EventEmitter();
  const out = [];

  serve(stdin, (message) => out.push(message));

  return {
    out,
    raw(text) {
      stdin.emit("data", Buffer.from(text));
    },
    send(message) {
      stdin.emit(
        "data",
        Buffer.from(
          (typeof message === "string" ? message : JSON.stringify(message)) +
            "\n",
        ),
      );
    },
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: { elicitation: {} },
    clientInfo: { name: "codex-mcp-client", version: "0.172.0" },
  },
};

test("initialize pins 2025-06-18 and lists only guard_status", async () => {
  const w = world(answer(STATUS));
  const mcp = startMcp(w);

  mcp.send(INITIALIZE);
  mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  mcp.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await settle();

  assert.deepEqual(mcp.out, [
    {
      jsonrpc: "2.0",
      id: 0,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tack", version: "0.0.0-test" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "guard_status",
            description: "Reports whether the tack daemon is running",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    },
  ]);
  assert.deepEqual(w.starts, []);
});

test("a guard_status call returns the daemon text and records once", async () => {
  const w = world(answer(STATUS));
  const mcp = startMcp(w);

  mcp.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "guard_status", arguments: {} },
  });
  mcp.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "guard_status" },
  });
  await settle();

  const ok = { content: [{ type: "text", text: "guard_status: daemon ok" }] };
  assert.deepEqual(mcp.out, [
    { jsonrpc: "2.0", id: 2, result: ok },
    { jsonrpc: "2.0", id: 3, result: ok },
  ]);
  assert.deepEqual(
    w.lines,
    [1, 2].map(
      (id) =>
        JSON.stringify({
          kind: "tool",
          id,
          version: 1,
          name: "guard_status",
          input: {},
        }) + "\n",
    ),
  );
  assert.deepEqual(w.writes, [
    ["/recorder", '{"call":"guard_status","id":1}\n'],
    ["/recorder", '{"call":"guard_status","id":2}\n'],
  ]);
});

test("invalid arguments fail before tack-hook", async () => {
  const w = world(answer(STATUS));
  const mcp = startMcp(w);

  for (const [id, args] of [
    [1, null],
    [2, []],
    [3, 42],
    [4, { extra: true }],
  ]) {
    mcp.send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "guard_status", arguments: args },
    });
  }
  await settle();

  const malformed = {
    content: [{ type: "text", text: "tack: malformed" }],
    isError: true,
  };
  assert.deepEqual(
    mcp.out,
    [1, 2, 3, 4].map((id) => ({ jsonrpc: "2.0", id, result: malformed })),
  );
  assert.deepEqual(w.starts, []);
  assert.deepEqual(w.writes, []);
});

test("a failed call returns a named error and records nothing", async () => {
  for (const [respond, options, reason] of [
    [
      answer({ kind: "error", error: "socket_missing", message: "x" }),
      {},
      "socket_missing",
    ],
    [
      answer({ content: [{ kind: "text", text: "fake" }] }),
      {},
      "malformed_reply",
    ],
    [
      () => {},
      { spawnError: Object.assign(new Error("x"), { code: "ENOENT" }) },
      "hook_missing",
    ],
  ]) {
    const w = world(respond, options);
    const mcp = startMcp(w);

    mcp.send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "guard_status", arguments: {} },
    });
    await settle();

    assert.deepEqual(mcp.out, [
      {
        jsonrpc: "2.0",
        id: 7,
        result: {
          content: [{ type: "text", text: "tack: " + reason }],
          isError: true,
        },
      },
    ]);
    assert.deepEqual(w.writes, []);
  }
});

test("unknown methods, tools and lines get JSON-RPC errors", async () => {
  const w = world(answer(STATUS));
  const mcp = startMcp(w);

  mcp.send({ jsonrpc: "2.0", id: 1, method: "server/discover" });
  mcp.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "other" },
  });
  mcp.send("not json");
  mcp.send("[]");
  mcp.send({ jsonrpc: "2.0", id: 3, method: "ping" });
  await settle();

  assert.deepEqual(mcp.out, [
    {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "method not found" },
    },
    { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "unknown tool" } },
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    },
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "invalid request" },
    },
    { jsonrpc: "2.0", id: 3, result: {} },
  ]);
  assert.deepEqual(w.starts, []);
});

test("a line split across chunks is one message", async () => {
  const w = world(answer(STATUS));
  const mcp = startMcp(w);
  const line = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" });

  mcp.raw(line.slice(0, 10));
  mcp.raw(line.slice(10) + "\n\n");
  await settle();

  assert.deepEqual(mcp.out, [{ jsonrpc: "2.0", id: 9, result: {} }]);
});

test("an oversized line is dropped whole with one parse error", async () => {
  const w = world(answer(STATUS));
  const mcp = startMcp(w);

  mcp.raw("x".repeat(1048577));
  mcp.raw("x\n");
  mcp.send({ jsonrpc: "2.0", id: 4, method: "ping" });
  await settle();

  assert.deepEqual(mcp.out, [
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    },
    { jsonrpc: "2.0", id: 4, result: {} },
  ]);
});

test("session start appends exactly one load marker and prints nothing", () => {
  const w = world(() => {});
  const main = loadSession(
    w.spawn,
    w.append,
    w.process,
    w.setTimer,
    w.clearTimer,
  );
  const stdin = new EventEmitter();
  const exits = [];

  stdin.resume = () => {};
  main(stdin, { TACK_RECORDER: "/recorder" }, (code) => exits.push(code));
  stdin.emit("end");
  stdin.emit("end");

  assert.deepEqual(w.writes, [["/recorder", '{"call":"tack-loaded"}\n']]);
  assert.deepEqual(exits, [0]);
  assert.deepEqual(
    w.timers.map(({ ms, cleared }) => [ms, cleared]),
    [[8000, true]],
  );
});
