// Smoke test for one release tarball, run on that target's CI runner.
// It unpacks into a throwaway HOME, checks the version, then drives the real
// daemon over its Unix socket with one NDJSON hook request. Every wait has a
// deadline and the daemon and temp folder are always cleaned up.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const TOTAL_TIMEOUT_MS = 20_000;
const DAEMON_START_TIMEOUT_MS = 5_000;
const REPLY_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;
const REQUEST_ID = 4242;
const PROTOCOL_VERSION = 1;

const [, , tarballArg, versionArg, pluginArg] = process.argv;

const tarball = tarballArg && path.resolve(tarballArg);
const expectedVersion = versionArg;
const pluginDir = pluginArg && path.resolve(pluginArg);

const home = mkdtempSync(path.join(tmpdir(), "tack-smoke-"));
const binDir = path.join(home, "bin");
const socket = path.join(home, "tack.sock");

let daemon = null;
let daemonStderr = "";
let finished = false;

const totalTimer = setTimeout(() => {
  if (finished) return;

  console.error("FAIL smoke test exceeded " + TOTAL_TIMEOUT_MS + "ms");
  if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
}, TOTAL_TIMEOUT_MS);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function unpack() {
  mkdirSync(binDir, { recursive: true });

  const result = spawnSync("tar", ["-xzf", tarball, "-C", binDir], { encoding: "utf8" });
  assert(result.status === 0, "tar failed: " + result.stderr.trim());

  chmodSync(path.join(binDir, "tack"), 0o755);
  chmodSync(path.join(binDir, "tack-daemon"), 0o755);
}

function checkVersion() {
  const output = execVersion();
  assert(
    output.includes(expectedVersion),
    "tack --version did not contain " + expectedVersion + ": " + output.trim(),
  );
  console.log("PASS tack --version contains " + expectedVersion);
}

function execVersion() {
  const result = spawnSync(path.join(binDir, "tack"), ["--version"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert(result.status === 0, "tack --version failed: " + result.stderr.trim());

  return result.stdout;
}

function startDaemon() {
  daemon = spawn(
    path.join(binDir, "tack-daemon"),
    ["--socket", socket, "--plugin", pluginDir],
    {
      env: { ...process.env, HOME: home, TACK_STATE_DIR: home, TMPDIR: home },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  daemon.stderr.setEncoding("utf8");
  daemon.stderr.on("data", (text) => {
    daemonStderr += text;
  });
  daemon.on("error", (error) => {
    daemonStderr += String(error);
  });
}

async function waitForSocket() {
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error("daemon exited before binding: " + daemonStderr.trim());
    }

    try {
      if (statSync(socket).isSocket()) return;
    } catch {
      // The daemon has not bound it yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("daemon did not bind " + socket + ": " + daemonStderr.trim());
}

function askDaemon() {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let buffer = "";
    let settled = false;

    const finish = (error, reply) => {
      if (settled) return;
      settled = true;
      client.destroy();
      if (error) reject(error);
      else resolve(reply);
    };

    client.setTimeout(REPLY_TIMEOUT_MS, () => finish(new Error("socket reply timed out")));
    client.on("error", finish);
    client.on("connect", () => {
      const request = {
        kind: "hook",
        id: REQUEST_ID,
        version: PROTOCOL_VERSION,
        hook: "toolBefore",
        call: {
          tool: "shell",
          name: "shell",
          input: { command: "ls" },
          session_id: null,
        },
      };
      client.write(JSON.stringify(request) + "\n");
    });
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;

      let reply;
      try {
        reply = JSON.parse(buffer.slice(0, end));
      } catch (error) {
        finish(error);
        return;
      }
      finish(null, reply);
    });
  });
}

async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null) return;

  daemon.kill("SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;

  while (Date.now() < deadline && daemon.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (daemon.exitCode === null) daemon.kill("SIGKILL");
}

async function main() {
  assert(tarball && expectedVersion && pluginDir, "usage: run.mjs <tarball> <version> <plugin-dir>");

  unpack();
  checkVersion();
  startDaemon();
  await waitForSocket();

  const reply = await askDaemon();
  assert(reply.id === REQUEST_ID, "reply id " + reply.id + " did not match " + REQUEST_ID);
  console.log("PASS daemon replied with matching id " + reply.id);
}

try {
  await main();
  finished = true;
  console.log("smoke test passed");
} catch (error) {
  finished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error("FAIL " + message);
  if (daemonStderr.trim()) console.error("daemon stderr: " + daemonStderr.trim());
  process.exitCode = 1;
} finally {
  clearTimeout(totalTimer);
  await stopDaemon();
  rmSync(home, { recursive: true, force: true });
}
