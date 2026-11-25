// Terminal Control runs this recorder only in Linux CI. It builds the Codex
// adapter with the released tack CLI into throwaway CODEX_HOME, HOME and XDG
// folders, starts the released tack-daemon and the loopback Responses
// stand-in from test/codex/model.mjs, runs the pinned Codex twice, and
// renders each session beside daemon.log. The first session pushes and calls
// guard_status; the second runs a harmless git status. Each step stays on
// screen 2.5 s before the next appears, and the proof 3.5 s before the finish.

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const plugin = realpathSync(path.join(repoRoot, "fixtures", "safe-push"));
const modelScript = path.join(repoRoot, "test", "codex", "model.mjs");
const gitShim = path.join(repoRoot, "test", "claude", "git-shim");
const verdictPath = path.join(repoRoot, "verdict-codex.txt");

const LEFT_W = 72;
const RIGHT_W = 48;
const MAX_LINES = 200;
const MAX_PACED = 1_000;
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const WATCH_MS = 250;
const MODEL_MS = 10_000;
const BUILD_MS = 15_000;
const DAEMON_MS = 5_000;
const SESSION_MS = 90_000;
const PROOF_MS = 10_000;
const PROOF_INPUT_MS = 30_000;
const STEP_HOLD_MS = 2_500;
const FINAL_HOLD_MS = 3_500;

// Each session is one codex exec run against one model.mjs script.
const SESSIONS = [
  { script: "normal", prompt: "push my branch" },
  { script: "harmless", prompt: "check the working tree" },
];
const HARMLESS = "git status --short";
const UNTRACKED = "harmless.txt";
const RAN = "?? " + UNTRACKED;

const DENY = "tack: push blocked";
const TOOL = "guard_status: daemon ok";
const ALLOW = "PreToolUse allowed: " + HARMLESS;
const PROOF = "NO_PUSH_REACHED_ORIGIN";
// Strings termctrl waits for; wrapping never splits one across pane lines.
const VISIBLE = [DENY, TOOL, RAN, ALLOW, PROOF];
const DAEMON_DENY = "tack-daemon: hook toolBefore deny push blocked";
const DAEMON_TOOL = "tack-daemon: tool guard_status ok";
const DAEMON_ALLOW = "tack-daemon: hook toolBefore allow";
const LOADED = '{"call":"tack-loaded"}';
// The hook recorder's line for each verdict tack-hook returned, in order.
const HOOK_VERDICTS = [
  '{"request":"hook","hook":"toolBefore","outcome":"deny"}',
  '{"request":"tool","name":"guard_status","outcome":"tool"}',
  '{"request":"hook","hook":"toolBefore","outcome":"allow"}',
];
const BLOCKED = /blocked by PreToolUse hook: (.*)\. (?:Command|Tool): /s;

const children = new Set();
const leftQueue = [];
const rightQueue = [];
const paced = [];
const daemonDecoder = new StringDecoder("utf8");

let tree;
let sessionEnv;
let current;
let daemonOffset = 0;
let daemonRest = "";
let inputBuffer = "";
let headerState = "";
let sawDeny = false;
let sawTool = false;
let sawAllow = false;
let denyQueued = false;
let toolQueued = false;
let allowQueued = false;
let proofShown = false;
let acceptingProof = false;
let holdUntil = 0;
let pumpTimer;
let watchTimer;
let proofTimer;
let finalTimer;
let titlesShown = false;
let finished = false;
let verdictFinal = false;

function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function lines(text) {
  return text ? text.split("\n").filter(Boolean) : [];
}

function executable(name) {
  const candidates = name.includes(path.sep)
    ? [path.resolve(name)]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.resolve(dir, name));

  for (const file of candidates) {
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }

  throw new Error("executable not found: " + name);
}

function layout(base) {
  const home = path.join(base, "home");
  const xdgState = path.join(home, ".local", "state");
  // TACK_STATE_DIR, XDG_STATE_HOME/tack and HOME/.local/state/tack name the
  // same folder, so the adapter's MCP server finds the daemon whatever
  // environment Codex gives it.
  const state = path.join(xdgState, "tack");

  return {
    base,
    home,
    xdgState,
    state,
    codexHome: path.join(base, "codex-home"),
    config: path.join(base, "xdg-config"),
    data: path.join(base, "xdg-data"),
    cache: path.join(base, "xdg-cache"),
    tmp: path.join(base, "tmp"),
    bin: path.join(base, "bin"),
    project: path.join(base, "project"),
    dist: path.join(base, "dist"),
    recorder: path.join(base, "recorder.log"),
    hookCalls: path.join(base, "hook-calls.log"),
    daemonLog: path.join(state, "daemon.log"),
    socket: path.join(state, "tack.sock"),
  };
}

function xdgEnv(t) {
  return {
    HOME: t.home,
    CODEX_HOME: t.codexHome,
    XDG_CONFIG_HOME: t.config,
    XDG_DATA_HOME: t.data,
    XDG_STATE_HOME: t.xdgState,
    XDG_CACHE_HOME: t.cache,
  };
}

function codexEnv(t, bins) {
  return {
    ...xdgEnv(t),
    PATH: [t.bin, "/usr/bin", "/bin"].join(path.delimiter),
    TMPDIR: t.tmp,
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    CODEX_API_KEY: "dummy",
    OPENAI_API_KEY: "dummy",
    TACK_STATE_DIR: t.state,
    TACK_DAEMON_BIN: bins.daemon,
    TACK_RECORDER: t.recorder,
    TACK_REAL_GIT: bins.git,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
  };
}

// As test/codex/run.mjs: feedback, metrics and web search off, and the model
// a custom Responses provider on the loopback stand-in over plain HTTP, since
// a custom provider uses the Responses websocket only when told to.
function sessionFlags(port) {
  const flags = [
    "feedback.enabled=false",
    'otel.metrics_exporter="none"',
    "mcp_optional_startup_grace_ms=0",
    'web_search="disabled"',
    'model_provider="loopback"',
    'model_providers.loopback.name="loopback"',
    'model_providers.loopback.base_url="http://127.0.0.1:' + port + '/v1"',
    'model_providers.loopback.env_key="CODEX_API_KEY"',
    'model_providers.loopback.wire_api="responses"',
    "model_providers.loopback.supports_websockets=false",
  ];

  return flags.flatMap((flag) => ["-c", flag]);
}

// The hook recorder runs as tack-hook first on PATH. It hands each call to
// the released tack-hook unchanged and logs one line for each verdict the
// daemon gave. Its paths are written in, since an MCP server may run with a
// reduced environment. It is CommonJS so Node runs it without an extension.
const HOOK_RECORDER = String.raw`
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const LIMIT = 2 * 1024 * 1024;
const input = [];
let size = 0;

process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size > LIMIT) process.exit(70);
  input.push(chunk);
});
process.stdin.on("end", () => relay(Buffer.concat(input)));

function relay(stdin) {
  const child = spawn(REAL, process.argv.slice(2), {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const output = [];

  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stdin.on("error", () => {});
  child.stdin.end(stdin);
  child.on("error", () => { process.exitCode = 127; });
  child.on("close", (code) => {
    const stdout = Buffer.concat(output);
    process.stdout.write(stdout);
    if (code === 0) record(stdin.toString("utf8"), stdout.toString("utf8"));
    process.exitCode = code ?? 128;
  });
}

function record(request, reply) {
  let call;
  let verdict;

  try {
    call = JSON.parse(request.split("\n")[0]);
    verdict = JSON.parse(reply.split("\n")[0]);
  } catch {
    return;
  }

  if (verdict?.kind === "hook" && call?.kind === "hook") {
    appendFileSync(CALLS, JSON.stringify({ request: "hook", hook: call.hook,
      outcome: verdict.outcome?.kind }) + "\n");
  } else if (verdict?.kind === "tool" && call?.kind === "tool") {
    appendFileSync(CALLS, JSON.stringify({ request: "tool", name: call.name,
      outcome: "tool" }) + "\n");
  }
}
`;

function prepare(t, bins) {
  for (const dir of [
    t.home,
    t.codexHome,
    t.config,
    t.data,
    t.cache,
    t.tmp,
    t.bin,
    t.project,
  ]) {
    mkdirSync(dir, { mode: 0o700 });
  }

  // tack-hook trusts the state folder only when the euid owns it with mode
  // 0700 or stricter; the chmod sets it whatever the umask left.
  mkdirSync(t.state, { recursive: true, mode: 0o700 });
  chmodSync(t.state, 0o700);
  writeFileSync(t.recorder, "");
  writeFileSync(t.hookCalls, "");

  const git = path.join(t.bin, "git");
  copyFileSync(gitShim, git);
  chmodSync(git, 0o755);
  // The adapter's hooks run node from the session's PATH.
  symlinkSync(process.execPath, path.join(t.bin, "node"));

  const recorder = [
    "#!" + process.execPath,
    '"use strict";',
    "const REAL = " + JSON.stringify(bins.hook) + ";",
    "const CALLS = " + JSON.stringify(t.hookCalls) + ";",
    HOOK_RECORDER,
  ].join("\n");
  writeFileSync(path.join(t.bin, "tack-hook"), recorder, { mode: 0o755 });
}

function initProject(t, env) {
  const origin = path.join(t.base, "origin.git");
  const steps = [
    ["init", "-q", "--initial-branch=main"],
    [
      "-c",
      "user.name=Codex recording",
      "-c",
      "user.email=codex@example.invalid",
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-qm",
      "Fixture",
    ],
    ["clone", "--bare", "-q", ".", origin],
    ["remote", "add", "origin", origin],
    ["fetch", "-q", "origin", "refs/heads/main:refs/remotes/origin/main"],
    ["branch", "-q", "--set-upstream-to=origin/main", "main"],
  ];

  for (const args of steps) {
    const run = spawnSync(env.TACK_REAL_GIT, args, {
      cwd: t.project,
      env,
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });

    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error("git " + args[0] + ": " + run.stderr);
  }

  // The harmless git status lists this file, so its output shows git ran.
  writeFileSync(path.join(t.project, UNTRACKED), "untracked\n");
}

function start(bin, args, options) {
  if (finished) throw new Error("recording stopped");

  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  const run = { child, error: undefined, done: undefined, kill: undefined };

  run.kill = () => {
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (child.pid === undefined) return;
    if (!options.detached && exited) return;

    try {
      process.kill(options.detached ? -child.pid : child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  child.once("error", (error) => {
    run.error = error;
  });
  run.done = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      children.delete(run);
      resolve({ code, signal, error: run.error });
    });
  });
  children.add(run);

  return run;
}

async function bounded(promise, ms, label) {
  const timer = new AbortController();
  const timeout = delay(ms, undefined, { signal: timer.signal }).then(() => {
    throw new Error(label + " timed out after " + ms / 1000 + " s");
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    timer.abort();
  }
}

function exitDetail({ code, signal, error }) {
  return error?.message ?? signal ?? "exit " + code;
}

function addLines(stream, handle) {
  let rest = "";
  let overflow = false;

  function line(text) {
    const tooLong = overflow || rest.length + text.length > MAX_LINE_CHARS;
    const value = tooLong ? "[output line too long]" : rest + text;
    rest = "";
    overflow = false;
    handle(value);
  }

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const parts = chunk.split("\n");
    const tail = parts.pop();

    for (const text of parts) line(text);

    overflow ||= rest.length + tail.length > MAX_LINE_CHARS;
    rest = overflow ? "" : rest + tail;
  });
  stream.once("end", () => {
    if (rest || overflow) line("");
  });
}

async function buildAdapter(t, cli) {
  const args = ["build", plugin, "--out", t.dist, "--target", "codex"];
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...xdgEnv(t) };
  const run = start(cli, args, { cwd: repoRoot, env });
  run.child.stdout.resume();
  addLines(run.child.stderr, (line) => show("tack build: " + line));

  const result = await bounded(run.done, BUILD_MS, "tack build");
  if (result.code !== 0) throw new Error("tack build: " + exitDetail(result));
}

// The one step tack build leaves to the user: its generated fragment goes at
// the top of Codex's config.toml, before any table there.
function installFragment(t) {
  const fragment = readFileSync(
    path.join(t.dist, "codex", "config.toml"),
    "utf8",
  );
  const configPath = path.join(t.codexHome, "config.toml");
  const config = readFileSync(configPath, "utf8");

  writeFileSync(configPath, fragment + "\n" + config);
}

async function startDaemon(t, bin) {
  const log = openSync(t.daemonLog, "a", 0o600);
  let run;

  try {
    run = start(bin, ["--socket", t.socket, "--plugin", plugin], {
      cwd: t.project,
      env: sessionEnv,
      stdio: ["ignore", log, log],
    });
  } finally {
    closeSync(log);
  }

  let closed;
  run.done.then((result) => {
    closed = result;
  });
  const deadline = performance.now() + DAEMON_MS;

  while (!finished && performance.now() < deadline) {
    if (closed) throw new Error("tack-daemon: " + exitDetail(closed));

    const info = statSync(t.socket, { throwIfNoEntry: false });
    if (info?.isSocket() && (info.mode & 0o777) === 0o600) return;

    await delay(25);
  }

  throw new Error("tack-daemon did not open its socket within 5 s");
}

async function startModel(session) {
  const args = [modelScript, session.script, session.requests];
  const run = start(process.execPath, args, {
    cwd: tree.project,
    env: sessionEnv,
  });
  const ready = Promise.withResolvers();
  addLines(run.child.stdout, (line) => {
    const port = Number(line);

    if (/^[1-9]\d{0,4}$/.test(line) && port <= 65535) ready.resolve(port);
    else
      ready.reject(new Error("invalid model port: " + line.slice(0, LEFT_W)));
  });
  addLines(run.child.stderr, (line) => show("model: " + line));

  const exited = run.done.then((result) => {
    throw new Error("loopback model closed: " + exitDetail(result));
  });

  try {
    const port = await bounded(
      Promise.race([ready.promise, exited]),
      MODEL_MS,
      "model",
    );
    return { run, port };
  } catch (error) {
    run.kill();
    throw error;
  }
}

async function setup() {
  const bins = {
    git: executable("git"),
    codexJs: realpathSync(executable("codex")),
    cli: executable(process.env.TACK_CLI || "tack"),
    daemon: executable(process.env.TACK_DAEMON_BIN || "tack-daemon"),
    hook: executable(process.env.TACK_HOOK_BIN || "tack-hook"),
  };
  const root = path.resolve(process.env.RUNNER_TEMP ?? tmpdir());

  tree = layout(mkdtempSync(path.join(root, "tack-rec-codex-")));
  tree.daemonBin = bins.daemon;
  for (const session of SESSIONS) {
    session.requests = path.join(
      tree.base,
      "requests-" + session.script + ".jsonl",
    );
  }
  sessionEnv = codexEnv(tree, bins);
  prepare(tree, bins);
  initProject(tree, sessionEnv);

  await buildAdapter(tree, bins.cli);
  installFragment(tree);
  await startDaemon(tree, bins.daemon);

  return bins.codexJs;
}

// The verdict, and the recorder's push for the header, from one read.
function judgement() {
  const daemon = lines(tree && readOptional(tree.daemonLog));
  const recorder = tree && readOptional(tree.recorder);
  const recorded = lines(recorder);
  const hooks = lines(tree && readOptional(tree.hookCalls));
  const loaded = recorded.filter((line) => line === LOADED);
  // True for a push the git shim recorded, false for none, and undefined
  // while there is no recorder to read.
  const pushed =
    recorder === undefined
      ? undefined
      : recorded.some((line) => /^push(\s|$)/.test(line));

  return {
    pushed,
    verdict: {
      push_denied: sawDeny && daemon.includes(DAEMON_DENY),
      guard_status_ran: sawTool && daemon.includes(DAEMON_TOOL),
      no_push_recorded: pushed === false,
      hook_called: isDeepStrictEqual(hooks, HOOK_VERDICTS),
      extension_loaded: loaded.length === SESSIONS.length,
      harmless_allowed: sawAllow && daemon.includes(DAEMON_ALLOW),
    },
  };
}

// The row stays neutral until there is evidence: no git push once the push
// was blocked and the git shim recorded none, PUSH EXECUTED only when the
// shim recorded one.
function noPushRow(denied, pushed) {
  if (pushed === true) return "[6] PUSH EXECUTED";
  return denied && pushed === false ? "[6] no git push" : "[6] no push yet";
}

function printHeader(result, pushed, force) {
  const parts = [
    result.push_denied ? "[1] git push blocked" : "[1] push pending",
    result.guard_status_ran ? "[2] guard_status ran" : "[2] guard pending",
    result.harmless_allowed ? "[3] git status allowed" : "[3] allow pending",
    result.hook_called
      ? "[4] tack-hook carried every call"
      : "[4] hook pending",
    result.extension_loaded ? "[5] adapter loaded" : "[5] load pending",
    noPushRow(result.push_denied, pushed),
  ];
  const header = parts.join("  ");
  if (!force && header === headerState) return;

  headerState = header;
  process.stdout.write(header + "\n");
}

// Judges once, then writes verdict-codex.txt and prints the header from that
// one result, so the file never lags the captions on screen. Once finish()
// has written the last verdict the tree is gone, so nothing is judged again.
function refresh(force = false) {
  if (verdictFinal) return false;

  const { verdict, pushed } = judgement();
  writeVerdict(verdict);
  printHeader(verdict, pushed, force);

  return Object.values(verdict).every((value) => value);
}

function writeVerdict(verdict) {
  const rows = Object.entries(verdict).map(([key, value]) => key + "=" + value);
  writeFileSync(verdictPath, rows.join("\n") + "\n");
}

function pad(text, width) {
  const clean = String(text)
    .replace(/[\r\t]/g, " ")
    .trimEnd();
  return clean.length >= width ? clean.slice(0, width) : clean.padEnd(width);
}

function printTitles() {
  if (titlesShown) return;

  titlesShown = true;
  drain();
  process.stdout.write(pad("Codex session", LEFT_W) + "| daemon.log\n");
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

function enqueue(queue, values) {
  for (const value of values) {
    queue.push(value);
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

// The left pane is paced: after a milestone line appears, nothing more joins
// the left pane for STEP_HOLD_MS, so each step stays readable on screen.
function push(item) {
  if (!item.mark && paced.length >= MAX_PACED) return;

  paced.push(item);
  pump();
}

function show(text) {
  if (finished) return;

  let mark;

  if (!denyQueued && text.includes(DENY)) {
    denyQueued = true;
    mark = "deny";
  } else if (!toolQueued && text.includes(TOOL)) {
    toolQueued = true;
    mark = "tool";
  } else if (!allowQueued && text.includes(ALLOW)) {
    allowQueued = true;
    mark = "allow";
  }

  push({ text, mark });
}

function pump() {
  clearTimeout(pumpTimer);
  pumpTimer = undefined;

  while (paced.length > 0) {
    const wait = holdUntil - performance.now();

    if (wait > 0) {
      pumpTimer = setTimeout(pump, wait);
      return;
    }

    release(paced.shift());
  }
}

function release(item) {
  if (item.raw) {
    drain();
    process.stdout.write(item.text + "\n");
  } else {
    collectLeft(item.text);
  }

  if (!item.mark) return;

  holdUntil = performance.now() + STEP_HOLD_MS;
  reached(item.mark);
}

// A milestone is on screen: latch it, then judge and caption from that.
function reached(mark) {
  if (mark === "deny") sawDeny = true;
  if (mark === "tool") sawTool = true;
  if (mark === "allow") sawAllow = true;
  if (mark === "proof") proofShown = true;

  pollDaemon();
  refresh();
  if (finished) return;

  if (mark === "done") awaitProof();
  if (mark === "proof") finalTimer = setTimeout(finish, FINAL_HOLD_MS);
}

// Reads what daemon.log gained since the last poll into the right pane.
function pollDaemon() {
  if (!tree || verdictFinal) return;

  let bytes;
  try {
    bytes = readFileSync(tree.daemonLog);
  } catch {
    return;
  }
  if (bytes.length <= daemonOffset) return;

  daemonRest += daemonDecoder.write(bytes.subarray(daemonOffset));
  daemonOffset = bytes.length;

  const parts = daemonRest.split("\n");
  daemonRest = parts.pop();
  for (const line of parts) if (line.trim()) collectRight(line);
}

// What Codex returned to the model for the session's Bash call, read from
// the stand-in's request log: the hook's block reason, or the output of a
// command the hook let run.
function pollRequests() {
  if (!current || current.reported) return;

  for (const line of lines(readOptional(current.requests))) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }

    const output = request?.outputs?.call_bash;
    if (typeof output !== "string") continue;

    current.reported = true;
    reportBash(output);
    return;
  }
}

function reportBash(output) {
  const reason = BLOCKED.exec(output)?.[1];

  if (reason !== undefined) {
    show("<- blocked by PreToolUse hook: " + reason);
    return;
  }

  const ran = output.includes(RAN);
  show(
    ran && current.script === "harmless" ? "<- " + ALLOW : "<- bash output:",
  );
  for (const line of lines(output)) show("   " + line);
}

function itemText(item) {
  if (typeof item?.error?.message === "string") return item.error.message;

  return (item?.result?.content ?? [])
    .map((part) => part?.text ?? "")
    .join("\n");
}

function startedLines(item) {
  if (item?.type === "command_execution") return ["-> shell: " + item.command];

  if (item?.type === "mcp_tool_call") {
    const args = JSON.stringify(item.arguments ?? {});
    return ["-> " + item.server + "." + item.tool + " " + args];
  }

  return [];
}

function completedLines(item) {
  switch (item?.type) {
    case "agent_message":
      return ["assistant: " + item.text];
    case "reasoning":
      return [];
    case "command_execution":
      return [
        "<- shell " +
          item.status +
          ", exit " +
          item.exit_code +
          ": " +
          String(item.aggregated_output ?? "").trim(),
      ];
    case "mcp_tool_call": {
      const mark = item.status === "completed" ? "<- result: " : "<- error: ";
      return [mark + itemText(item)];
    }
    case "error":
      return ["! " + item.message];
    default:
      return ["* " + String(item?.type)];
  }
}

// One codex exec --json event as the lines a person reads in the left pane.
function eventLines(event) {
  switch (event?.type) {
    case "thread.started":
      return ["* thread started"];
    case "turn.started":
      return ["* turn started"];
    case "turn.completed":
      return ["= turn completed"];
    case "turn.failed":
      return ["! turn failed: " + (event.error?.message ?? "")];
    case "error":
      return ["! error: " + (event.message ?? "")];
    case "item.started":
      return startedLines(event.item);
    case "item.completed":
      return completedLines(event.item);
    case "item.updated":
      return [];
    default:
      return ["* " + String(event?.type)];
  }
}

function sessionLine(line) {
  pollRequests();

  const text = line.trim();
  if (!text) return;

  let event;
  try {
    event = JSON.parse(text);
  } catch {
    show("codex: " + text);
    return;
  }

  for (const value of eventLines(event)) show(value);
}

async function runCodex(codexJs, session, port) {
  const args = [
    codexJs,
    ...sessionFlags(port),
    "exec",
    "--json",
    "--sandbox",
    "danger-full-access",
    "-m",
    "scripted",
    session.prompt,
  ];
  show(
    "$ codex exec --json --sandbox danger-full-access -m scripted '" +
      session.prompt +
      "'",
  );
  show("  model: loopback Responses on 127.0.0.1:" + port + ", no websocket");

  const run = start(process.execPath, args, {
    cwd: tree.project,
    env: sessionEnv,
    detached: true,
  });
  addLines(run.child.stdout, sessionLine);
  addLines(run.child.stderr, (line) => {
    if (line.trim()) show("codex: " + line);
  });

  const timer = setTimeout(() => {
    show("codex did not finish within 90 s; stopped");
    run.kill();
  }, SESSION_MS);

  try {
    const result = await run.done;
    pollRequests();
    show("codex " + exitDetail(result));
  } finally {
    clearTimeout(timer);
    run.kill();
  }
}

async function runSessions(codexJs) {
  for (const session of SESSIONS) {
    if (finished) return;

    current = session;
    const model = await startModel(session);

    try {
      await runCodex(codexJs, session, model.port);
    } finally {
      model.run.kill();
      await model.run.done;
    }
  }

  push({ text: "SESSION_DONE", raw: true, mark: "done" });
}

function awaitProof() {
  acceptingProof = true;
  proofTimer = setTimeout(() => {
    show("no proof command within 30 s");
    finish();
  }, PROOF_INPUT_MS);
}

function runProof(command) {
  acceptingProof = false;
  clearTimeout(proofTimer);
  show("$ " + command);

  let run;
  try {
    run = start("/bin/sh", ["-c", command], {
      cwd: tree.project,
      env: sessionEnv,
      detached: true,
    });
  } catch (error) {
    show("proof failed: " + error.message);
    finish();
    return;
  }

  addLines(run.child.stdout, show);
  addLines(run.child.stderr, show);
  const timer = setTimeout(run.kill, PROOF_MS);

  run.done.then((result) => {
    clearTimeout(timer);
    const clean = judgement().verdict.no_push_recorded;

    if (result.code === 0 && clean) {
      push({ text: PROOF, mark: "proof" });
      return;
    }

    const pushed = clean ? "" : ", a push was recorded";
    show("proof failed: " + exitDetail(result) + pushed);
    finish();
  });
}

function onInput(chunk) {
  inputBuffer += String(chunk).replace(/\r/g, "\n");
  const parts = inputBuffer.split("\n");
  inputBuffer = parts.pop();
  if (inputBuffer.length > LEFT_W * 4) inputBuffer = "";

  for (const raw of parts) {
    const line = raw.trim();
    if (!acceptingProof || !line || line.length > LEFT_W * 4) continue;

    runProof(line);
  }
}

// A pid from the daemon's lock file, only while it runs this run's daemon
// binary on this run's socket, so a reused pid is never signalled.
function ownDaemon(t) {
  const text = readOptional(path.join(t.state, "tack.lock"))?.trim();
  if (!text || !/^[1-9]\d{0,9}$/.test(text)) return undefined;

  const cmdline = readOptional("/proc/" + text + "/cmdline")?.split("\0");
  const prefix = [t.daemonBin, "--socket", t.socket];
  return isDeepStrictEqual(cmdline?.slice(0, 3), prefix)
    ? Number(text)
    : undefined;
}

// If the daemon this run started died, tack-hook may have started another.
async function stopReplacementDaemon(t) {
  const pid = ownDaemon(t);
  if (pid === undefined) return;

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }

  const deadline = performance.now() + DAEMON_MS;
  while (ownDaemon(t) === pid && performance.now() < deadline) await delay(25);
}

async function cleanUp() {
  const running = [...children];

  try {
    for (const run of running) run.kill();

    await bounded(
      Promise.all(running.map((run) => run.done)),
      DAEMON_MS,
      "child exit",
    ).catch(() => {});
    if (tree?.daemonBin) await stopReplacementDaemon(tree);
  } finally {
    if (tree) rmSync(tree.base, { recursive: true, force: true });
  }
}

// Shows what is still queued, writes the last verdict, then removes
// everything this run started. The process stays up afterwards, holding the
// final frame, until Terminal Control stops it.
async function finish() {
  if (finished) return;
  finished = true;
  acceptingProof = false;
  clearInterval(watchTimer);
  clearTimeout(pumpTimer);
  clearTimeout(proofTimer);
  clearTimeout(finalTimer);

  while (paced.length > 0) release(paced.shift());
  pollDaemon();
  drain();

  const ok = refresh();
  verdictFinal = true;
  process.exitCode = ok && proofShown ? 0 : 1;

  await cleanUp();
}

function onSignal() {
  finish().finally(() => process.exit());
}

async function main() {
  if (process.platform !== "linux" || process.env.CI !== "true") {
    throw new Error("Codex recording runs only in Linux CI");
  }

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    process.once(signal, onSignal);
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onInput);
  process.stdin.once("end", onSignal);
  process.stdin.resume();

  // Clear any verdict from an earlier recording before showing evidence.
  // Only the verdict: the header prints once, above the titles.
  writeVerdict(judgement().verdict);

  try {
    const codexJs = await setup();
    if (finished) return;

    refresh(true);
    printTitles();
    show(
      "$ tack build fixtures/safe-push --target codex: adapter in CODEX_HOME",
    );
    show("$ tack-daemon --socket tack.sock: daemon.log on the right");
    holdUntil = performance.now() + STEP_HOLD_MS;
    watchTimer = setInterval(() => {
      pollRequests();
      pollDaemon();
      refresh();
    }, WATCH_MS);

    await delay(STEP_HOLD_MS);
    await runSessions(codexJs);
  } catch (error) {
    printTitles();
    show("recording failed: " + String(error?.message ?? error));
    await finish();
  }
}

await main();
