// Records the Claude Code session for the slice recording. Terminal Control
// starts this process; it prepares a throwaway tree, builds the mod with the
// released tack CLI, runs the pinned Claude Code against the loopback model,
// and renders the session beside daemon.log. A command typed into stdin runs
// with the session environment, then the run finishes after a short hold.
// Run only in CI or a disposable container with a throwaway HOME.

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
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const claudeDir = path.join(repoRoot, "test", "claude");

const modelScript = path.join(claudeDir, "model.mjs");
const gitShim = path.join(claudeDir, "git-shim");
const modRecorderTemplate = path.join(claudeDir, "mod-recorder");
const pluginSource = path.join(repoRoot, "fixtures", "safe-push");
const verdictPath = path.join(repoRoot, "verdict-claude.txt");

const tackCli = process.env.TACK_CLI || "tack";
const daemonBin = process.env.TACK_DAEMON_BIN || "tack-daemon";

const LEFT_W = 72;
const RIGHT_W = 48;
const MAX_LINES = 200;
const WATCH_MS = 250;

const MODEL_TIMEOUT_MS = 10_000;
const BUILD_TIMEOUT_MS = 10_000;
const SESSION_TIMEOUT_MS = 90_000;
// Room for the workflow to mark the ready frame before Claude Code starts.
const START_DELAY_MS = 1_000;
const PROOF_WAIT_MS = 30_000;
const PROOF_TIMEOUT_MS = 10_000;
const HOLD_AFTER_PROOF_MS = 6_000;
const DAEMON_STOP_MS = 5_000;

const DENY_REASON = "tack: push blocked";
const TOOL_RESULT = "guard_status: daemon ok";
const DAEMON_DENY = "hook toolBefore deny push blocked";
const DAEMON_TOOL = "tool guard_status ok";
// Strings termctrl waits for; wrapping never splits one across pane lines.
const VISIBLE = [DENY_REASON, TOOL_RESULT];

const children = new Set();
const leftQueue = [];
const rightQueue = [];
const daemonDecoder = new StringDecoder("utf8");

let tree;
let sessionEnv;
let daemonOffset = 0;
let daemonRest = "";
let inputBuffer = "";
let headerState = "";
let sawDeny = false;
let sawTool = false;
let watchTimer;
let holdTimer;
let finished = false;
let verdictFinal = false;

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

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

// Writes the mod recorder with its two absolute paths in place of the
// placeholders, as test/claude/run.mjs does, so it works whatever
// environment the mod's process gets.
function installModRecorder(target, recorderFile, execFile) {
  const template = readFileSync(modRecorderTemplate, "utf8");

  for (const placeholder of ["@RECORDER@", "@EXEC@"]) {
    if (template.split(placeholder).length !== 2) {
      throw new Error("mod-recorder must hold " + placeholder + " exactly once");
    }
  }

  const script = template
    .replace("@RECORDER@", shellQuote(recorderFile))
    .replace("@EXEC@", shellQuote(execFile));

  writeFileSync(target, script);
  chmodSync(target, 0o755);
}

function layout(base) {
  const t = {
    base,
    home: path.join(base, "home"),
    claudeConfig: path.join(base, "claude-config"),
    configHome: path.join(base, "xdg", "config"),
    stateDir: path.join(base, "xdg", "state"),
    dataHome: path.join(base, "xdg", "data"),
    cacheHome: path.join(base, "xdg", "cache"),
    tmpHome: path.join(base, "tmp"),
    binDir: path.join(base, "bin"),
    projectDir: path.join(base, "project"),
    dist: path.join(base, "dist"),
    recorder: path.join(base, "recorder.log"),
    modRecorder: path.join(base, "mod-recorder.log"),
    requestLog: path.join(base, "requests.jsonl"),
  };
  t.daemonLog = path.join(t.stateDir, "daemon.log");

  for (const dir of [
    t.home, t.claudeConfig, t.configHome, t.dataHome, t.cacheHome,
    t.tmpHome, t.binDir, t.projectDir, t.dist,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // tack-hook trusts the state dir only when the euid owns it with mode 0700
  // or stricter. The chmod sets the mode whatever the umask took away or left.
  mkdirSync(t.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(t.stateDir, 0o700);

  return t;
}

function installShims(t) {
  const hookBin = process.env.TACK_HOOK_BIN || findExecutable("tack-hook");
  if (!hookBin) throw new Error("set TACK_HOOK_BIN to the released tack-hook");

  const shim = path.join(t.binDir, "git");
  copyFileSync(gitShim, shim);
  chmodSync(shim, 0o755);

  // The mod runs the plain name tack-hook, so the recorder takes that name
  // first on PATH and hands each call to the released binary.
  installModRecorder(
    path.join(t.binDir, "tack-hook"),
    t.modRecorder,
    path.resolve(hookBin),
  );
}

function initRepo(t, git) {
  const env = { ...process.env, HOME: t.home, XDG_CONFIG_HOME: t.configHome };
  const steps = [
    ["init", ["init", "-q"]],
    ["commit", [
      "-c", "user.email=demo@tack",
      "-c", "user.name=demo",
      "commit", "--allow-empty", "-q", "-m", "initial",
    ]],
    ["update-ref", ["update-ref", "refs/remotes/origin/main", "HEAD"]],
  ];

  for (const [name, args] of steps) {
    const result = spawnSync(git, args, { cwd: t.projectDir, env });

    if (result.status !== 0) {
      const detail = result.stderr?.toString().trim() || "unknown error";
      throw new Error("git " + name + " failed: " + detail);
    }
  }
}

function sessionEnvFor(t, port, realGit) {
  return {
    PATH: t.binDir + path.delimiter + (process.env.PATH ?? ""),
    HOME: t.home,
    TMPDIR: t.tmpHome,
    SHELL: "/bin/bash",
    XDG_CONFIG_HOME: t.configHome,
    XDG_DATA_HOME: t.dataHome,
    XDG_STATE_HOME: t.stateDir,
    XDG_CACHE_HOME: t.cacheHome,
    CLAUDE_CONFIG_DIR: t.claudeConfig,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:" + port,
    ANTHROPIC_API_KEY: "dummy",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    TACK_STATE_DIR: t.stateDir,
    TACK_DAEMON_BIN: daemonBin,
    TACK_RECORDER: t.recorder,
    TACK_REAL_GIT: realGit,
  };
}

function buildMod(dist) {
  return new Promise((resolve, reject) => {
    const args = ["build", pluginSource, "--out", dist, "--target", "claude"];
    const child = track(spawn(tackCli, args, {
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
      if (code === 0) resolve(path.join(dist, "claude"));
      else reject(new Error("tack build failed: " + error.trim()));
    });
  });
}

function startModel(requestLog) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(process.execPath, [modelScript, requestLog], {
      stdio: ["ignore", "pipe", "pipe"],
    }));
    let buffer = "";
    let error = "";
    let settled = false;

    const settle = (err, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(port);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(new Error("model did not report a port within 10 s"));
    }, MODEL_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const value = line.trim();
        if (/^\d+$/.test(value) && Number(value) > 0) settle(null, Number(value));
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      error += text;
    });

    child.once("error", (err) => settle(err));
    child.once("exit", (code) => {
      settle(new Error("model exited " + code + ": " + error.trim()));
    });
  });
}

function judgement(t, sessionDeny, sessionTool) {
  const daemonText = t ? readOptional(t.daemonLog) : "";
  const recorderText = t ? readOptional(t.recorder) : "";
  const modText = t ? readOptional(t.modRecorder) : "";

  const denied = daemonText.includes(DAEMON_DENY) && sessionDeny;
  const guarded = daemonText.includes(DAEMON_TOOL) && sessionTool;
  const noPush = !recorderText.split("\n")
    .some((line) => /^push(\s|$)/.test(line.trim()));
  const hookCalled = modText.trim().length > 0;

  return {
    denied,
    guarded,
    noPush,
    hookCalled,
    lines: [
      "push_denied=" + denied,
      "guard_status_ran=" + guarded,
      "no_push_recorded=" + noPush,
      "hook_called=" + hookCalled,
    ],
    ok: denied && guarded && noPush && hookCalled,
  };
}

function pad(text, width) {
  const clean = String(text).replace(/[\r\t]/g, " ").trimEnd();
  return clean.length >= width ? clean.slice(0, width) : clean.padEnd(width);
}

function printHeader(result, force) {
  const state = [
    result.denied, result.guarded, result.hookCalled, result.noPush,
  ].join(":");
  if (!force && state === headerState) return;
  headerState = state;

  const parts = [
    result.denied ? "[1] git push blocked" : "[1] push pending",
    result.guarded ? "[2] guard_status ran" : "[2] guard pending",
    result.hookCalled ? "[3] tack-hook called" : "[3] hook pending",
    result.noPush ? "[4] no git push" : "[4] PUSH EXECUTED",
  ];
  process.stdout.write(parts.join("  ") + "\n");
}

// Judges once, then writes verdict-claude.txt and prints the header from
// that one result, so the file never lags the captions on screen. Once
// finish() has written the last verdict the tree is gone, so nothing is
// judged again.
function refresh(force = false) {
  if (verdictFinal) return null;

  const result = judgement(tree, sawDeny, sawTool);
  writeFileSync(verdictPath, result.lines.join("\n") + "\n");
  printHeader(result, force);
  return result;
}

function printTitles() {
  process.stdout.write(pad("Claude session", LEFT_W) + "| daemon.log\n");
}

// Cuts a line to the pane's width, moving a cut back to the start of a
// visible string it would split.
function wrap(line, width) {
  const out = [];
  let rest = line;

  while (rest.length > width) {
    let cut = width;

    for (const value of VISIBLE) {
      const at = rest.indexOf(value);
      if (at > 0 && at < cut && at + value.length > cut) cut = at;
    }

    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  if (rest) out.push(rest);
  return out;
}

function paneLines(text, width) {
  const clean = String(text).replace(/\r/g, "").replace(/\t/g, "  ");
  return clean.split("\n").flatMap((line) => wrap(line, width));
}

function enqueue(queue, lines) {
  for (const line of lines) {
    queue.push(line);
    if (queue.length > MAX_LINES) queue.shift();
  }
}

function drain() {
  while (leftQueue.length > 0 || rightQueue.length > 0) {
    const left = leftQueue.shift() ?? "";
    const right = rightQueue.shift() ?? "";
    process.stdout.write(pad(left, LEFT_W) + "| " + right + "\n");
  }
}

function collectLeft(text) {
  enqueue(leftQueue, paneLines(text, LEFT_W));
  drain();
}

function collectRight(text) {
  enqueue(rightQueue, paneLines(text, RIGHT_W));
  drain();
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function blockLines(block) {
  if (block?.type === "text") return ["assistant: " + block.text];

  if (block?.type === "tool_use") {
    const input = block.input ?? {};
    const shown = typeof input.command === "string"
      ? input.command
      : JSON.stringify(input);
    return ["-> " + block.name + ": " + shown];
  }

  if (block?.type === "tool_result") {
    const mark = block.is_error === true ? "<- error: " : "<- result: ";
    return [mark + resultText(block.content)];
  }

  return [];
}

// One stream-json frame as the lines a person reads in the left pane.
function frameLines(frame) {
  if (frame.type === "system" && frame.subtype === "init") {
    const plugins = Array.isArray(frame.plugins) ? frame.plugins : [];
    const names = plugins.map((plugin) => String(plugin?.name)).join(", ");
    return ["* init: model " + frame.model, "  plugins: " + names];
  }

  if (frame.type === "system") return ["* system " + frame.subtype];

  if (frame.type === "assistant" || frame.type === "user") {
    const content = frame.message?.content;
    return Array.isArray(content) ? content.flatMap(blockLines) : [];
  }

  if (frame.type === "result") {
    return ["= result " + frame.subtype + ": " + (frame.result ?? "")];
  }

  return ["* " + frame.type];
}

function sessionLine(line) {
  const latched = (!sawDeny && line.includes(DENY_REASON))
    || (!sawTool && line.includes(TOOL_RESULT));
  if (line.includes(DENY_REASON)) sawDeny = true;
  if (line.includes(TOOL_RESULT)) sawTool = true;

  const text = line.trim();
  if (!text) return;

  let frame = null;
  if (text.startsWith("{")) {
    try {
      frame = JSON.parse(text);
    } catch {
      frame = null;
    }
  }

  const lines = frame ? frameLines(frame) : [text];
  for (const value of lines) collectLeft(value);
  if (latched) refresh();
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
  stream.once("end", () => {
    if (buffer.length > 0) handle(buffer);
    buffer = "";
  });
}

// Reads what daemon.log gained since the last poll into the right pane.
function pollDaemon() {
  if (!tree) return;

  let bytes;
  try {
    bytes = readFileSync(tree.daemonLog);
  } catch {
    return;
  }
  if (bytes.length <= daemonOffset) return;

  daemonRest += daemonDecoder.write(bytes.subarray(daemonOffset));
  daemonOffset = bytes.length;

  const lines = daemonRest.split("\n");
  daemonRest = lines.pop();
  for (const line of lines) if (line.trim()) collectRight(line);
  refresh();
}

// No --bare: it turns plugin hooks off. stream-json puts every tool_result
// the session saw into the output, so the deny and the tool result show there.
function runClaude(pluginDir) {
  if (finished) return;

  const args = [
    "-p", "--plugin-dir", pluginDir, "--dangerously-skip-permissions",
    "--model", "scripted", "--output-format", "stream-json", "--verbose",
    "push my branch",
  ];
  const shown = args.map((arg) => {
    return arg === pluginDir ? path.relative(tree.projectDir, arg) : arg;
  });
  collectLeft("$ claude " + shown.slice(0, -1).join(" ") + " 'push my branch'");

  const child = track(spawn("claude", args, {
    cwd: tree.projectDir,
    env: sessionEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  addLines(child.stdout, sessionLine);
  addLines(child.stderr, sessionLine);

  const timer = setTimeout(() => {
    collectLeft("claude did not finish within 90 s; stopped");
    child.kill("SIGKILL");
  }, SESSION_TIMEOUT_MS);

  child.once("error", (err) => collectLeft("claude failed: " + err.message));
  child.once("close", (code) => {
    clearTimeout(timer);
    collectLeft("claude exited " + code);
    refresh();
    process.stdout.write("SESSION_DONE\n");
    holdTimer = setTimeout(finish, PROOF_WAIT_MS);
  });
}

function runCommand(line) {
  if (!sessionEnv) return;

  const child = track(spawn("sh", ["-c", line], {
    cwd: tree.projectDir,
    env: sessionEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  addLines(child.stdout, collectLeft);
  addLines(child.stderr, collectLeft);

  clearTimeout(holdTimer);
  const timer = setTimeout(() => child.kill("SIGKILL"), PROOF_TIMEOUT_MS);

  child.once("error", (err) => collectLeft("command failed: " + err.message));
  child.once("close", () => {
    clearTimeout(timer);
    clearTimeout(holdTimer);
    holdTimer = setTimeout(finish, HOLD_AFTER_PROOF_MS);
  });
}

function onInput(chunk) {
  inputBuffer += String(chunk).replace(/\r/g, "\n");
  const lines = inputBuffer.split("\n");
  inputBuffer = lines.pop();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || finished) continue;

    process.stdout.write("> " + line.slice(0, LEFT_W) + "\n");
    runCommand(line);
  }
}

// The daemon is started by tack-hook, not by this process, so it is stopped
// through the pid in its lock file, as test/claude/run.mjs does in CI.
async function stopDaemon(stateDir) {
  const pid = Number(readOptional(path.join(stateDir, "tack.lock")).trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + DAEMON_STOP_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Writes the verdict, then removes everything this run started. The process
// stays up afterwards, as record.mjs does, until termctrl stops it.
async function finish() {
  if (finished) return;
  finished = true;
  clearInterval(watchTimer);
  clearTimeout(holdTimer);

  pollDaemon();
  drain();

  const result = refresh(true);
  verdictFinal = true;
  process.exitCode = result.ok ? 0 : 1;

  killChildren();
  if (tree && process.env.CI) await stopDaemon(tree.stateDir);
  if (tree) rmSync(tree.base, { recursive: true, force: true });
}

function onSignal() {
  finish().finally(() => process.exit());
}

async function main() {
  const root = process.env.RUNNER_TEMP ?? tmpdir();

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    process.once(signal, onSignal);
  }

  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", onInput);
  process.stdin.on("end", () => finish());

  try {
    tree = layout(mkdtempSync(path.join(root, "tack-rec-claude-")));
    const realGit = findExecutable("git");
    if (!realGit) throw new Error("git is required on PATH for the scratch repo");

    installShims(tree);
    initRepo(tree, realGit);

    const pluginDir = await buildMod(tree.dist);
    const port = await startModel(tree.requestLog);
    sessionEnv = sessionEnvFor(tree, port, realGit);

    refresh(true);
    printTitles();
    watchTimer = setInterval(() => {
      pollDaemon();
      refresh();
    }, WATCH_MS);

    setTimeout(() => runClaude(pluginDir), START_DELAY_MS);
  } catch (error) {
    printTitles();
    collectLeft("setup failed: " + String(error?.message ?? error));
    await finish();
  }
}

await main();
