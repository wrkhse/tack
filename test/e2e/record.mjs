// Records the slice 1 flow in two panes: OpenCode session and daemon.log.
// CI / disposable container only: throwaway HOME, local fake provider, no key.

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

const openCodeBin = process.env.OPENCODE_BIN || "opencode";
const tackCli = process.env.TACK_CLI || "tack";
const daemonBin = process.env.TACK_DAEMON_BIN || "tack-daemon";

// Twenty rows fit inside the VHS viewport with room to spare, so the
// caption and the pane headers are never pushed off by auto-wrap.
const ROWS = 20;
const COLS = 120;
const PANE_W = 56;
const LEFT_COL = 1;
const SEP_COL = 59;
const RIGHT_COL = 61;
const VIEW_ROWS = ROWS - 3;
const REDRAW_MS = 200;
const MAX_FRAMES = 90;
const MAX_BUFFER = 120;
const MAX_CODE_LINES = 8;

const BUILD_TIMEOUT_MS = 4_000;
const MODEL_TIMEOUT_MS = 4_000;
const RUN_TIMEOUT_MS = 9_000;
const WALL_TIMEOUT_MS = 12_000;

const KEY_DAEMON = [
  "tack-daemon: hook toolBefore deny push blocked",
  "tack-daemon: hook toolBefore allow",
  "tack-daemon: tool guard_status ok",
];
const KEY_SET = new Set(KEY_DAEMON);
const seenDaemon = new Set();

const children = new Set();
const codeBuffer = [];
const daemonBuffer = [];
let markerPush = false;
let markerGuard = false;
let recorderLine = "[3] recorder pending";
let frames = 0;
let redrawTimer;

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

function clip(text, width) {
  const clean = String(text).replace(/[\r\t]/g, " ").trimEnd();
  return clean.length > width ? clean.slice(0, width) : clean.padEnd(width);
}

function keepLast(buffer, text, limit) {
  if (!text || buffer.includes(text)) return;
  buffer.push(text);
  if (buffer.length > limit) buffer.shift();
}

function at(row, col, text) {
  return "\x1b[" + row + ";" + col + "H" + text;
}

function firstString(value, keys) {
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string" && found.length > 0) return found;
  }
  return "";
}

function firstObject(value, keys) {
  for (const key of keys) {
    const found = value[key];
    if (found && typeof found === "object" && !Array.isArray(found)) return found;
  }
  return null;
}

function inputSummary(input) {
  if (!input) return "{}";
  const args = firstObject(input, ["input", "arguments", "args"]) ?? input;
  if (typeof args.command === "string") return args.command;
  return JSON.stringify(args);
}

function describeCode(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }

  const type = String(event.type ?? "");
  const tool = firstString(event, ["tool", "name", "toolName"]);
  const input = firstObject(event, ["input", "arguments", "args", "state"]);
  let text = firstString(event, ["text", "output", "message", "error"]);
  if (!text) {
    const nested = [
      "part", "content", "result", "output", "state", "metadata",
    ];
    const part = firstObject(event, nested);
    if (part) text = firstString(part, ["text", "output", "message", "error"]);
  }
  const brief = text.replace(/\s+/g, " ").trim();

  if (type === "error" || /blocked|denied|tack:/i.test(brief)) {
    return "opencode: blocked - " + brief;
  }
  if (type.includes("tool") && type.includes("use")) {
    return "opencode: tool " + (tool || "?") + " - " + inputSummary(input);
  }
  if (type.includes("tool") && type.includes("result")) {
    return "opencode: result - " + brief;
  }
  if (brief) return "opencode: " + brief;
  return null;
}

function render() {
  if (frames >= MAX_FRAMES) return;
  frames += 1;

  const first = markerPush ? "[1] git push blocked" : "[1] push pending";
  const second = markerGuard ? "[2] guard_status ran" : "[2] guard pending";
  const caption = first + "    " + second + "    " + recorderLine;
  const rule = "-".repeat(PANE_W);
  const left = codeBuffer.slice(-VIEW_ROWS);
  const right = KEY_DAEMON.map((key) => (seenDaemon.has(key) ? key : ""));
  const extras = daemonBuffer.filter((line) => !KEY_SET.has(line));
  right.push(...extras.slice(-(VIEW_ROWS - KEY_DAEMON.length)));
  while (right.length < VIEW_ROWS) right.push("");

  const out = ["\x1b[H\x1b[2J"];
  out.push(at(1, 1, caption.slice(0, COLS)));
  out.push(at(2, LEFT_COL, clip("OpenCode session", PANE_W)));
  out.push(at(2, SEP_COL, "|"));
  out.push(at(2, RIGHT_COL, clip("daemon.log", PANE_W)));
  out.push(at(3, LEFT_COL, rule));
  out.push(at(3, SEP_COL, "|"));
  out.push(at(3, RIGHT_COL, rule));

  for (let i = 0; i < VIEW_ROWS; i += 1) {
    const row = 4 + i;
    out.push(at(row, LEFT_COL, clip(left[i] ?? "", PANE_W)));
    out.push(at(row, SEP_COL, "|"));
    out.push(at(row, RIGHT_COL, clip(right[i], PANE_W)));
  }

  process.stdout.write(out.join(""));
}

function startRedraw() {
  process.stdout.write("\x1b[?25l");
  render();
  redrawTimer = setInterval(render, REDRAW_MS);
}

function stopRedraw() {
  clearInterval(redrawTimer);
  process.stdout.write("\x1b[?25h\x1b[1;1H");
}

function handleCode(line) {
  keepLast(codeBuffer, describeCode(line), MAX_CODE_LINES);
}

function handleDaemon(line) {
  if (line.trim().length === 0) return;
  pushLine(daemonBuffer, line);
  if (KEY_SET.has(line)) seenDaemon.add(line);
  if (line.includes("hook toolBefore deny push blocked")) markerPush = true;
  if (line.includes("tool guard_status ok")) markerGuard = true;
}

function pushLine(buffer, line) {
  buffer.push(line);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
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

function runOpenCode(env, projectDir) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(
      openCodeBin,
      ["run", "--standalone", "--format", "json", "-m", "fake/scripted", "push it"],
      { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] },
    ));
    let timedOut = false;
    const flushOut = addLines(child.stdout, handleCode);
    const flushErr = addLines(child.stderr, handleCode);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      flushOut();
      flushErr();
      resolve({ code, timedOut });
    });
  });
}

function tailDaemon(logPath) {
  let offset = 0;
  let partial = "";
  const timer = setInterval(() => {
    let text;
    try {
      text = readFileSync(logPath, "utf8");
    } catch {
      return;
    }
    if (text.length <= offset) return;
    const fresh = text.slice(offset);
    offset = text.length;
    partial += fresh;
    const lines = partial.split("\n");
    partial = lines.pop();
    for (const line of lines) handleDaemon(line);
  }, 100);
  return () => clearInterval(timer);
}

async function stopDaemon(stateDir) {
  let pid;
  try {
    pid = Number(readFileSync(path.join(stateDir, "tack.lock"), "utf8").trim());
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
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
  const recorder = path.join(base, "recorder.log");
  const daemonLog = path.join(stateDir, "daemon.log");

  for (const dir of [
    home, configHome, stateDir, dataHome, cacheHome, tmpHome, binDir,
    projectDir, dist,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  let model;
  let stopTail = () => {};
  let wallTimer;
  startRedraw();

  try {
    wallTimer = setTimeout(() => killChildren(), WALL_TIMEOUT_MS);

    initRepo(projectDir);
    const shim = path.join(binDir, "git");
    copyFileSync(gitShim, shim);
    chmodSync(shim, 0o755);

    await buildPlugin(dist);
    const pluginDir = path.join(dist, "opencode");

    model = await startModel();
    writeConfig(configHome, pluginDir, "http://127.0.0.1:" + model.port + "/v1");

    const env = {
      PATH: binDir + path.delimiter + (process.env.PATH ?? ""),
      HOME: home,
      TMPDIR: tmpHome,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateDir,
      XDG_CACHE_HOME: cacheHome,
      TACK_STATE_DIR: stateDir,
      TACK_DAEMON_BIN: daemonBin,
      TACK_RECORDER: recorder,
      TACK_REAL_GIT: findExecutable("git") ?? "",
      OPENCODE_DB: path.join(base, "opencode.sqlite"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_FILEWATCHER: "1",
    };

    stopTail = tailDaemon(daemonLog);
    const run = await runOpenCode(env, projectDir);
    stopTail();
    stopTail = () => {};

    if (run.timedOut) {
      keepLast(codeBuffer, "opencode: hit " + RUN_TIMEOUT_MS + "ms bound",
        MAX_CODE_LINES);
    }

    const recorded = readOptional(recorder);
    const pushed = recorded.split("\n").some((line) => line.startsWith("push"));
    recorderLine = pushed ? "[3] PUSH EXECUTED" : "[3] no git push";
    keepLast(
      codeBuffer,
      "recorder: " + (pushed ? "push was executed" : "no git push executed"),
      MAX_CODE_LINES,
    );
    render();
  } catch (error) {
    recorderLine = "[3] error: " + error.message;
    render();
  } finally {
    clearTimeout(wallTimer);
    stopTail();
    killChildren();
    stopRedraw();
    await stopDaemon(stateDir);

    // The verdict reads the real artefacts, never OpenCode's own output.
    const daemonText = readOptional(daemonLog);
    const denied = daemonText.includes("hook toolBefore deny");
    const guarded = daemonText.includes("tool guard_status ok");
    const noPush = !readOptional(recorder)
      .split("\n")
      .some((line) => line.startsWith("push"));
    const verdict = [
      "push_denied=" + denied,
      "guard_status_ran=" + guarded,
      "no_push_recorded=" + noPush,
    ];
    writeFileSync(path.join(repoRoot, "verdict.txt"), verdict.join("\n") + "\n");
    process.exitCode = denied && guarded && noPush ? 0 : 1;

    if (created) rmSync(base, { recursive: true, force: true });
  }
}

await main();
