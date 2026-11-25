// Smoke test for one release tarball, run on that target's CI runner.
// It unpacks into a throwaway HOME, checks the version, builds the Pi
// extension and the Codex adapter, then drives the real daemon with one NDJSON
// hook request twice:
// over its Unix socket directly, and through the released tack-hook binary.
// Every wait has a deadline and the daemon, the hook and the temp folder are
// always cleaned up.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const TOTAL_TIMEOUT_MS = 20_000;
const PI_BUILD_TIMEOUT_MS = 5_000;
const CODEX_BUILD_TIMEOUT_MS = 5_000;
const MAX_CODEX_FILES = 64;
const DAEMON_START_TIMEOUT_MS = 5_000;
const REPLY_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;
const REQUEST_ID = 4242;
const PROTOCOL_VERSION = 1;
const BINARIES = ["tack", "tack-daemon", "tack-hook"];

const [, , tarballArg, versionArg, pluginArg] = process.argv;

const tarball = tarballArg && path.resolve(tarballArg);
const expectedVersion = versionArg;
const pluginDir = pluginArg && path.resolve(pluginArg);

const home = mkdtempSync(path.join(tmpdir(), "tack-smoke-"));
const binDir = path.join(home, "bin");
const socket = path.join(home, "tack.sock");
// tack build --target codex writes hook trust into Codex's user state. Pinning
// CODEX_HOME inside the throwaway HOME keeps a runner's own value out of it.
const codexHome = path.join(home, ".codex");

// tack-hook trusts the state dir only when the euid owns it with mode 0700
// or stricter. HOME is the state dir here, so the chmod states that mode.
chmodSync(home, 0o700);

let daemon = null;
let daemonStderr = "";
let hook = null;
let hookStderr = "";
let finished = false;

const totalTimer = setTimeout(() => {
  if (finished) return;

  console.error("FAIL smoke test exceeded " + TOTAL_TIMEOUT_MS + "ms");
  if (hook && hook.exitCode === null) hook.kill("SIGKILL");
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

  for (const name of BINARIES) {
    const binary = path.join(binDir, name);
    assert(existsSync(binary), "tarball has no " + name);
    chmodSync(binary, 0o755);
  }
}

function checkVersion() {
  const output = execVersion().trim();
  const expected = "tack " + expectedVersion;
  assert(
    output === expected,
    "tack --version printed '" + output + "', expected '" + expected + "'",
  );
  console.log("PASS tack --version is " + expectedVersion);
}

function execVersion() {
  const result = spawnSync(path.join(binDir, "tack"), ["--version"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert(result.status === 0, "tack --version failed: " + result.stderr.trim());

  return result.stdout;
}

function tackBuild(target, out, timeout) {
  const result = spawnSync(
    path.join(binDir, "tack"),
    ["build", pluginDir, "--out", out, "--target", target],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
      timeout,
      killSignal: "SIGKILL",
    },
  );
  assert(
    result.status === 0,
    "tack build --target " + target + " failed for " + out + ": " +
      (result.error?.message ?? result.stderr.trim()),
  );
}

function checkPiBuild() {
  const outputs = [path.join(home, "pi-dist-a"), path.join(home, "pi-dist-b")];

  for (const out of outputs) {
    tackBuild("pi", out, PI_BUILD_TIMEOUT_MS);
  }

  const extensions = outputs.map((out) => readFileSync(path.join(out, "pi", "extension.js")));
  const [digestA, digestB] = extensions.map((bytes) => createHash("sha256").update(bytes).digest("hex"));
  assert(digestA === digestB, "Pi extension SHA-256 mismatch: " + digestA + " != " + digestB);

  const text = extensions[0].toString("utf8");
  const lines = text.split("\n");
  const pluginPath = path.resolve(pluginDir);
  assert(
    lines.includes("const PLUGIN_DIR = " + JSON.stringify(pluginPath) + ";"),
    "Pi extension has no PLUGIN_DIR set to " + pluginPath,
  );
  assert(lines.includes("const BUDGET_MS = 8500;"), "Pi extension has no 8500 ms budget");
  assert(
    /^export default function register\(/m.test(text),
    "Pi extension has no top-level default register export",
  );

  console.log("PASS tack build --target pi produced matching extensions with the expected path, budget, and export");
}

// Each part of the Codex adapter, matched by its path under <out>/codex. A
// file counts for the first part it matches, so the MCP server is never also
// counted as a script.
const CODEX_PARTS = [
  { name: "hooks config", pattern: /(^|\/)(hooks\.json|config\.toml)$/ },
  { name: "MCP server", pattern: /mcp/i },
  { name: "script", pattern: /(^|\/)scripts?\/[^/]+$|\.(sh|mjs|js)$/ },
];

function codexPart(file) {
  return CODEX_PARTS.find((part) => part.pattern.test(file))?.name;
}

// Every file under dir as a sorted list of relative paths, bounded so a
// runaway build cannot make the walk unbounded.
function listFiles(dir) {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
  assert(
    files.length <= MAX_CODEX_FILES,
    "Codex adapter has " + files.length + " files, more than " + MAX_CODEX_FILES,
  );

  return files;
}

// The SHA-256 of one emitted file, with its own build folder written as
// <out> so two folders compare only on what the build generated.
function codexDigest(out, file) {
  const text = readFileSync(path.join(out, "codex", file)).toString("latin1");
  const normalized = [realpathSync(out), out].reduce(
    (current, prefix) => current.split(prefix).join("<out>"),
    text,
  );

  return createHash("sha256").update(normalized, "latin1").digest("hex");
}

function checkCodexBuild() {
  const outputs = [path.join(home, "codex-dist-a"), path.join(home, "codex-dist-b")];
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });

  for (const out of outputs) {
    tackBuild("codex", out, CODEX_BUILD_TIMEOUT_MS);
  }

  const [filesA, filesB] = outputs.map((out) => listFiles(path.join(out, "codex")));
  assert(
    JSON.stringify(filesA) === JSON.stringify(filesB),
    "Codex adapter files differ: " + JSON.stringify(filesA) + " != " + JSON.stringify(filesB),
  );

  const found = new Set(filesA.map(codexPart));

  for (const part of CODEX_PARTS) {
    assert(found.has(part.name), "Codex adapter has no " + part.name + " in " + JSON.stringify(filesA));
  }

  for (const file of filesA) {
    const size = statSync(path.join(outputs[0], "codex", file)).size;
    assert(size > 0, "Codex adapter file " + file + " is empty");

    const [digestA, digestB] = outputs.map((out) => codexDigest(out, file));
    assert(
      digestA === digestB,
      "Codex adapter " + file + " SHA-256 mismatch: " + digestA + " != " + digestB,
    );
  }

  console.log(
    "PASS tack build --target codex produced " + filesA.length +
      " matching non-empty files with the hooks config, MCP server and scripts",
  );
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

function requestLine() {
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

  return JSON.stringify(request) + "\n";
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
      client.write(requestLine());
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

// The released hook reaches the daemon started above on <home>/tack.sock;
// TACK_DAEMON_BIN and --plugin only matter if that daemon were gone.
function askHook() {
  return new Promise((resolve, reject) => {
    hook = spawn(path.join(binDir, "tack-hook"), ["--plugin", pluginDir], {
      env: {
        ...process.env,
        HOME: home,
        TACK_STATE_DIR: home,
        TACK_DAEMON_BIN: path.join(binDir, "tack-daemon"),
        TMPDIR: home,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let settled = false;

    const finish = (error, reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hook.exitCode === null && hook.signalCode === null) hook.kill("SIGKILL");
      if (error) reject(error);
      else resolve(reply);
    };

    const timer = setTimeout(
      () => finish(new Error("tack-hook round trip: no reply and exit within " + REPLY_TIMEOUT_MS + "ms")),
      REPLY_TIMEOUT_MS,
    );

    hook.stdout.setEncoding("utf8");
    hook.stdout.on("data", (text) => {
      stdout += text;
    });
    hook.stderr.setEncoding("utf8");
    hook.stderr.on("data", (text) => {
      hookStderr += text;
    });
    hook.on("error", (error) => finish(new Error("tack-hook round trip: " + error.message)));
    hook.stdin.on("error", (error) => finish(new Error("tack-hook round trip: stdin " + error.message)));

    // close fires after exit and after stdout has ended, so the line is whole.
    hook.on("close", (code, signal) => {
      if (code !== 0) {
        finish(new Error("tack-hook round trip: exited with " + (signal ?? "code " + code)));
        return;
      }

      const end = stdout.indexOf("\n");
      if (end < 0 || end !== stdout.length - 1) {
        finish(new Error("tack-hook round trip: stdout was not one reply line: " + JSON.stringify(stdout)));
        return;
      }

      try {
        finish(null, JSON.parse(stdout.slice(0, end)));
      } catch (error) {
        finish(new Error("tack-hook round trip: reply is not JSON: " + error.message));
      }
    });

    hook.stdin.end(requestLine());
  });
}

function checkHookReply(reply) {
  const got = {
    kind: reply.kind,
    id: reply.id,
    version: reply.version,
    "outcome.kind": reply.outcome?.kind,
  };
  const want = {
    kind: "hook",
    id: REQUEST_ID,
    version: PROTOCOL_VERSION,
    "outcome.kind": "allow",
  };

  for (const field of Object.keys(want)) {
    assert(
      got[field] === want[field],
      "tack-hook round trip: reply " + field + " was " + JSON.stringify(got[field]) +
        ", expected " + JSON.stringify(want[field]) + " in " + JSON.stringify(reply),
    );
  }
  console.log("PASS tack-hook relayed an allow reply with id " + reply.id);
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
  checkPiBuild();
  checkCodexBuild();
  startDaemon();
  await waitForSocket();

  const reply = await askDaemon();
  assert(reply.id === REQUEST_ID, "reply id " + reply.id + " did not match " + REQUEST_ID);
  console.log("PASS daemon replied with matching id " + reply.id);

  assert(daemon.exitCode === null, "daemon exited before the tack-hook round trip: " + daemonStderr.trim());
  checkHookReply(await askHook());
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
  if (hookStderr.trim()) console.error("tack-hook stderr: " + hookStderr.trim());
  process.exitCode = 1;
} finally {
  clearTimeout(totalTimer);
  await stopDaemon();
  rmSync(home, { recursive: true, force: true });
}
