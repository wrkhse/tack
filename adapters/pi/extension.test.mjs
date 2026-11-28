import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const fixturePath = new URL("./fixture-values.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const { DENY_REASONS: reasonNames, PROTOCOL_VERSION } = fixture;
const template = new URL("./register.js", import.meta.url);
let source = readFileSync(template, "utf8");

for (const [name, value] of Object.entries(fixture)) {
  source = source.replaceAll(`__TACK_${name}__`, () => JSON.stringify(value));
}

// Replace only the module boundary. Every call uses an injected spawn, file
// writer and clock; the suite cannot launch tack-hook or send OS signals.
const load = new Function(
  "spawn",
  "appendFileSync",
  "process",
  "setTimeout",
  "clearTimeout",
  '"use strict";\n' +
    source
      .replace('import { spawn } from "node:child_process";', "")
      .replace('import { appendFileSync } from "node:fs";', "")
      .replace(
        "export default function register(pi)",
        "function register(pi)",
      ) +
    "\nreturn register;",
);

function fakeChild(onInput, kills, killError) {
  const child = new EventEmitter();

  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (line) => onInput(line, child);
  child.kill = (signal) => {
    kills.push(signal);

    if (killError) throw killError;
  };

  return child;
}

function harness(respond, options = {}) {
  const handlers = new Map();
  const entries = [];
  const tools = [];
  const starts = [];
  const writes = [];
  const lines = [];
  const kills = [];
  const timers = [];

  function spawn(...args) {
    starts.push(args);

    if (options.spawnError) throw options.spawnError;

    return fakeChild(
      (line, child) => {
        lines.push(line);
        respond(JSON.parse(line), child);
      },
      kills,
      options.killError,
    );
  }

  function setTimer(fn, ms) {
    const timer = { fn, ms, cleared: false };
    timers.push(timer);

    return timer;
  }

  const register = load(
    spawn,
    (...args) => {
      if (options.recordError) throw options.recordError;

      writes.push(args);
    },
    { env: options.noRecorder ? {} : { TACK_RECORDER: "/recorder" } },
    setTimer,
    (timer) => {
      timer.cleared = true;
    },
  );

  register({
    on(type, handler) {
      handlers.set(type, handler);
    },
    appendEntry(...args) {
      entries.push(args);
    },
    registerTool(tool) {
      tools.push(tool);
    },
  });

  return { handlers, entries, tools, starts, writes, lines, kills, timers };
}

function bash(command = "git push origin main") {
  return { toolName: "bash", input: { command } };
}

function guard(h, event = bash()) {
  return h.handlers.get("tool_call")(event);
}

function runTool(h, params) {
  return h.tools[0].execute("pi-tool-id", params);
}

function block(reason) {
  return { block: true, reason: "tack: " + reason };
}

function toolError(reason) {
  return {
    content: [{ type: "text", text: "tack: " + reason }],
    details: {},
    isError: true,
  };
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
const DENY = { outcome: { kind: "deny", reason: "push blocked" } };
const STATUS = { content: [{ kind: "text", text: "guard_status: daemon ok" }] };

test("Pi registers one guarded Bash handler, tool and session load marker", () => {
  const h = harness(() => {
    assert.fail("registration cannot spawn");
  });

  assert.deepEqual([...h.handlers.keys()], ["tool_call", "session_start"]);
  assert.deepEqual(h.entries, []);

  h.handlers.get("session_start")();
  h.handlers.get("session_start")();

  assert.deepEqual(h.entries, [["tack-loaded", {}]]);
  assert.equal(h.tools.length, 1);
  assert.equal(h.tools[0].name, "guard_status");
  assert.deepEqual(h.tools[0].parameters, { type: "object", properties: {} });
  assert.deepEqual(h.starts, []);
});

test("every Bash command goes to tack-hook and other tools skip it", async () => {
  const h = harness(answer(ALLOW));
  const commands = ["git status", "echo git push", "git push origin main"];

  assert.equal(await guard(h, { ...bash(), toolName: "read" }), undefined);
  assert.deepEqual(h.starts, []);

  for (const command of commands) {
    assert.equal(await guard(h, bash(command)), undefined);
  }

  const invocation = [
    "tack-hook",
    [
      "--plugin",
      "/plugins/safe-push",
      "--plugin-name",
      "safe-push",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  ];
  const requests = commands.map((command, index) => ({
    kind: "hook",
    id: index + 1,
    version: 1,
    hook: "toolBefore",
    call: { tool: "shell", name: "Bash", input: { command }, session_id: null },
  }));

  assert.deepEqual(h.starts, [invocation, invocation, invocation]);
  assert.deepEqual(
    h.lines,
    requests.map((request) => JSON.stringify(request) + "\n"),
  );
  assert.deepEqual(
    h.writes,
    [1, 2, 3].map((id) => ["/recorder", `{"call":"bash","id":${id}}\n`]),
  );
});

test("allow uses the last non-empty stdout line without rewriting", async () => {
  const h = harness(
    (request, child) => {
      emitLine(child, reply(request, DENY));
      emitLine(child, reply(request, ALLOW));
      child.stdout.emit("data", Buffer.from("\n \t\r\n"));
      child.emit("close", 0);
    },
    { noRecorder: true },
  );
  const event = bash();

  assert.equal(await guard(h, event), undefined);
  assert.deepEqual(event, bash());
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.kills, []);
});

test("a valid deny and tool success each append one line with their request id", async () => {
  const h = harness((request, child) => {
    answer(request.kind === "hook" ? DENY : STATUS)(request, child);
  });

  assert.deepEqual(await guard(h), block("push blocked"));
  assert.deepEqual(await runTool(h, {}), {
    content: [{ type: "text", text: "guard_status: daemon ok" }],
    details: {},
  });

  const command = "git push origin main";
  const hook = {
    kind: "hook",
    id: 1,
    version: 1,
    hook: "toolBefore",
    call: { tool: "shell", name: "Bash", input: { command }, session_id: null },
  };
  const tool = {
    kind: "tool",
    id: 2,
    version: 1,
    name: "guard_status",
    input: {},
  };
  const invocation = [
    "tack-hook",
    [
      "--plugin",
      "/plugins/safe-push",
      "--plugin-name",
      "safe-push",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  ];

  assert.deepEqual(h.starts, [invocation, invocation]);
  assert.deepEqual(
    h.lines,
    [hook, tool].map((request) => JSON.stringify(request) + "\n"),
  );
  assert.deepEqual(h.writes, [
    ["/recorder", '{"call":"bash","id":1}\n'],
    ["/recorder", '{"call":"guard_status","id":2}\n'],
  ]);
  assert.deepEqual(
    h.timers.map(({ ms, cleared }) => [ms, cleared]),
    [
      [8500, true],
      [8500, true],
    ],
  );
});

test("a successful allow also appends exactly one recorder line", async () => {
  const h = harness(answer(ALLOW));

  assert.equal(await guard(h), undefined);
  assert.deepEqual(h.writes, [["/recorder", '{"call":"bash","id":1}\n']]);
});

for (const error of [
  ...reasonNames,
  "malformed",
  "too_large",
  "unrecognized",
]) {
  test(
    "error envelope answers either request and is not recorded: " + error,
    async () => {
      const reason = reasonNames.includes(error) ? error : "daemon_error";
      const h = harness(
        answer({ kind: "error", error, message: "test error" }),
      );

      assert.deepEqual(await guard(h), block(reason));
      assert.deepEqual(await runTool(h, {}), toolError(reason));
      assert.deepEqual(h.writes, []);
    },
  );
}

test("an id-0 busy reply blocks as busy", async () => {
  const h = harness(
    answer({
      id: 0,
      version: PROTOCOL_VERSION,
      kind: "error",
      error: "busy",
      message: "tack: busy",
    }),
  );

  assert.deepEqual(await guard(h), block("busy"));
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
  [
    "invalid UTF-8",
    (_request, child) => {
      child.stdout.emit("data", Buffer.from([0xff]));
      child.emit("close", 0);
    },
    "malformed_reply",
  ],
  ["wrong id", answer({ ...ALLOW, id: 2 }), "malformed_reply"],
  ["wrong version", answer({ ...ALLOW, version: 2 }), "protocol_version"],
  ["wrong kind", answer({ kind: "tool", ...STATUS }), "malformed_reply"],
  ["unrecognized kind", answer({ kind: "nope" }), "malformed_reply"],
  ["invalid error reply", answer({ kind: "error" }), "malformed_reply"],
  ["missing outcome", answer({}), "malformed_reply"],
  [
    "invalid deny",
    answer({
      outcome: { kind: "deny", reason: 2 },
    }),
    "malformed_reply",
  ],
  [
    "rewrite",
    answer({
      outcome: { kind: "rewrite", input: { command: "git push --dry-run" } },
    }),
    "malformed_reply",
  ],
];

for (const [label, respond, reason] of badReplies) {
  test(label + " blocks without rewriting or recording", async () => {
    const h = harness(respond);
    const event = bash();

    assert.deepEqual(await guard(h, event), block(reason));
    assert.deepEqual(event, bash());
    assert.deepEqual(h.writes, []);
  });
}

for (const code of ["EPIPE", "ERR_STREAM_DESTROYED"]) {
  test(
    "invalid stdout after stdin " + code + " is refused as malformed",
    async () => {
      const h = harness((_request, child) => {
        child.stdin.emit(
          "error",
          Object.assign(new Error("input failed"), { code }),
        );
        child.stdout.emit("data", Buffer.from("not JSON\n"));
        child.emit("close", 0);
      });

      assert.deepEqual(await guard(h), block("malformed_reply"));
      assert.deepEqual(h.writes, []);
    },
  );
}

test("an invalid guard_status reply is refused and never recorded", async () => {
  for (const body of [
    { kind: "hook", ...ALLOW },
    { ...STATUS, id: 2 },
    { ...STATUS, version: 2 },
    {},
    { content: [] },
    { content: [{ kind: "image", text: "guard_status: daemon ok" }] },
    { content: [{ kind: "text", text: "fake success" }] },
    { content: [...STATUS.content, ...STATUS.content] },
  ]) {
    const h = harness(answer(body));

    const expected =
      body.version === 2 ? "protocol_version" : "malformed_reply";
    assert.deepEqual(await runTool(h, {}), toolError(expected));
    assert.deepEqual(h.writes, []);
  }
});

test("invalid tool parameters never reach tack-hook or the recorder", async () => {
  const h = harness(answer(STATUS));

  for (const params of [undefined, null, 42, [], { extra: true }]) {
    assert.deepEqual(await runTool(h, params), toolError("malformed"));
  }

  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.writes, []);
});

test("one 8500 ms deadline kills the child and resolves without close", async () => {
  let child;
  const h = harness((request, active) => {
    child = active;
    emitLine(child, reply(request, ALLOW));
    // A complete reply does not bypass the deadline while the child is open.
  });
  const pending = guard(h);

  const timerState = () => h.timers.map(({ ms, cleared }) => [ms, cleared]);

  assert.deepEqual(timerState(), [[8500, false]]);
  h.timers[0].fn();

  assert.deepEqual(await pending, block("timeout"));
  assert.deepEqual(h.kills, ["SIGKILL"]);
  assert.deepEqual(timerState(), [[8500, true]]);

  child.emit("close", 0);
  assert.deepEqual(h.writes, []);
});

test("throwing while killing a timed out child still returns the named error", async () => {
  const h = harness(() => {}, { killError: new Error("kill failed") });
  const pending = runTool(h, {});

  h.timers[0].fn();

  assert.deepEqual(await pending, toolError("timeout"));
  assert.deepEqual(h.kills, ["SIGKILL"]);
  assert.deepEqual(h.writes, []);
});

test("a missing tack-hook blocks either request without recording", async () => {
  const enoent = Object.assign(new Error("hook not found"), { code: "ENOENT" });

  for (const [respond, options] of [
    [(_request, child) => child.emit("error", enoent), {}],
    [() => {}, { spawnError: enoent }],
  ]) {
    const h = harness(respond, options);

    assert.deepEqual(await guard(h), block("hook_missing"));
    assert.deepEqual(await runTool(h, {}), toolError("hook_missing"));
    assert.deepEqual(h.writes, []);
  }
});

test("pipe errors with no stdout wait for close and fail closed", async () => {
  for (const [pipe, code] of [
    ["stdin", "EPIPE"],
    ["stdin", "ENOENT"],
    ["stdout", "EIO"],
  ]) {
    let child;
    const h = harness((_request, active) => {
      child = active;
      child[pipe].emit(
        "error",
        Object.assign(new Error("pipe failed"), { code }),
      );
    });
    const pending = guard(h);

    assert.equal(h.timers[0].cleared, false);
    child.emit("close", 0);

    assert.deepEqual(await pending, block("daemon_error"));
    assert.deepEqual(h.kills, []);
    assert.deepEqual(h.writes, []);
  }
});

test("other process and recorder failures block with no promise catch on the handler", async () => {
  for (const [respond, options] of [
    [(_request, child) => child.emit("close", null, "SIGSEGV"), {}],
    [() => {}, { spawnError: new Error("spawn failed") }],
    [answer(ALLOW), { recordError: new Error("recorder unavailable") }],
  ]) {
    const h = harness(respond, options);

    assert.deepEqual(await guard(h), block("daemon_error"));
    assert.deepEqual(h.writes, []);
  }
});

test("oversized frames are bounded without recording a call", async () => {
  const h = harness((_request, child) => {
    child.stdout.emit("data", Buffer.alloc(1048577));
  });

  assert.deepEqual(
    await guard(h, bash("git push " + "x".repeat(1048576))),
    block("daemon_error"),
  );
  assert.deepEqual(h.starts, []);
  assert.deepEqual(await guard(h), block("malformed_reply"));
  assert.deepEqual(h.kills, ["SIGKILL"]);
  assert.deepEqual(h.writes, []);
});
