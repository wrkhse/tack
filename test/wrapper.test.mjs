// Fail-closed and cold-start checks for the generated OpenCode wrapper.
// Runs in CI or a disposable container only, never against a real daemon.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const wrapperPath = process.env.TACK_WRAPPER
  ? path.resolve(process.env.TACK_WRAPPER)
  : path.join(repoRoot, "dist", "opencode", "index.js");

const ENV_KEYS = [
  "TACK_STATE_DIR",
  "TACK_SOCKET",
  "TACK_DAEMON_BIN",
  "TACK_NO_START",
  "TACK_CALL_TIMEOUT_MS",
  "TACK_START_TIMEOUT_MS",
];

const CALL = {
  tool: "shell",
  name: "shell",
  input: { command: "git push origin main" },
  sessionID: "session-1",
  session_id: "session-1",
};

const ALLOW_CALL = { ...CALL, input: { command: "echo hello" } };

const HARD_TIMEOUT_MS = 10_000;

let failures = 0;

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

function fakeContext() {
  const hooks = new Map();
  const transforms = new Map();

  const capture = (target) => (name, handler) => {
    if (typeof name === "function") {
      handler = name;
      name = "default";
    }
    target.set(String(name), handler);
  };

  return {
    ctx: {
      hook: capture(hooks),
      transform: capture(transforms),
      tool: {
        hook: capture(hooks),
        transform: capture(transforms),
        register: () => {},
      },
    },
    hooks,
    transforms,
  };
}

function pickBefore(hooks, transforms) {
  const all = [...hooks, ...transforms];
  const before = all.find(([name]) => /before/i.test(name)) ?? all[0];

  assert.ok(before, "the wrapper registered no before handler");
  assert.equal(typeof before[1], "function", "the before callback is not a function");

  return before[1];
}

async function loadBefore(env) {
  applyEnv(env);

  for (const key of Object.keys(require.cache)) delete require.cache[key];

  const plugin = require(wrapperPath);
  assert.equal(typeof plugin.setup, "function", "the wrapper does not export setup()");

  const { ctx, hooks, transforms } = fakeContext();
  const result = plugin.setup(ctx);

  if (result && typeof result.then === "function") await result;

  return pickBefore(hooks, transforms);
}

function baseEnv(dir, overrides = {}) {
  return {
    TACK_STATE_DIR: dir,
    TACK_SOCKET: path.join(dir, "tack.sock"),
    TACK_DAEMON_BIN: path.join(dir, "no-daemon"),
    TACK_NO_START: "1",
    TACK_CALL_TIMEOUT_MS: "150",
    TACK_START_TIMEOUT_MS: "300",
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
    const env = baseEnv(dir, { TACK_CALL_TIMEOUT_MS: "150" });
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
  const dir = tempDir();
  let server;

  try {
    const env = baseEnv(dir);
    const before = await loadBefore(env);
    server = await listen(env.TACK_SOCKET, (conn) => conn.write("not json\n"));
    await expectDeny(before, "malformed_reply");
  } finally {
    if (server) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// The stub daemon binds the socket the wrapper waits for and answers one hook
// with "allow". It writes its pid beside the socket so the test can stop it.
const STUB_DAEMON = [
  "#!/usr/bin/env node",
  "'use strict';",
  "const net = require('node:net');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const socket = process.env.TACK_SOCKET || path.join(process.env.TACK_STATE_DIR, 'tack.sock');",
  "fs.writeFileSync(socket + '.started', String(process.pid));",
  "const server = net.createServer((conn) => {",
  "  let buffer = '';",
  "  conn.setEncoding('utf8');",
  "  conn.on('error', () => {});",
  "  conn.on('data', (chunk) => {",
  "    buffer += chunk;",
  "    const lines = buffer.split('\\n');",
  "    buffer = lines.pop();",
  "    for (const line of lines) {",
  "      if (!line.trim()) continue;",
  "      let request;",
  "      try { request = JSON.parse(line); } catch { continue; }",
  "      const reply = { kind: 'hook', id: request.id, version: 1, outcome: { kind: 'allow' } };",
  "      conn.write(JSON.stringify(reply) + '\\n');",
  "    }",
  "  });",
  "});",
  "server.listen(socket);",
  "",
].join("\n");

async function coldStart() {
  const dir = tempDir();
  let daemonPid = 0;

  try {
    const stub = path.join(dir, "stub-daemon.js");
    writeFileSync(stub, STUB_DAEMON, { mode: 0o755 });

    const env = baseEnv(dir, {
      TACK_DAEMON_BIN: stub,
      TACK_CALL_TIMEOUT_MS: "2000",
      TACK_START_TIMEOUT_MS: "2000",
    });
    delete env.TACK_NO_START;

    const before = await loadBefore(env);
    await before(ALLOW_CALL);

    const marker = env.TACK_SOCKET + ".started";
    assert.ok(
      existsSync(env.TACK_SOCKET) || existsSync(marker),
      "the first call did not start the daemon",
    );

    if (existsSync(marker)) {
      daemonPid = Number(readFileSync(marker, "utf8"));
      assert.ok(
        Number.isInteger(daemonPid) && daemonPid > 0,
        "the daemon did not report a process id",
      );
    }
  } finally {
    if (daemonPid > 0) {
      try {
        process.kill(daemonPid);
      } catch {
        // The daemon may already have exited with the wrapper.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

await check("socket_missing fails closed", missingSocket);
await check("timeout fails closed", timeout);
await check("socket_closed fails closed", closedSocket);
await check("malformed_reply fails closed", malformedReply);
await check("cold start launches the daemon and succeeds", coldStart);

process.exitCode = failures === 0 ? 0 : 1;
