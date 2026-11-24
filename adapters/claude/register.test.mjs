// Fail-closed checks for the generated Claude Code mod. It loads the golden
// hooks module (the Rust golden test pins it to the rendered output) under a
// fake `on` and `$` whose process.run is scripted: no Claude Code, tack-hook
// or other process runs.
//
//   node adapters/claude/register.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(
  new URL("./golden/register.js", import.meta.url),
  "utf8",
);

const HOOK_ARGV = ["tack-hook", "--plugin", "/plugins/safe-push"];
const BASH = { tool: "Bash", tool_use_id: "toolu_1", command: "git push origin main" };

let loads = 0;
let failures = 0;

// Each load is a fresh module, so its id counter and clock flag start over.
async function load() {
  loads += 1;
  const url = "data:text/javascript," +
    encodeURIComponent(SOURCE + "\n// load " + loads + "\n");
  const mod = await import(url);
  const registrations = [];

  const on = (pattern, ...rest) => {
    const hook = rest[rest.length - 1];
    const matcher = rest.length > 1 ? rest[0] : undefined;
    const registration = { pattern, matcher, hook, handler: undefined };
    registrations.push(registration);
    return {
      catch(handler) {
        assert.equal(registration.handler, undefined, "a second .catch");
        registration.handler = handler;
      },
    };
  };

  mod.register(on, {});
  return registrations;
}

// A fake $ whose process.run answers with `answer(request)`: a run result, or
// a thrown error for a run that cannot start or finish.
function fakeHost(answer) {
  const runs = [];
  const registered = [];
  const timers = [];

  const host = {
    process: {
      async run(argv, init) {
        const request = JSON.parse(init.stdin);
        runs.push({ argv, init, request });
        return answer(request);
      },
    },
    tool: {
      async register(spec) {
        registered.push(spec);
        return { tool: "mcp__tack__" + spec.name };
      },
    },
    clock: {
      after(ms, fn) {
        const timer = { kind: "after", ms, fn, cancelled: false };
        timer.cancel = () => { timer.cancelled = true; };
        timers.push(timer);
        return timer;
      },
      every(ms, fn) {
        const timer = { kind: "every", ms, fn, cancelled: false };
        timer.cancel = () => { timer.cancelled = true; };
        timers.push(timer);
        return timer;
      },
    },
  };

  return { host, runs, registered, timers };
}

function reply(request, fields) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ id: request.id, version: 1, ...fields }) + "\n",
    stderr: "",
    isStdoutTruncated: false,
    isStderrTruncated: false,
  };
}

function raw(stdout, exitCode = 0, truncated = false) {
  return () => ({
    exitCode,
    stdout,
    stderr: "",
    isStdoutTruncated: truncated,
    isStderrTruncated: false,
  });
}

function nextSpy(answer = { result: "ran" }) {
  const calls = [];
  const next = async (e) => {
    calls.push(e);
    return answer;
  };
  return { next, calls };
}

function find(registrations, pattern, tool) {
  const found = registrations.find((r) =>
    r.pattern === pattern && (tool === undefined || r.matcher?.tool === tool));
  assert.ok(found, "no " + pattern + " registration for " + tool);
  return found;
}

async function guard(answer, event = BASH) {
  const registrations = await load();
  const bash = find(registrations, "tool.call", "Bash");
  const fake = fakeHost(answer);
  const spy = nextSpy();
  const result = await bash.hook(fake.host, event, spy.next);
  return { result, ...fake, ...spy };
}

async function check(name, fn) {
  try {
    await fn();
    console.log("PASS " + name);
  } catch (error) {
    failures += 1;
    console.error("FAIL " + name + ": " + (error?.stack ?? error));
  }
}

await check("register wires one guarded Bash hook, the tool and session.start", async () => {
  const registrations = await load();
  const shape = registrations.map((r) => [r.pattern, r.matcher, r.handler?.name]);

  assert.deepEqual(shape, [
    ["session.start", undefined, undefined],
    ["tool.call", { tool: "Bash" }, "refuseFailed"],
    ["tool.call", { tool: "mcp__tack__guard_status" }, "refuseFailed"],
  ]);
});

await check("the hook request has the contract shape and budget", async () => {
  const { runs } = await guard((request) => reply(request, {
    kind: "hook", outcome: { kind: "allow" },
  }));

  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].argv, HOOK_ARGV);
  assert.equal(runs[0].init.timeoutMs, 9000);
  assert.equal(runs[0].init.stdin.endsWith("}\n"), true);
  assert.deepEqual(runs[0].request, {
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
  });
});

await check("allow passes the event on unchanged", async () => {
  const { result, calls } = await guard((request) => reply(request, {
    kind: "hook", outcome: { kind: "allow" },
  }));

  assert.deepEqual(calls, [BASH]);
  assert.deepEqual(result, { result: "ran" });
});

await check("deny refuses before next with the plugin's reason", async () => {
  const { result, calls } = await guard((request) => reply(request, {
    kind: "hook", outcome: { kind: "deny", reason: "push blocked" },
  }));

  assert.deepEqual(calls, []);
  assert.deepEqual(result, { deny: "tack: push blocked" });
});

await check("rewrite passes the rewritten command on", async () => {
  const { calls } = await guard((request) => reply(request, {
    kind: "hook",
    outcome: { kind: "rewrite", input: { command: "git push origin main --dry-run" } },
  }));

  assert.deepEqual(calls, [{ ...BASH, command: "git push origin main --dry-run" }]);
});

const MALFORMED = [
  ["stdout that is not JSON", raw("not json\n")],
  ["empty stdout from a clean exit", raw("")],
  ["a truncated stdout", raw("{}\n", 0, true)],
  ["a reply to another id", (request) => reply({ id: request.id + 1 }, {
    kind: "hook", outcome: { kind: "allow" },
  })],
  ["an unknown reply kind", (request) => reply(request, { kind: "verdict" })],
  ["a tool reply to a hook", (request) => reply(request, {
    kind: "tool", content: [],
  })],
  ["an unknown outcome", (request) => reply(request, {
    kind: "hook", outcome: { kind: "surprise" },
  })],
  ["a missing outcome", (request) => reply(request, { kind: "hook" })],
  ["a rewrite that is not an object", (request) => reply(request, {
    kind: "hook", outcome: { kind: "rewrite", input: "git status" },
  })],
  ["a rewrite of a reserved key", (request) => reply(request, {
    kind: "hook", outcome: { kind: "rewrite", input: { tool: "Read" } },
  })],
];

for (const [label, answer] of MALFORMED) {
  await check(label + " denies malformed_reply", async () => {
    const { result, calls } = await guard(answer);

    assert.deepEqual(calls, []);
    assert.deepEqual(result, { deny: "tack: malformed_reply" });
  });
}

await check("the last stdout line is the reply", async () => {
  const { result } = await guard((request) => ({
    ...reply(request, { kind: "hook", outcome: { kind: "deny", reason: "push blocked" } }),
    stdout: "starting daemon\n" +
      JSON.stringify({ id: request.id, version: 1, kind: "hook",
        outcome: { kind: "deny", reason: "push blocked" } }) + "\n\n",
  }));

  assert.deepEqual(result, { deny: "tack: push blocked" });
});

const NAMED = [
  ["a crash with no reply", raw("", 1), "daemon_error"],
  ["an allow from a failed run", (request) => ({
    ...reply(request, { kind: "hook", outcome: { kind: "allow" } }),
    exitCode: 2,
  }), "daemon_error"],
  ["another protocol version", (request) => ({
    ...reply(request, { kind: "hook", outcome: { kind: "allow" } }),
    stdout: JSON.stringify({ id: request.id, version: 2, kind: "hook",
      outcome: { kind: "allow" } }) + "\n",
  }), "protocol_version"],
  ["a run that cannot start", () => {
    throw new Error("spawn tack-hook ENOENT");
  }, "daemon_error"],
];

for (const [label, answer, reason] of NAMED) {
  await check(label + " denies " + reason, async () => {
    const { result, calls } = await guard(answer);

    assert.deepEqual(calls, []);
    assert.deepEqual(result, { deny: "tack: " + reason });
  });
}

await check("a run past the budget denies timeout", async () => {
  const realNow = Date.now;
  let clock = 1_000;
  Date.now = () => clock;

  try {
    const { result, calls } = await guard(() => {
      clock += 9000;
      throw new Error("tack-hook timed out");
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(result, { deny: "tack: timeout" });
  } finally {
    Date.now = realNow;
  }
});

const ERRORS = [
  ["socket_missing", "socket_missing"],
  ["timeout", "timeout"],
  ["socket_closed", "socket_closed"],
  ["malformed_reply", "malformed_reply"],
  ["daemon_error", "daemon_error"],
  ["aborted", "aborted"],
  ["protocol_version", "protocol_version"],
  ["limit", "limit"],
  ["script", "script"],
  ["unknown_tool", "unknown_tool"],
  ["unsupported_hook", "unsupported_hook"],
  ["malformed", "daemon_error"],
  ["too_large", "daemon_error"],
  ["something_new", "daemon_error"],
];

for (const [error, reason] of ERRORS) {
  await check("an error reply " + error + " denies " + reason, async () => {
    const { result, calls } = await guard((request) => ({
      ...reply(request, { kind: "error", error, message: "from tack-hook" }),
      exitCode: 1,
    }));

    assert.deepEqual(calls, []);
    assert.deepEqual(result, { deny: "tack: " + reason });
  });
}

await check("the catch refuses a failed guard unless next ran", async () => {
  const registrations = await load();
  const { handler } = find(registrations, "tool.call", "Bash");
  const spy = nextSpy({ result: "replayed" });

  const thrown = Object.assign(spy.next, {
    called: false, error: { kind: "throw", message: "boom", budget: 1000 },
  });
  assert.deepEqual(await handler({}, BASH, thrown), { deny: "tack: daemon_error" });

  const slow = Object.assign(nextSpy().next, {
    called: false, error: { kind: "timeout", budget: 1000 },
  });
  assert.deepEqual(await handler({}, BASH, slow), { deny: "tack: timeout" });

  const after = Object.assign(spy.next, {
    called: true, error: { kind: "throw", budget: 1000 },
  });
  assert.deepEqual(await handler({}, BASH, after), { result: "replayed" });
});

await check("session.start registers each tool after the session binds", async () => {
  const registrations = await load();
  const start = find(registrations, "session.start");
  const fake = fakeHost(() => assert.fail("no tack-hook run at start"));
  const order = [];
  fake.host.tool.register = async (spec) => {
    order.push(["register", spec]);
    return { tool: "mcp__tack__" + spec.name };
  };
  const next = async (e) => {
    order.push(["next", e]);
    return { cwd: e.cwd };
  };

  const event = { cwd: "/work", surface: null, isInteractive: false };
  const result = await start.hook(fake.host, event, next);

  assert.deepEqual(result, { cwd: "/work" });
  assert.deepEqual(order, [
    ["next", event],
    ["register", {
      name: "guard_status",
      description: "Reports whether the tack daemon is running",
      inputSchema: { type: "object" },
      isDeferred: false,
    }],
  ]);
});

await check("the timer globals run on $.clock", async () => {
  const registrations = await load();
  const start = find(registrations, "session.start");
  const fake = fakeHost(() => assert.fail("no tack-hook run at start"));
  await start.hook(fake.host, { cwd: "/work" }, async () => ({ cwd: "/work" }));

  const seen = [];
  const timer = setTimeout((a, b) => seen.push([a, b]), 25, "x", "y");
  const interval = setInterval(() => seen.push("tick"), 0);
  queueMicrotask(() => seen.push("micro"));
  clearTimeout(timer);
  clearInterval(interval);

  assert.deepEqual(
    fake.timers.map((t) => [t.kind, t.ms, t.cancelled]),
    [["after", 25, true], ["every", 1, true], ["after", 0, false]],
  );
  fake.timers[0].fn();
  fake.timers[2].fn();
  assert.deepEqual(seen, [["x", "y"], "micro"]);
});

await check("a tool call runs guard_status through tack-hook", async () => {
  const registrations = await load();
  const tool = find(registrations, "tool.call", "mcp__tack__guard_status");
  const fake = fakeHost((request) => reply(request, {
    kind: "tool", content: [{ kind: "text", text: "guard_status: daemon ok" }],
  }));
  const spy = nextSpy();

  const event = { tool: "mcp__tack__guard_status", tool_use_id: "toolu_2" };
  const result = await tool.hook(fake.host, event, spy.next);

  assert.deepEqual(result, { result: "guard_status: daemon ok" });
  assert.deepEqual(spy.calls, []);
  assert.deepEqual(fake.runs[0].argv, HOOK_ARGV);
  assert.deepEqual(fake.runs[0].request, {
    kind: "tool", id: 1, version: 1, name: "guard_status", input: {},
  });
});

const TOOL_FAILURES = [
  ["malformed stdout", raw("nope\n"), "malformed_reply"],
  ["content without text", (request) => reply(request, {
    kind: "tool", content: [{ kind: "text" }],
  }), "malformed_reply"],
  ["a hook reply to a tool", (request) => reply(request, {
    kind: "hook", outcome: { kind: "allow" },
  }), "malformed_reply"],
  ["an unknown_tool error", (request) => ({
    ...reply(request, { kind: "error", error: "unknown_tool", message: "x" }),
    exitCode: 1,
  }), "unknown_tool"],
];

for (const [label, answer, reason] of TOOL_FAILURES) {
  await check("a tool call with " + label + " answers " + reason, async () => {
    const registrations = await load();
    const tool = find(registrations, "tool.call", "mcp__tack__guard_status");
    const fake = fakeHost(answer);

    const result = await tool.hook(fake.host, { tool: "mcp__tack__guard_status" },
      nextSpy().next);

    assert.deepEqual(result, { deny: "tack: " + reason });
  });
}

if (failures > 0) {
  console.error(failures + " failed");
  process.exitCode = 1;
} else {
  console.log("all passed");
}
