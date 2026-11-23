// Prepares a scratch session and renders it as plain sequential text.
// Terminal Control records and drives this process directly; commands typed
// into stdin are executed with the prepared environment and streamed raw.

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const fakeModel = path.join(here, "fake-model.mjs");
const gitShim = path.join(here, "git-shim");
const pluginSource = path.join(repoRoot, "fixtures", "safe-push");
const verdictPath = path.join(repoRoot, "verdict.txt");

const tackCli = process.env.TACK_CLI || "tack";

const PANE_W = 76;
const MAX_LINES = 200;
const WATCH_MS = 250;
const SESSION_MS = 30_000;
const HOLD_AFTER_PROOF_MS = 6_000;

const BUILD_TIMEOUT_MS = 4_000;
const MODEL_TIMEOUT_MS = 4_000;

const children = new Set();
const leftLines = [];
const rightLines = [];

let sessionEnv;
let projectDir;
let daemonLog;
let recorder;
let baseDir;
let createdBase;
let inputBuffer = "";
let leftCursor = 0;
let rightCursor = 0;
let headerState = "";
let watchTimer;
let holdTimer;
let finished = false;
let resolveDone;

const done = new Promise((resolve) => {
  resolveDone = resolve;
});

function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function killChildren() {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function findExecutable(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function initRepo(dir) {
  const git = findExecutable("git");
  if (!git) throw new Error("git is required on PATH for the scratch repo");
  const result = spawnSync(git, ["init", "-q"], { cwd: dir });
  if (result.status !== 0) {
    const detail = result.stderr?.toString().trim() ?? "unknown error";
    throw new Error("git init failed: " + detail);
  }
  spawnSync(git, [
    "-c", "user.email=demo@tack",
    "-c", "user.name=demo",
    "commit", "--allow-empty", "-q", "-m", "initial",
  ], { cwd: dir });
  spawnSync(git, ["update-ref", "refs/remotes/origin/main", "HEAD"], {
    cwd: dir,
  });
}

function writeConfig(configHome, pluginDir, baseUrl) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "fake/scripted",
    update: "disable",
    providers: {
      fake: {
        name: "Fake",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: baseUrl, apiKey: "test" },
        models: {
          scripted: {
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 32768, output: 4096 },
          },
        },
      },
    },
    permissions: [{ action: "shell", resource: "*", effect: "allow" }],
    compaction: { auto: false },
    plugins: [pluginDir],
  };
  const target = path.join(configHome, "opencode", "opencode.json");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
}

function buildPlugin(dist) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(tackCli, ["build", pluginSource, "--out", dist], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    let error = "";
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      error += text;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), BUILD_TIMEOUT_MS);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("tack build failed: " + error.trim()));
    });
  });
}

function startModel() {
  return new Promise((resolve, reject) => {
    const child = track(spawn(process.execPath, [fakeModel], {
      stdio: ["ignore", "pipe", "pipe"],
    }));
    let buffer = "";
    let error = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("fake model did not report a port"));
    }, MODEL_TIMEOUT_MS);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const value = line.trim();
        const port = Number(value);
        if (/^\d+$/.test(value) && port > 0) finish(null, { child, port });
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      error += text;
    });
    child.once("error", (err) => finish(err));
    child.once("exit", (code) => {
      finish(new Error("fake model exited " + code + ": " + error.trim()));
    });
  });
}

function judgement(daemonText, recorderText) {
  const denied = daemonText.includes("hook toolBefore deny");
  const guarded = daemonText.includes("tool guard_status ok");
  const noPush = !recorderText.split("\n")
    .some((line) => line.startsWith("push"));
  return {
    lines: [
      "push_denied=" + denied,
      "guard_status_ran=" + guarded,
      "no_push_recorded=" + noPush,
    ],
    ok: denied && guarded && noPush,
  };
}

function pad(text) {
  const clean = String(text).replace(/[\r\t]/g, " ").trimEnd();
  return clean.length >= PANE_W ? clean.slice(0, PANE_W) : clean.padEnd(PANE_W);
}

function printHeader(force = false) {
  const daemonText = readOptional(daemonLog);
  const recorderText = readOptional(recorder);
  const denied = daemonText.includes("hook toolBefore deny");
  const guarded = daemonText.includes("tool guard_status ok");
  const noPush = !recorderText.split("\n")
    .some((line) => line.startsWith("push"));
  const state = denied + ":" + guarded + ":" + noPush;
  if (!force && state === headerState) return;
  headerState = state;

  const first = denied ? "[1] git push blocked" : "[1] push pending";
  const second = guarded ? "[2] guard_status ran" : "[2] guard pending";
  const third = noPush ? "[3] no git push" : "[3] PUSH EXECUTED";
  process.stdout.write(first + "    " + second + "    " + third + "\n");
}

function printTitles() {
  process.stdout.write(
    pad("OpenCode session") + "| daemon.log\n" +
    "-".repeat(PANE_W) + "+" + "-".repeat(PANE_W) + "\n",
  );
}

function emitRow() {
  const left = leftCursor < leftLines.length ? leftLines[leftCursor++] : "";
  const right = rightCursor < rightLines.length
    ? rightLines[rightCursor++]
    : "";
  if (!left && !right) return;
  process.stdout.write(pad(left) + "| " + right.slice(0, PANE_W) + "\n");
  printHeader();
}

function pushWrapped(buffer, text) {
  const clean = String(text).replace(/\r/g, "").replace(/\t/g, "  ");
  for (let i = 0; i < clean.length; i += PANE_W) {
    buffer.push(clean.slice(i, i + PANE_W));
    if (buffer.length > MAX_LINES) buffer.shift();
  }
}

function addLines(stream, handle) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (text) => {
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) handle(line);
  });
  return () => {
    if (buffer.length > 0) handle(buffer);
  };
}

function collectLeft(text) {
  pushWrapped(leftLines, text);
  emitRow();
}

function collectRight(text) {
  pushWrapped(rightLines, text);
  emitRow();
}

function finish() {
  if (finished) return;
  finished = true;
  clearInterval(watchTimer);
  clearTimeout(holdTimer);

  while (leftCursor < leftLines.length || rightCursor < rightLines.length) {
    emitRow();
  }

  const result = judgement(readOptional(daemonLog), readOptional(recorder));
  writeFileSync(verdictPath, result.lines.join("\n") + "\n");
  process.exitCode = result.ok ? 0 : 1;

  killChildren();
  if (createdBase) rmSync(baseDir, { recursive: true, force: true });
  resolveDone();
}

function runCommand(line) {
  const child = track(spawn("sh", ["-c", line], {
    cwd: projectDir,
    env: sessionEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  addLines(child.stdout, collectLeft);
  addLines(child.stderr, collectLeft);

  if (/git log|recorder/.test(line)) {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(finish, HOLD_AFTER_PROOF_MS);
  }
}

function onInput(chunk) {
  inputBuffer += String(chunk).replace(/\r/g, "\n");
  const lines = inputBuffer.split("\n");
  inputBuffer = lines.pop();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    process.stdout.write("> " + line.slice(0, PANE_W) + "\n");
    runCommand(line);
  }
}

async function main() {
  baseDir = process.env.TACK_E2E_DIR
    ? path.resolve(process.env.TACK_E2E_DIR)
    : mkdtempSync(path.join(tmpdir(), "tack-rec-"));
  createdBase = !process.env.TACK_E2E_DIR;

  const home = path.join(baseDir, "home");
  const configHome = path.join(baseDir, "xdg", "config");
  const stateDir = path.join(baseDir, "xdg", "state");
  const dataHome = path.join(baseDir, "xdg", "data");
  const cacheHome = path.join(baseDir, "xdg", "cache");
  const tmpHome = path.join(baseDir, "tmp");
  const binDir = path.join(baseDir, "bin");
  projectDir = path.join(baseDir, "project");
  const dist = path.join(baseDir, "dist");
  recorder = path.join(projectDir, "recorder.log");
  daemonLog = path.join(stateDir, "daemon.log");

  for (const dir of [
    home, configHome, stateDir, dataHome, cacheHome, tmpHome, binDir,
    projectDir, dist,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  try {
    initRepo(projectDir);
    const shim = path.join(binDir, "git");
    copyFileSync(gitShim, shim);
    chmodSync(shim, 0o755);

    await buildPlugin(dist);
    const pluginDir = path.join(dist, "opencode");

    const model = await startModel();
    writeConfig(
      configHome,
      pluginDir,
      "http://127.0.0.1:" + model.port + "/v1",
    );
    writeFileSync(daemonLog, "");
    writeFileSync(recorder, "");

    sessionEnv = {
      PATH: binDir + path.delimiter + (process.env.PATH ?? ""),
      HOME: home,
      TMPDIR: tmpHome,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateDir,
      XDG_CACHE_HOME: cacheHome,
      TACK_STATE_DIR: stateDir,
      TACK_DAEMON_BIN: process.env.TACK_DAEMON_BIN || "tack-daemon",
      TACK_RECORDER: recorder,
      TACK_REAL_GIT: findExecutable("git") ?? "",
      OPENCODE_DB: path.join(baseDir, "opencode.sqlite"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_FILEWATCHER: "1",
    };

    const tail = track(spawn("tail", ["-f", daemonLog], {
      stdio: ["ignore", "pipe", "pipe"],
    }));
    addLines(tail.stdout, collectRight);

    printHeader(true);
    printTitles();
    watchTimer = setInterval(() => {
      const result = judgement(
        readOptional(daemonLog),
        readOptional(recorder),
      );
      writeFileSync(verdictPath, result.lines.join("\n") + "\n");
      printHeader();
    }, WATCH_MS);
    holdTimer = setTimeout(finish, SESSION_MS);

    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", onInput);
    process.stdin.on("end", finish);

    await done;
  } catch {
    finish();
  }
}

await main();
