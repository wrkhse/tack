// Fail-closed and cold-start checks for the generated OpenCode wrapper.
// Runs in CI or a disposable container only, never against a real daemon.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const CALL_TIMEOUT_MS = 150;
const START_TIMEOUT_MS = 300;
const HARD_TIMEOUT_MS = 10_000;

const ENV_KEYS = [
  "TACK_STATE_DIR",
  "TACK_SOCKET",
  "TACK_DAEMON_BIN",
  "TACK_NO_START",
  "TACK_CALL_TIMEOUT_MS",
  "TACK_START_TIMEOUT_MS",
  "XDG_STATE_HOME",
  "HOME",
  "TACK_STUB_MARKER",
  "TACK_STUB_DELAY_MS",
  "TACK_STUB_SCRIPT",
];

const CALL = {
  tool: "shell",
  name: "shell",
  input: { command: "git push origin main" },
  sessionID: "session-1",
  session_id: "session-1",
};

const ALLOW_CALL = { ...CALL, input: { command: "echo hello" } };

const ERROR_REASONS = [
  ["protocol_version", "protocol_version"],
  ["limit", "limit"],
  ["script", "script"],
  ["unknown_tool", "unknown_tool"],
  ["malformed", "daemon_error"],
  ["too_large", "daemon_error"],
  ["unsupported_hook", "daemon_error"],
];

let failures = 0;
let buildDir;

function buildWrapper() {
  buildDir = mkdtempSync(path.join(tmpdir(), "tack-wrapper-build-"));
  execFileSync(
    "cargo",
    [
      "run", "--locked", "-p", "tack-cli", "--",
      "build", path.join(repoRoot, "fixtures/safe-push"),
      "--out", buildDir,
      "--call-timeout-ms", String(CALL_TIMEOUT_MS),
      "--start-timeout-ms", String(START_TIMEOUT_MS),
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  return path.join(buildDir, "opencode", "index.js");
}

const wrapperPath = process.env.TACK_WRAPPER || buildWrapper();

function hardTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("hard timeout: " + label)), ms);
  });

  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function check(name, fn) {
  try {
    await hardTimeout(fn(), HARD_TIMEOUT_MS, name);
    console.log("PASS " + name);
  } catch (error) {
    failures += 1;
    const text = error && error.stack ? error.stack : String(error);
    console.error("FAIL " + name + ": " + text);
  }
}

function applyEnv(env) {
  for (const key of ENV_KEYS) {
    if (key in env) process.env[key] = env[key];
    else delete process.env[key];
  }
}

// The real OpenCode 2.3 API registers hooks and tools as objects with
// dispose(), and tool results are { content: [{ type, text }] }. Pin that
// shape here: a wrapper that drifts from it fails during setup or execution.
function fakeContext() {
  const hooks = new Map();
  const transforms = new Map();
  const registrations = [];
  const added = [];

  const register = () => {
    const registration = {
      disposed: false,
      async dispose() {
        this.disposed = true;
      },
    };
    registrations.push(registration);
    return registration;
  };

  const ctx = {
    tool: {
      hook(name, callback) {
        assert.equal(name, "execute.before", "hook name must be execute.before");
        assert.equal(
          typeof callback, "function", "hook callback must be a function",
        );
        hooks.set(name, callback);
        return register();
      },
      transform(callback) {
        assert.equal(
          typeof callback, "function", "transform callback must be a function",
        );
        const editor = {
          add(definition) {
            assert.equal(
              typeof definition.name, "string", "tool name must be a string",
            );
            assert.equal(
              typeof definition.execute, "function", "tool needs execute()",
            );
            added.push(definition);
            return definition;
          },
        };
        callback(editor);
        transforms.set(String(transforms.size), callback);
        return register();
      },
    },
  };

  return { ctx, hooks, transforms, registrations, added };
}

function pickBefore(hooks, transforms) {
  const all = [...hooks, ...transforms];
  const before = all.find(([name]) => /before/i.test(name));

  assert.ok(before, "the wrapper registered no execute.before handler");
  assert.equal(
    typeof before[1], "function", "the before callback is not a function",
  );

  return before[1];
}

async function loadPlugin(env, modulePath = wrapperPath) {
  applyEnv(env);

  for (const key of Object.keys(require.cache)) delete require.cache[key];

  const plugin = require(modulePath);
  assert.equal(
    typeof plugin.setup, "function", "the wrapper does not export setup()",
  );

  const fake = fakeContext();
  const cleanup = await plugin.setup(fake.ctx);
  assert.equal(typeof cleanup, "function", "setup must return a cleanup function");
  assert.equal(fake.hooks.size, 1, "one execute.before hook must be registered");
  assert.equal(fake.transforms.size, 1, "one tool transform must be registered");

  return { before: pickBefore(fake.hooks, fake.transforms), cleanup, ...fake };
}

async function loadBefore(env, modulePath = wrapperPath) {
  return (await loadPlugin(env, modulePath)).before;
}

function baseEnv(dir, overrides = {}) {
  return {
    TACK_STATE_DIR: dir,
    TACK_SOCKET: path.join(dir, "tack.sock"),
    TACK_DAEMON_BIN: path.join(dir, "no-daemon"),
    TACK_NO_START: "1",
    ...overrides,
  };
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "tack-wrapper-"));
}

async function listen(socketPath, onConnection) {
  const sockets = new Set();
  const server = net.createServer((conn) => {
    sockets.add(conn);
    conn.on("close", () => sockets.delete(conn));
    conn.on("error", () => {});
    onConnection(conn);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  server.on("error", () => {});

  return {
    close: () =>
      new Promise((resolve) => {
        for (const conn of sockets) conn.destroy();
        server.close(() => {
          rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}

async function expectDeny(before, reason) {
  let thrown;

  try {
    await before(CALL);
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error, "the call resolved instead of failing closed");
  assert.equal(thrown.message, "tack: " + reason, "wrong fail-closed reason");
}

function reply(kind, extra = {}) {
  return JSON.stringify({ kind, id: 1, version: 1, ...extra });
}

async function denyFromReply(replyText, reason) {
  const dir = tempDir();
  let server;

  try {
    const env = baseEnv(dir);
    const before = await loadBefore(env);
    server = await listen(env.TACK_SOCKET, (conn) => {
      let buffer = "";
      conn.setEncoding("utf8");
      conn.on("error", () => {});
      conn.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.indexOf("\n") < 0) return;
        conn.write(replyText + "\n");
      });
    });
    await expectDeny(before, reason);
  } finally {
    if (server) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runOutcome(outcome, event) {
  const dir = tempDir();
  let server;

  try {
    const env = baseEnv(dir);
    const before = await loadBefore(env);
    server = await listen(env.TACK_SOCKET, (conn) => {
      let buffer = "";
      conn.setEncoding("utf8");
      conn.on("error", () => {});
      conn.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.indexOf("\n") < 0) return;
        conn.write(reply("hook", { outcome }) + "\n");
      });
    });

    let error;
    try {
      await before(event);
    } catch (thrown) {
      error = thrown;
    }
    return error;
  } finally {
    if (server) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// The stub daemon is a test double: it parses the --socket and --plugin args
// the wrapper passes, records its pid, then answers each NDJSON line.
const STUB_DAEMON = [
  "#!/usr/bin/env node",
  "'use strict';",
  "const net = require('node:net');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const args = process.argv.slice(2);",
  "const socket = args[args.indexOf('--socket') + 1];",
  "const plugin = args[args.indexOf('--plugin') + 1];",
  "const marker = process.env.TACK_STUB_MARKER;",
  "if (marker) fs.appendFileSync(marker, JSON.stringify({",
  "  pid: process.pid, socket, plugin }) + '\\n');",
  "const state = process.env.TACK_STATE_DIR ||",
  "  (process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, 'tack') :",
  "    path.join(process.env.HOME, '.local', 'state', 'tack'));",
  "const lock = path.join(state, 'tack.lock');",
  "function acquire() {",
  "  for (let i = 0; i < 20; i++) {",
  "    try {",
  "      const fd = fs.openSync(lock, 'wx');",
  "      fs.writeFileSync(fd, String(process.pid));",
  "      fs.closeSync(fd);",
  "      return true;",
  "    } catch (err) {",
  "      if (err.code !== 'EEXIST') return false;",
  "      let owner = 0;",
  "      try { owner = Number(fs.readFileSync(lock, 'utf8')); } catch {}",
  "      if (!owner) { fs.rmSync(lock, { force: true }); continue; }",
  "      try { process.kill(owner, 0); return false; } catch {}",
  "      fs.rmSync(lock, { force: true });",
  "    }",
  "  }",
  "  return false;",
  "}",
  "if (!acquire()) process.exit(3);",
  "fs.rmSync(socket, { force: true });",
  "const delay = Number(process.env.TACK_STUB_DELAY_MS || 0);",
  "function serve() {",
  "  const server = net.createServer((conn) => {",
  "    let buffer = '';",
  "    conn.setEncoding('utf8');",
  "    conn.on('error', () => {});",
  "    conn.on('data', (chunk) => {",
  "      buffer += chunk;",
  "      const lines = buffer.split('\\n');",
  "      buffer = lines.pop();",
  "      for (const line of lines) {",
  "        if (!line.trim()) continue;",
  "        let request;",
  "        try { request = JSON.parse(line); } catch { continue; }",
  "        const script = process.env.TACK_STUB_SCRIPT || 'allow';",
  "        let reply;",
  "        if (script === 'version') reply = {",
  "          kind: 'hook', id: request.id, version: 999,",
  "          outcome: { kind: 'allow' },",
  "        };",
  "        else if (script === 'unknown-outcome') reply = {",
  "          kind: 'hook', id: request.id, version: request.version,",
  "          outcome: { kind: 'surprise' },",
  "        };",
  "        else if (script.startsWith('error:')) reply = {",
  "          kind: 'error', id: request.id, version: request.version,",
  "          error: script.slice(6), message: 'from daemon',",
  "        };",
  "        else if (request.kind === 'tool') reply = {",
  "          kind: 'tool', id: request.id, version: request.version,",
  "          content: [{ kind: 'text', text: 'guard_status: daemon ok' }],",
  "        };",
  "        else reply = {",
  "          kind: 'hook', id: request.id, version: request.version,",
  "          outcome: { kind: 'allow' },",
  "        };",
  "        conn.write(JSON.stringify(reply) + '\\n');",
  "      }",
  "    });",
  "  });",
  "  server.listen(socket);",
  "}",
  "setTimeout(serve, delay);",
  "",
].join("\n");

// This helper binds a socket then exits, leaving a stale socket file behind.
const STALE_SOCKET = [
  "const net = require('node:net');",
  "const fs = require('node:fs');",
  "const socket = process.argv[2];",
  "fs.rmSync(socket, { force: true });",
  "const server = net.createServer(() => {});",
  "server.listen(socket, () => process.exit(0));",
  "",
].join("\n");

function writeScript(dir, name, source) {
  const script = path.join(dir, name);
  writeFileSync(script, source, { mode: 0o755 });
  return script;
}

async function stopDaemons(marker) {
  if (!existsSync(marker)) return;
  const lines = readFileSync(marker, "utf8").trim().split("\n");

  for (const line of lines) {
    if (!line) continue;
    try {
      process.kill(JSON.parse(line).pid);
    } catch {
      // The daemon may already have exited.
    }
  }
}

async function coldStart(env, marker, dir) {
  const stub = writeScript(dir, "stub-daemon.js", STUB_DAEMON);
  const full = { ...env, TACK_DAEMON_BIN: stub, TACK_STUB_MARKER: marker };
  delete full.TACK_NO_START;

  const before = await loadBefore(full);
  await before(ALLOW_CALL);

  assert.ok(existsSync(marker), "the first call did not start the daemon");
  return JSON.parse(readFileSync(marker, "utf8").trim().split("\n")[0]);
}

async function missingSocket() {
  const dir = tempDir();
  try {
    const before = await loadBefore(baseEnv(dir));
    assert.equal(existsSync(path.join(dir, "tack.sock")), false);
    await expectDeny(before, "socket_missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function timeout() {
  const dir = tempDir();
  let server;
  try {
    const env = baseEnv(dir);
    const before = await loadBefore(env);
    server = await listen(env.TACK_SOCKET, () => {});
    await expectDeny(before, "timeout");
  } finally {
    if (server) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function closedSocket() {
  const dir = tempDir();
  let server;
  try {
    const env = baseEnv(dir);
    const before = await loadBefore(env);
    server = await listen(env.TACK_SOCKET, (conn) => conn.end());
    await expectDeny(before, "socket_closed");
  } finally {
    if (server) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function malformedReply() {
  await denyFromReply("not json", "malformed_reply");
}

async function versionMismatch() {
  const text = reply("hook", { version: 999, outcome: { kind: "allow" } });
  await denyFromReply(text, "protocol_version");
}

async function typedVersionError() {
  const dir = tempDir();
  const marker = path.join(dir, "daemons.log");

  try {
    const env = baseEnv(dir, { TACK_STUB_SCRIPT: "error:protocol_version" });
    const before = await coldBefore(env, marker, dir);
    await expectDeny(before, "protocol_version");
  } finally {
    await stopDaemons(marker);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function oversizeWithNewline() {
  await denyFromReply("x".repeat(1024 * 1024 + 8), "malformed_reply");
}

async function unknownOutcome() {
  const text = reply("hook", { outcome: { kind: "surprise" } });
  await denyFromReply(text, "malformed_reply");
}

async function rewriteReplacesInputForAnyTool() {
  const event = { tool: "shell", input: { command: "git push origin main" } };
  const rewritten = { command: "git push --dry-run", extra: true };
  const error = await runOutcome({ kind: "rewrite", input: rewritten }, event);
  assert.equal(error, undefined, "a rewrite must pass for any tool");
  assert.deepEqual(event.input, rewritten, "rewrite replaces the whole input");
}

async function rewriteWorksForNonShellTool() {
  const event = { tool: "guard_status", input: { old: true } };
  const error = await runOutcome(
    { kind: "rewrite", input: { verbose: true } },
    event,
  );
  assert.equal(error, undefined, "a non-shell rewrite must pass");
  assert.deepEqual(event.input, { verbose: true });
}

async function rewriteRejectsNonObjects() {
  for (const input of [null, [], "command", 42]) {
    const text = reply("hook", { outcome: { kind: "rewrite", input } });
    await denyFromReply(text, "malformed_reply");
  }
}

async function allowPasses() {
  const event = { tool: "shell", input: { command: "echo hello" } };
  const error = await runOutcome({ kind: "allow" }, event);
  assert.equal(error, undefined, "allow must pass through");
}

async function denyBlocks() {
  const error = await runOutcome({ kind: "deny", reason: "push blocked" }, CALL);
  assert.ok(error instanceof Error, "deny must block the call");
  assert.equal(error.message, "tack: push blocked");
}

async function rewriteMutates() {
  const event = { tool: "shell", input: { command: "git push origin main" } };
  const error = await runOutcome(
    { kind: "rewrite", input: { command: "git push --dry-run" } },
    event,
  );
  assert.equal(error, undefined, "a rewrite with a command must pass through");
  assert.equal(event.input.command, "git push --dry-run");
}

// OpenCode registers hooks and tools asynchronously. A tool call cannot be
// delivered until setup() resolves, so setup() must wait for every
// registration; cleanup must dispose the resolved objects, not their promises.
async function setupAwaitsAsyncRegistrations() {
  const dir = tempDir();

  try {
    applyEnv(baseEnv(dir));
    for (const key of Object.keys(require.cache)) delete require.cache[key];
    const plugin = require(wrapperPath);

    let resolveHook;
    const hookPromise = new Promise((resolve) => {
      resolveHook = resolve;
    });
    let beforeRegistered = false;
    let beforeCallback;
    let toolDefinition;
    let hookDisposed = false;
    let transformDisposed = false;

    const hookRegistration = {
      async dispose() {
        hookDisposed = true;
      },
    };
    const transformRegistration = {
      async dispose() {
        transformDisposed = true;
      },
    };

    let settled = false;
    const ctx = {
      tool: {
        hook(name, callback) {
          assert.equal(name, "execute.before");
          beforeCallback = callback;
          // The registration becomes active only when this promise resolves.
          return hookPromise.then((registration) => {
            beforeRegistered = true;
            return registration;
          });
        },
        transform(callback) {
          assert.equal(typeof callback, "function");
          callback({
            add(definition) {
              toolDefinition = definition;
            },
          });
          return Promise.resolve(transformRegistration);
        },
      },
    };

    const cleanupPromise = plugin.setup(ctx);
    cleanupPromise.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false, "setup resolved before the registrations");
    assert.equal(beforeRegistered, false, "the hook activated too early");

    // OpenCode cannot deliver a tool call until setup() resolves. A call
    // attempted now cannot reach a daemon unguarded: it fails closed, and
    // no execute.before hook is active yet.
    assert.ok(toolDefinition, "the tool must be defined");
    let earlyError;
    try {
      await toolDefinition.execute({ command: "echo hello" });
    } catch (thrown) {
      earlyError = thrown;
    }
    assert.ok(earlyError instanceof Error, "an early tool call must fail closed");
    assert.equal(
      earlyError.message,
      "tack: socket_missing",
      "an early tool call cannot reach a daemon",
    );
    assert.equal(beforeRegistered, false, "no call ran before the hook was active");

    resolveHook(hookRegistration);
    const cleanup = await cleanupPromise;

    // setup() resolves only after the late hook registration, so no call can
    // be delivered before execute.before is active.
    assert.equal(beforeRegistered, true, "hook must be active before setup resolves");
    assert.equal(typeof beforeCallback, "function");

    await cleanup();
    assert.equal(hookDisposed, true, "cleanup disposes the resolved hook");
    assert.equal(transformDisposed, true, "cleanup disposes the resolved transform");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// An AbortController must cancel the in-flight daemon request and settle the
// tool call with the named "aborted" reason instead of waiting for the timeout.
async function toolExecuteHonorsAbortSignal() {
  const dir = tempDir();
  let server;

  try {
    const env = baseEnv(dir);
    const loaded = await loadPlugin(env);
    const tool = loaded.added[0];

    // Accept the connection but never reply: only the abort settles this call.
    server = await listen(env.TACK_SOCKET, () => {});

    const controller = new AbortController();
    const pending = tool.execute({ verbose: true }, {
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    let error;
    try {
      await pending;
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error instanceof Error, "an aborted execute must reject");
    assert.equal(error.message, "tack: aborted", "abort must deny by name");

    // A signal already aborted at call time denies before any connect.
    const pre = new AbortController();
    pre.abort();
    let preError;
    try {
      await tool.execute({ verbose: true }, { signal: pre.signal });
    } catch (thrown) {
      preError = thrown;
    }
    assert.ok(preError instanceof Error, "a pre-aborted execute must reject");
    assert.equal(preError.message, "tack: aborted");
  } finally {
    if (server) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function toolForwarding() {
  const dir = tempDir();
  const marker = path.join(dir, "daemons.log");
  let server;

  try {
    const env = baseEnv(dir);
    const loaded = await loadPlugin(env);
    let request;

    server = await listen(env.TACK_SOCKET, (conn) => {
      let buffer = "";
      conn.setEncoding("utf8");
      conn.on("error", () => {});
      conn.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        request = JSON.parse(buffer.slice(0, newline));
        conn.write(reply("tool", {
          content: [{ kind: "text", text: "guard_status: daemon ok" }],
        }) + "\n");
      });
    });

    assert.equal(loaded.added.length, 1, "one tool must be registered");
    const tool = loaded.added[0];
    const result = await tool.execute({ verbose: true });

    assert.deepEqual(result, {
      content: [{ type: "text", text: "guard_status: daemon ok" }],
    });
    assert.equal(request.kind, "tool");
    assert.equal(request.name, "guard_status");
    assert.deepEqual(request.input, { verbose: true });

    await loaded.cleanup();
    assert.ok(
      loaded.registrations.every((registration) => registration.disposed),
      "cleanup must dispose every registration",
    );
  } finally {
    if (server) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function stateDirRule(envFor, expectedDir) {
  const dir = tempDir();
  const marker = path.join(dir, "daemons.log");

  try {
    const env = envFor(dir, marker);
    const started = await coldStart(env, marker, dir);
    const state = expectedDir(dir);

    assert.equal(started.socket, path.join(state, "tack.sock"));
    assert.ok(
      existsSync(path.join(state, "daemon.log")),
      "log is in the state folder",
    );
  } finally {
    await stopDaemons(marker);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function coldStartSuccess() {
  const dir = tempDir();
  const marker = path.join(dir, "daemons.log");

  try {
    const started = await coldStart(baseEnv(dir), marker, dir);
    assert.equal(started.socket, path.join(dir, "tack.sock"));
    assert.ok(path.isAbsolute(started.plugin), "plugin dir must be absolute");
    assert.ok(
      started.plugin.endsWith("fixtures/safe-push"),
      "plugin dir is the fixture",
    );
  } finally {
    await stopDaemons(marker);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function slowStartFailsWithSocketMissing() {
  const dir = tempDir();
  const marker = path.join(dir, "daemons.log");

  try {
    const env = baseEnv(dir, { TACK_STUB_DELAY_MS: "900" });
    const before = await coldBefore(env, marker, dir);
    // Call timeout is 150 ms and start timeout is 300 ms: a paused call timer
    // denies socket_missing, while an unpaused one would deny timeout.
    await expectDeny(before, "socket_missing");
  } finally {
    await stopDaemons(marker);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function coldBefore(env, marker, dir, modulePath = wrapperPath) {
  const stub = writeScript(dir, "stub-daemon.js", STUB_DAEMON);
  const full = { ...env, TACK_DAEMON_BIN: stub, TACK_STUB_MARKER: marker };
  delete full.TACK_NO_START;
  return loadBefore(full, modulePath);
}

async function restartAfterDaemonDeath() {
  const dir = tempDir();
  const marker = path.join(dir, "daemons.log");

  try {
    const before = await coldBefore(baseEnv(dir), marker, dir);
    await before(ALLOW_CALL);

    let lines = readFileSync(marker, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "one daemon started");
    const firstPid = JSON.parse(lines[0]).pid;

    process.kill(firstPid);
    await new Promise((resolve) => setTimeout(resolve, 80));
    rmSync(path.join(dir, "tack.sock"), { force: true });

    await before(ALLOW_CALL);
    lines = readFileSync(marker, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "a second daemon started after the first died");
    assert.notEqual(JSON.parse(lines[1]).pid, firstPid, "the daemon was restarted");
  } finally {
    await stopDaemons(marker);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function staleSocketRestarts() {
  const dir = tempDir();
  const marker = path.join(dir, "daemons.log");
  const socket = path.join(dir, "tack.sock");

  try {
    const stale = writeScript(dir, "stale.js", STALE_SOCKET);
    execFileSync(process.execPath, [stale, socket], { stdio: "ignore" });
    // A refused path, whether a socket file or a placeholder, is stale.
    if (!existsSync(socket)) writeFileSync(socket, "stale");
    assert.ok(existsSync(socket), "stale socket was not created");

    const before = await coldBefore(baseEnv(dir), marker, dir);
    await before(ALLOW_CALL);

    assert.ok(existsSync(marker), "a refused socket did not trigger a start");
    const started = JSON.parse(readFileSync(marker, "utf8").trim().split("\n")[0]);
    assert.equal(started.socket, socket);
  } finally {
    await stopDaemons(marker);
    rmSync(dir, { recursive: true, force: true });
  }
}

// A second module instance needs to start without a socket failure, so the
// test loads a copy with one extra export. The shipped wrapper is untouched.
function instrumentedWrapper(dir) {
  const source = readFileSync(wrapperPath, "utf8");
  const target = path.join(dir, "instrumented.js");
  writeFileSync(
    target,
    source + "\nmodule.exports.__startDaemon = startDaemon;\n",
  );
  return target;
}

// A daemon that exits without binding: a start that cannot claim a fresh
// socket, so forward must prove reachability with a real connect.
const EXITING_DAEMON = [
  "#!/usr/bin/env node",
  "process.exit(0);",
  "",
].join("\n");

// An instrumented copy whose socket stat and connect calls the test can
// drive. The shipped wrapper is untouched.
function raceWrapper(dir, name) {
  const source = readFileSync(wrapperPath, "utf8")
    .replace(
      'const net = require("node:net");',
      'const net = globalThis.__tackNet || require("node:net");',
    )
    .replace(
      'const fs = require("node:fs");',
      'const fs = globalThis.__tackFs || require("node:fs");',
    );
  const target = path.join(dir, name);
  writeFileSync(target, source);
  return target;
}

// Every stat of the socket reports one identity, so an unlink/rebind with
// the same dev, inode and mtime is indistinguishable from the stale file.
function fixedIdentityFs() {
  const real = require("node:fs");
  return {
    ...real,
    statSync(p) {
      const info = real.statSync(p);
      if (p === process.env.TACK_SOCKET) {
        return { dev: 7, ino: 11, mtimeMs: 5 };
      }
      return info;
    },
  };
}

// The first connect gets ENOENT even though a daemon is listening: a
// competing daemon bound the socket after that connect began.
function forcedEnoentNet() {
  const real = require("node:net");
  let forced = false;
  return {
    ...real,
    connect(...args) {
      if (forced) return real.connect(...args);
      forced = true;
      const sock = new real.Socket();
      setImmediate(() => {
        const error = new Error("connect ENOENT");
        error.code = "ENOENT";
        sock.emit("error", error);
        sock.destroy();
      });
      return sock;
    },
  };
}

async function secondColdStartKeepsLiveDaemon() {
  const dir = tempDir();
  const marker = path.join(dir, "daemons.log");
  const socket = path.join(dir, "tack.sock");
  const env = baseEnv(dir);

  try {
    const beforeA = await coldBefore(env, marker, dir);
    await beforeA(ALLOW_CALL);
    assert.ok(existsSync(socket), "the first daemon owns the socket");

    const instrumented = instrumentedWrapper(dir);
    const secondEnv = baseEnv(dir, {
      TACK_DAEMON_BIN: path.join(dir, "stub-daemon.js"),
      TACK_STUB_MARKER: marker,
    });
    delete secondEnv.TACK_NO_START;
    applyEnv(secondEnv);
    for (const key of Object.keys(require.cache)) delete require.cache[key];
    const second = require(instrumented);
    // The second daemon loses the lock, so its socket never replaces the
    // live one. startDaemon settles without a readiness value; the connects
    // below prove the first daemon is still reachable.
    await second.__startDaemon();

    const lines = readFileSync(marker, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "the second daemon also tried to start");
    assert.ok(existsSync(socket), "the live socket was not unlinked");

    applyEnv(env);
    await beforeA(ALLOW_CALL);
    const beforeFresh = await loadBefore(env);
    await beforeFresh(ALLOW_CALL);
  } finally {
    await stopDaemons(marker);
    rmSync(dir, { recursive: true, force: true });
  }
}

// A competing daemon binds between the first ENOENT and the stat check.
// The start cannot see a fresh bind, but one real connect must reach the
// live daemon instead of denying socket_missing.
async function competingBindBeforeStatUsesLiveSocket() {
  const dir = tempDir();
  let server;

  try {
    const exiting = writeScript(dir, "exiting-daemon.js", EXITING_DAEMON);
    const env = baseEnv(dir, { TACK_DAEMON_BIN: exiting });
    delete env.TACK_NO_START;
    delete globalThis.__tackFs;

    globalThis.__tackNet = forcedEnoentNet();
    const target = raceWrapper(dir, "competing-bind.js");
    const before = await loadBefore(env, target);

    server = await listen(env.TACK_SOCKET, (conn) => {
      let buffer = "";
      conn.setEncoding("utf8");
      conn.on("error", () => {});
      conn.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.indexOf("\n") < 0) return;
        conn.write(reply("hook", { outcome: { kind: "allow" } }) + "\n");
      });
    });

    let error;
    try {
      await before(ALLOW_CALL);
    } catch (thrown) {
      error = thrown;
    }
    assert.equal(
      error, undefined, "the live socket must be used, not a named deny",
    );
  } finally {
    delete globalThis.__tackNet;
    if (server) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// A stale socket is replaced by a fresh listener with the same dev, inode
// and mtime. The start cannot see an identity change, but the one connect
// after it resolves succeeds. With no daemon at all the call fails closed.
async function rebindWithMatchingIdentity() {
  const dir = tempDir();
  const marker = path.join(dir, "daemons.log");
  const socket = path.join(dir, "tack.sock");

  try {
    const stale = writeScript(dir, "stale.js", STALE_SOCKET);
    execFileSync(process.execPath, [stale, socket], { stdio: "ignore" });
    assert.ok(existsSync(socket), "stale socket was not created");

    globalThis.__tackFs = fixedIdentityFs();
    const target = raceWrapper(dir, "matching-identity.js");
    const env = baseEnv(dir, { TACK_STUB_DELAY_MS: "20" });
    const before = await coldBefore(env, marker, dir, target);

    await before(ALLOW_CALL);

    assert.ok(existsSync(marker), "a refused socket did not trigger a start");
  } finally {
    delete globalThis.__tackFs;
    await stopDaemons(marker);
    rmSync(dir, { recursive: true, force: true });
  }
}

// The matching-identity case with no daemon: a stale socket file whose
// identity never changes, and a daemon that exits without binding. Readiness
// cannot see a fresh bind, so the one real connect finds no listener and the
// ECONNREFUSED fails closed as the pinned "socket_closed" name.
async function rebindWithNoDaemonFailsClosed() {
  const dir = tempDir();
  const socket = path.join(dir, "tack.sock");

  try {
    const stale = writeScript(dir, "stale.js", STALE_SOCKET);
    execFileSync(process.execPath, [stale, socket], { stdio: "ignore" });
    assert.ok(existsSync(socket), "stale socket was not created");

    globalThis.__tackFs = fixedIdentityFs();
    const exiting = writeScript(dir, "exiting-daemon.js", EXITING_DAEMON);
    const env = baseEnv(dir, { TACK_DAEMON_BIN: exiting });
    delete env.TACK_NO_START;
    const target = raceWrapper(dir, "matching-identity-closed.js");
    const before = await loadBefore(env, target);

    await expectDeny(before, "socket_closed");
    assert.ok(existsSync(socket), "no daemon replaced the stale socket");
  } finally {
    delete globalThis.__tackFs;
    rmSync(dir, { recursive: true, force: true });
  }
}

// A leftover socket file that refuses connections is the named
// "socket_closed" reason: the path exists but nothing accepts connections.
// ENOENT (no path at all) keeps the distinct "socket_missing" name pinned by
// the "socket_missing fails closed" check. The two names are not interchangeable.
async function staleSocketFileDeniesSocketClosed() {
  const dir = tempDir();
  const socket = path.join(dir, "tack.sock");

  try {
    const stale = writeScript(dir, "stale.js", STALE_SOCKET);
    execFileSync(process.execPath, [stale, socket], { stdio: "ignore" });
    assert.ok(existsSync(socket), "stale socket was not created");

    // TACK_NO_START=1 keeps ECONNREFUSED from triggering a daemon start.
    const before = await loadBefore(baseEnv(dir));
    await expectDeny(before, "socket_closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A wrapper with two tools: the rollback proof needs one transform to fail
// while the other resolves.
function twoToolWrapper(dir) {
  const source = readFileSync(wrapperPath, "utf8");
  const target = path.join(dir, "two-tools.js");
  const manifest =
    '{"name":"safe-push","needs":[],"tools":[' +
    '{"name":"guard_status","description":"status","input":{}},' +
    '{"name":"other_tool","description":"other","input":{}}' +
    "]}";
  writeFileSync(
    target,
    source.replace(/^const MANIFEST = .*;$/m, "const MANIFEST = " + manifest + ";"),
  );
  return target;
}

// A failed registration must not leak the ones that did resolve: setup()
// disposes every fulfilled registration and rethrows the first rejection.
async function setupRollsBackOnFailedRegistration() {
  const dir = tempDir();

  try {
    applyEnv(baseEnv(dir));
    for (const key of Object.keys(require.cache)) delete require.cache[key];
    const plugin = require(twoToolWrapper(dir));

    const disposed = [];
    const registration = (tag) => ({
      async dispose() {
        disposed.push(tag);
      },
    });
    let transformCalls = 0;

    const ctx = {
      tool: {
        hook(name, callback) {
          assert.equal(name, "execute.before");
          assert.equal(typeof callback, "function");
          return Promise.resolve(registration("hook"));
        },
        transform(callback) {
          assert.equal(typeof callback, "function");
          transformCalls += 1;
          if (transformCalls === 1) {
            return Promise.reject(new Error("tack: registration failed"));
          }
          return Promise.resolve(registration("transform"));
        },
      },
    };

    let error;
    try {
      await plugin.setup(ctx);
    } catch (thrown) {
      error = thrown;
    }

    assert.ok(error instanceof Error, "setup must reject on a failed registration");
    assert.equal(
      error.message,
      "tack: registration failed",
      "first rejection is rethrown",
    );
    assert.equal(transformCalls, 2, "both transforms were attempted");
    assert.deepEqual(
      disposed,
      ["hook", "transform"],
      "only fulfilled registrations are disposed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The first connect gets ENOENT so a daemon starts; the retry after start
// resolves throws synchronously. The continuation must deny by name instead
// of leaving the call dangling.
function throwingRetryNet() {
  const real = require("node:net");
  let calls = 0;
  return {
    ...real,
    connect(...args) {
      calls += 1;
      if (calls === 1) {
        const sock = new real.Socket();
        setImmediate(() => {
          const error = new Error("connect ENOENT");
          error.code = "ENOENT";
          sock.emit("error", error);
          sock.destroy();
        });
        return sock;
      }
      throw new Error("connect exploded");
    },
  };
}

async function startContinuationThrowDeniesDaemonError() {
  const dir = tempDir();
  const marker = path.join(dir, "daemons.log");

  try {
    delete globalThis.__tackFs;
    globalThis.__tackNet = throwingRetryNet();
    const target = raceWrapper(dir, "throw-continuation.js");
    const before = await coldBefore(baseEnv(dir), marker, dir, target);

    await expectDeny(before, "daemon_error");
  } finally {
    delete globalThis.__tackNet;
    await stopDaemons(marker);
    rmSync(dir, { recursive: true, force: true });
  }
}

await check("socket_missing fails closed", missingSocket);
await check("timeout fails closed", timeout);
await check("socket_closed fails closed", closedSocket);
await check("malformed_reply fails closed", malformedReply);
await check("version mismatch denies protocol_version", versionMismatch);
await check(
  "typed protocol_version reply denies protocol_version",
  typedVersionError,
);
await check("oversize reply with a newline fails closed", oversizeWithNewline);
await check("unknown outcome kind fails closed", unknownOutcome);
await check(
  "rewrite replaces the input for any tool",
  rewriteReplacesInputForAnyTool,
);
await check("rewrite works for a non-shell tool", rewriteWorksForNonShellTool);
await check(
  "rewrite with a non-object input fails closed",
  rewriteRejectsNonObjects,
);
await check("allow passes through", allowPasses);
await check("deny blocks the call", denyBlocks);
await check("rewrite with a string command mutates and passes", rewriteMutates);
await check(
  "tool forwards over the socket with the real result shape",
  toolForwarding,
);
for (const [error, reason] of ERROR_REASONS) {
  await check(
    "reply error " + error + " denies " + reason,
    () => denyFromReply(reply("error", { error, message: "from daemon" }), reason),
  );
}
await check("TACK_STATE_DIR is used as-is", () =>
  stateDirRule((dir, marker) => ({
    TACK_STATE_DIR: path.join(dir, "explicit"),
    TACK_STUB_MARKER: marker,
  }), (dir) => path.join(dir, "explicit")));
await check("XDG_STATE_HOME gains a tack suffix", () =>
  stateDirRule((dir, marker) => ({
    XDG_STATE_HOME: path.join(dir, "xdg"),
    TACK_STUB_MARKER: marker,
  }), (dir) => path.join(dir, "xdg", "tack")));
await check("HOME fallback is .local/state/tack", () =>
  stateDirRule((dir, marker) => ({
    HOME: path.join(dir, "home"),
    TACK_STUB_MARKER: marker,
  }), (dir) => path.join(dir, "home", ".local", "state", "tack")));
await check("cold start launches the daemon and succeeds", coldStartSuccess);
await check(
  "slow start denies socket_missing, not timeout",
  slowStartFailsWithSocketMissing,
);
await check("a later call restarts a daemon that died", restartAfterDaemonDeath);
await check(
  "ECONNREFUSED on a stale socket restarts the daemon",
  staleSocketRestarts,
);
await check(
  "a second cold start leaves the live daemon reachable",
  secondColdStartKeepsLiveDaemon,
);
await check(
  "a bind before the stat check uses the live socket, no deny",
  competingBindBeforeStatUsesLiveSocket,
);
await check(
  "a rebind with matching identity retries the connect and succeeds",
  rebindWithMatchingIdentity,
);
await check(
  "a rebind with matching identity fails closed when no daemon appears",
  rebindWithNoDaemonFailsClosed,
);
await check(
  "a stale socket file with no daemon denies socket_closed",
  staleSocketFileDeniesSocketClosed,
);
await check(
  "setup awaits async registrations and disposes them",
  setupAwaitsAsyncRegistrations,
);
await check(
  "setup disposes fulfilled registrations when one fails",
  setupRollsBackOnFailedRegistration,
);
await check(
  "a throw in the start continuation denies daemon_error",
  startContinuationThrowDeniesDaemonError,
);
await check(
  "tool execute honors an abort signal",
  toolExecuteHonorsAbortSignal,
);

if (buildDir) rmSync(buildDir, { recursive: true, force: true });
process.exitCode = failures === 0 ? 0 : 1;
