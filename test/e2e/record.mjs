// Prepares a scratch session for the VHS tape: real git repo, throwaway HOME,
// fake model, rc-built wrapper, two tmux panes, and a bounded verdict watcher.
// The tape types the real commands; this script writes no session digest.

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

const openCodeBin = process.env.OPENCODE_BIN || "opencode";
const tackCli = process.env.TACK_CLI || "tack";

const SESSION = "tack-rec";
const BUILD_TIMEOUT_MS = 4_000;
const MODEL_TIMEOUT_MS = 4_000;
const WATCH_MS = 250;
const HOLD_MS = 22_000;

const children = new Set();

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

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function paneShell(env, dir) {
  const exported = Object.entries(env)
    .map(([key, value]) => "export " + key + "=" + shellQuote(value))
    .join("; ");
  return "cd " + shellQuote(dir) + "; " + exported +
    "; exec bash --noprofile --norc -i";
}

function tmux(args, env) {
  spawnSync("tmux", args, { stdio: "ignore", env });
}

function launchTmux(env, dir, daemonLog) {
  const runEnv = { ...process.env, ...env };
  tmux(["new-session", "-d", "-s", SESSION, paneShell(env, dir)], runEnv);
  tmux(["split-window", "-h", "-t", SESSION + ":0",
    "exec tail -f " + shellQuote(daemonLog)], runEnv);
  tmux(["set-option", "-g", "pane-border-status", "top"], runEnv);
  tmux(["set-option", "-g", "pane-border-format", "#{pane_title}"], runEnv);
  tmux(["select-pane", "-t", SESSION + ":0.0", "-T",
    "OpenCode session"], runEnv);
  tmux(["select-pane", "-t", SESSION + ":0.1", "-T", "daemon.log"], runEnv);
  tmux(["select-pane", "-t", SESSION + ":0.0"], runEnv);

  return track(spawn("tmux", ["attach-session", "-t", SESSION], {
    stdio: "inherit",
    env: runEnv,
  }));
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

async function main() {
  const base = process.env.TACK_E2E_DIR
    ? path.resolve(process.env.TACK_E2E_DIR)
    : mkdtempSync(path.join(tmpdir(), "tack-rec-"));
  const created = !process.env.TACK_E2E_DIR;

  const home = path.join(base, "home");
  const configHome = path.join(base, "xdg", "config");
  const stateDir = path.join(base, "xdg", "state");
  const dataHome = path.join(base, "xdg", "data");
  const cacheHome = path.join(base, "xdg", "cache");
  const tmpHome = path.join(base, "tmp");
  const binDir = path.join(base, "bin");
  const projectDir = path.join(base, "project");
  const dist = path.join(base, "dist");
  const recorder = path.join(projectDir, "recorder.log");
  const daemonLog = path.join(stateDir, "daemon.log");

  for (const dir of [
    home, configHome, stateDir, dataHome, cacheHome, tmpHome, binDir,
    projectDir, dist,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  let attached;
  let watchTimer;

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

    const env = {
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
      OPENCODE_DB: path.join(base, "opencode.sqlite"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_FILEWATCHER: "1",
    };

    attached = launchTmux(env, projectDir, daemonLog);
    watchTimer = setInterval(() => {
      const result = judgement(
        readOptional(daemonLog),
        readOptional(recorder),
      );
      writeFileSync(verdictPath, result.lines.join("\n") + "\n");
    }, WATCH_MS);

    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
  } finally {
    clearInterval(watchTimer);
    const result = judgement(readOptional(daemonLog), readOptional(recorder));
    writeFileSync(verdictPath, result.lines.join("\n") + "\n");
    process.exitCode = result.ok ? 0 : 1;

    if (attached && attached.exitCode === null) attached.kill("SIGKILL");
    spawnSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" });
    killChildren();
    if (created) rmSync(base, { recursive: true, force: true });
  }
}

await main();
