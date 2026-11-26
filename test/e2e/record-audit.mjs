// Record audit proofs against the released binaries in a private scratch tree.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const plugin = path.join(repoRoot, "fixtures", "safe-push");

const STEP_HOLD_MS = 2_500;
const FINAL_HOLD_MS = 3_500;
const COMMAND_MS = 10_000;
const DAEMON_MS = 5_000;
const MAX_PENDING = 16;

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: COMMAND_MS,
    ...options,
  });

  if (result.error) throw result.error;

  return result;
}

function build(tack, out, codexHome) {
  const args = ["build", plugin, "--out", out];
  const env = { ...process.env };

  if (codexHome) {
    args.push("--target", "codex");
    env.CODEX_HOME = codexHome;
  }

  return run(tack, args, { env });
}

async function waitForSocket(socket, daemon) {
  const deadline = Date.now() + DAEMON_MS;

  while (Date.now() < deadline) {
    assert.ok(
      daemon.pid && daemon.exitCode === null && daemon.signalCode === null,
      "released tack-daemon stopped before binding",
    );

    const stat = lstatSync(socket, { throwIfNoEntry: false });

    if (stat?.isSocket() && (stat.mode & 0o777) === 0o600) return;

    await delay(20);
  }

  assert.fail("released tack-daemon did not bind " + socket);
}

function occupy(socket, peers) {
  const peer = createConnection({
    path: socket,
    signal: AbortSignal.timeout(1000),
  });
  peers.push(peer);

  return new Promise((resolve, reject) => {
    peer.on("error", reject);
    peer.once("connect", () => {
      peer.write("{", (error) => (error ? reject(error) : resolve()));
    });
  });
}

async function checkBusy(scratch, binDir) {
  const state = path.join(scratch, "state");
  const socket = path.join(state, "tack.sock");
  const daemonBin = path.join(binDir, "tack-daemon");
  const env = {
    ...process.env,
    TACK_STATE_DIR: state,
    TACK_DAEMON_BIN: daemonBin,
  };
  const peers = [];
  const daemon = spawn(daemonBin, ["--socket", socket, "--plugin", plugin], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const done = new Promise((resolve) => daemon.once("close", resolve));
  daemon.on("error", (error) => console.error(error.message));

  try {
    await waitForSocket(socket, daemon);
    await Promise.all(
      Array.from({ length: MAX_PENDING }, () => occupy(socket, peers)),
    );

    const input =
      JSON.stringify({
        kind: "hook",
        id: 7,
        version: 1,
        hook: "toolBefore",
        call: {
          tool: "shell",
          name: "shell",
          input: { command: "git status" },
        },
      }) + "\n";
    const reply = run(path.join(binDir, "tack-hook"), ["--plugin", plugin], {
      env,
      input,
    });
    assert.equal(reply.status, 0, reply.stderr);
    assert.deepEqual(JSON.parse(reply.stdout), {
      kind: "error",
      id: 0,
      version: 1,
      error: "busy",
      message: "tack: busy",
    });
  } finally {
    for (const peer of peers) peer.destroy();

    daemon.kill("SIGKILL");
    await done;
  }
}

function stateHeader(hooksPath, group) {
  const key = JSON.stringify(hooksPath + ":pre_tool_use:" + group + ":0");
  return "[hooks.state." + key + "]";
}

function stateTable(config, header) {
  return config
    .split(/^(?=\[)/m)
    .find((table) => table.startsWith(header + "\n"))
    ?.replace(/\n+$/, "");
}

function checkTrust(tack, scratch) {
  const home = path.join(scratch, "codex-home");
  const hooksPath = path.join(home, "hooks.json");
  const configPath = path.join(home, "config.toml");
  mkdirSync(home);

  // Reserve distinct keys for the old tack table and the inserted user table.
  const seed = { hooks: [{ type: "command", command: ":" }] };
  writeFileSync(
    hooksPath,
    JSON.stringify({ hooks: { PreToolUse: [seed] } }) + "\n",
  );
  const first = build(tack, path.join(scratch, "out-a"), home);
  assert.equal(first.status, 0, first.stderr);

  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  const userHook = { type: "command", command: "true" };
  const matcher = "Bash";
  hooks.hooks.PreToolUse.unshift({ matcher, hooks: [userHook] });
  writeFileSync(hooksPath, JSON.stringify(hooks) + "\n");

  // Insertion order is the sorted key order of Codex's compact JSON.
  const identity = {
    event_name: "pre_tool_use",
    hooks: [
      {
        async: false,
        command: userHook.command,
        timeout: 600,
        type: userHook.type,
      },
    ],
    matcher,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  const userHeader = stateHeader(hooksPath, 0);
  const staleHeader = stateHeader(hooksPath, 1);
  const userTable = [
    userHeader,
    "enabled  = true",
    'trusted_hash = "sha256:' + hash + '"',
  ].join("\n");
  const original = readFileSync(configPath, "utf8");
  assert.ok(
    stateTable(original, staleHeader),
    "first build did not write tack trust",
  );
  writeFileSync(configPath, original + "\n" + userTable + "\n");

  const second = build(tack, path.join(scratch, "out-b"), home);
  assert.equal(second.status, 0, second.stderr);

  const rebuilt = readFileSync(configPath, "utf8");
  assert.equal(stateTable(rebuilt, staleHeader), undefined);
  assert.equal(stateTable(rebuilt, userHeader), userTable);
  assert.ok(
    stateTable(rebuilt, stateHeader(hooksPath, 2)),
    "new tack trust is missing",
  );
}

function checkHome(tack, scratch) {
  const home = path.join(scratch, "bad-home");
  const out = path.join(scratch, "bad-dist");
  mkdirSync(home);
  writeFileSync(path.join(home, "config.toml"), "hooks = {}\n");
  writeFileSync(path.join(home, "hooks.json"), "{}\n");

  const refused = build(tack, out, home);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(existsSync(out), false);
}

async function main() {
  const tack = process.argv[2] || process.env.TACK_CLI;
  const binDir = process.argv[3] || process.env.TACK_BIN_DIR;
  assert.ok(
    tack && binDir,
    "provide the released tack CLI path and bin directory",
  );

  const parent = realpathSync(process.env.TACK_E2E_DIR || tmpdir());
  const scratch = mkdtempSync(path.join(parent, "tack-audit-"));
  const cli = path.resolve(tack);
  const dist = build(cli, path.join(scratch, "dist"));
  assert.equal(dist.status, 0, dist.stderr);

  await checkBusy(scratch, path.resolve(binDir));
  console.log("AUDIT_BUSY tack: busy");
  await delay(STEP_HOLD_MS);

  checkTrust(cli, scratch);
  console.log("AUDIT_TRUST stale tack trust dropped; user trust kept");
  await delay(STEP_HOLD_MS);

  checkHome(cli, scratch);
  console.log("AUDIT_HOME refused home left no output");
  await delay(FINAL_HOLD_MS);

  rmSync(scratch, { recursive: true });
  console.log("AUDIT_DONE");
}

await main();
