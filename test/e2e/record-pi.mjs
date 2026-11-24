// Terminal Control runs this recorder only in Linux CI. It runs the release
// binaries and pinned Pi against a loopback model and a disposable git repo.

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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const plugin = path.join(repoRoot, "fixtures", "safe-push");
const modelScript = path.join(repoRoot, "test", "pi", "model.mjs");
const gitShim = path.join(repoRoot, "test", "claude", "git-shim");
const verdictPath = path.join(repoRoot, "verdict-pi.txt");

const LEFT_W = 72;
const RIGHT_W = 48;
const MAX_LINES = 200;
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const WATCH_MS = 250;
const MODEL_MS = 10_000;
const BUILD_MS = 10_000;
const DAEMON_MS = 5_000;
const SESSION_MS = 90_000;
const PROOF_MS = 10_000;
const PROOF_INPUT_MS = 30_000;
const READY_HOLD_MS = 1_000;
const PROOF_HOLD_MS = 6_000;

const DENY = "tack: push blocked";
const TOOL = "guard_status: daemon ok";
const PROOF = "NO_PUSH_REACHED_ORIGIN";
const VISIBLE = [DENY, TOOL, PROOF];
const DAEMON_DENY = "tack-daemon: hook toolBefore deny push blocked";
const DAEMON_TOOL = "tack-daemon: tool guard_status ok";

const children = new Set();
const left = [];
const right = [];
const daemonDecoder = new StringDecoder("utf8");
const stop = Promise.withResolvers();
const proof = Promise.withResolvers();

let tree;
let watchTimer;
let daemonOffset = 0;
let daemonRest = "";
let headerState = "";
let sawDeny = false;
let sawTool = false;
let entryCount = 0;
let loadedEntry = false;
let validEvents = true;
let acceptingProof = false;
let stopping = false;
let verdictFinal = false;

function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;

    return undefined;
  }
}

function executable(name) {
  const candidates = name.includes(path.sep) ? [path.resolve(name)] :
    (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
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
  return {
    base,
    home: path.join(base, "home"),
    agent: path.join(base, "agent"),
    config: path.join(base, "xdg-config"),
    data: path.join(base, "xdg-data"),
    state: path.join(base, "state"),
    cache: path.join(base, "xdg-cache"),
    tmp: path.join(base, "tmp"),
    bin: path.join(base, "bin"),
    project: path.join(base, "project"),
    dist: path.join(base, "dist"),
    requests: path.join(base, "requests.jsonl"),
    recorder: path.join(base, "recorder.log"),
    hookRecorder: path.join(base, "hook-recorder.log"),
    daemonLog: path.join(base, "state", "daemon.log"),
    socket: path.join(base, "state", "tack.sock"),
  };
}

function sessionEnv(t, bins) {
  return {
    PATH: [t.bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
      .join(path.delimiter),
    HOME: t.home,
    TMPDIR: t.tmp,
    SHELL: "/bin/bash",
    XDG_CONFIG_HOME: t.config,
    XDG_DATA_HOME: t.data,
    XDG_STATE_HOME: t.state,
    XDG_CACHE_HOME: t.cache,
    PI_CODING_AGENT_DIR: t.agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    TACK_STATE_DIR: t.state,
    TACK_DAEMON_BIN: bins.daemon,
    TACK_HOOK_BIN: path.join(t.bin, "tack-hook"),
    TACK_RECORDER: t.recorder,
    TACK_REAL_GIT: bins.git,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
  };
}

function quote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function prepare(t, bins, env) {
  for (const dir of [t.home, t.agent, t.config, t.data, t.cache, t.tmp, t.bin,
    t.project]) {
    mkdirSync(dir);
  }

  mkdirSync(t.state, { mode: 0o700 });
  chmodSync(t.state, 0o700);
  writeFileSync(t.recorder, "");
  writeFileSync(t.hookRecorder, "");

  const git = path.join(t.bin, "git");
  copyFileSync(gitShim, git);
  chmodSync(git, 0o755);

  // Keep the hook's stdin and stdout intact and record only successful calls.
  const script = "#!/bin/sh\n" + quote(bins.hook) + ' "$@" || exit $?\n' +
    "printf '%s\\n' call >> " + quote(t.hookRecorder) + "\n";
  writeFileSync(env.TACK_HOOK_BIN, script, { mode: 0o755 });
  chmodSync(env.TACK_HOOK_BIN, 0o755);
}

function initRepo(t, env) {
  const origin = path.join(t.base, "origin.git");
  const steps = [
    ["init", "-q", "--initial-branch=main"],
    ["-c", "user.name=Pi recording", "-c", "user.email=pi@example.invalid",
      "commit", "--allow-empty", "--no-gpg-sign", "-qm", "Fixture"],
    ["clone", "--bare", "-q", ".", origin],
    ["remote", "add", "origin", origin],
    ["fetch", "-q", "origin", "refs/heads/main:refs/remotes/origin/main"],
    ["branch", "-q", "--set-upstream-to=origin/main", "main"],
  ];

  for (const args of steps) {
    const run = spawnSync(env.TACK_REAL_GIT, args, {
      cwd: t.project, env, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
    });

    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error("git " + args[0] + ": " + run.stderr);
  }
}

function writeConfig(agent, port) {
  const models = {
    providers: {
      loopback: {
        baseUrl: "http://127.0.0.1:" + port + "/v1",
        api: "openai-completions",
        apiKey: "dummy",
        models: [{ id: "scripted" }],
      },
    },
  };
  const settings = {
    defaultProvider: "loopback",
    defaultModel: "scripted",
    defaultThinkingLevel: "off",
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
  };

  writeFileSync(path.join(agent, "models.json"), JSON.stringify(models) + "\n");
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify(settings) + "\n");
}

function startChild(bin, args, options) {
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
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
  child.once("error", (error) => { run.error = error; });
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
  const stopped = stop.promise.then(() => { throw new Error("recording stopped"); });

  try {
    return await Promise.race([promise, timeout, stopped]);
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
    const lines = chunk.split("\n");
    const tail = lines.pop();

    for (const text of lines) line(text);

    overflow ||= rest.length + tail.length > MAX_LINE_CHARS;
    rest = overflow ? "" : rest + tail;
  });
  stream.once("end", () => {
    if (rest || overflow) line("");
  });
}

async function startModel(t, env) {
  const run = startChild(process.execPath, [modelScript, "normal", t.requests], {
    cwd: t.project, env,
  });
  const ready = Promise.withResolvers();
  addLines(run.child.stdout, (line) => {
    const port = Number(line);

    if (/^[1-9]\d{0,4}$/.test(line) && port <= 65535) ready.resolve(port);
    else ready.reject(new Error("invalid model port: " + line.slice(0, LEFT_W)));
  });
  addLines(run.child.stderr, (line) => enqueue(left, line, LEFT_W));

  const exited = run.done.then((result) => {
    throw new Error("loopback model closed: " + exitDetail(result));
  });

  return await bounded(Promise.race([ready.promise, exited]), MODEL_MS, "model");
}

async function buildMod(t, env, cli) {
  const args = ["build", "fixtures/safe-push", "--out", t.dist, "--target", "pi"];
  const run = startChild(cli, args, { cwd: repoRoot, env });
  run.child.stdout.resume();
  addLines(run.child.stderr, (line) => enqueue(left, line, LEFT_W));

  const result = await bounded(run.done, BUILD_MS, "tack build");
  if (result.code !== 0) throw new Error("tack build: " + exitDetail(result));
}

async function startDaemon(t, env) {
  const log = openSync(t.daemonLog, "a", 0o600);
  const args = ["--socket", t.socket, "--plugin", plugin];
  let run;

  try {
    run = startChild(env.TACK_DAEMON_BIN, args, {
      cwd: t.project, env, stdio: ["ignore", log, log],
    });
  } finally {
    closeSync(log);
  }

  const deadline = performance.now() + DAEMON_MS;
  const exited = run.done.then((result) => {
    throw new Error("tack-daemon: " + exitDetail(result));
  });

  while (!stopping && performance.now() < deadline) {
    const info = statSync(t.socket, { throwIfNoEntry: false });
    if (info?.isSocket() && (info.mode & 0o777) === 0o600) return;

    await Promise.race([delay(25), exited, stop.promise]);
  }

  if (stopping) throw new Error("recording stopped");

  throw new Error("tack-daemon did not open its socket within 5 s");
}

function noPushRecorded() {
  const text = tree && readOptional(tree.recorder);
  return text !== undefined &&
    !text.split("\n").some((row) => row.startsWith("push"));
}

function judgement() {
  const log = tree && readOptional(tree.daemonLog)?.split("\n");
  const hooks = tree && readOptional(tree.hookRecorder)?.split("\n");

  return {
    push_denied: sawDeny && log?.includes(DAEMON_DENY) === true,
    guard_status_ran: sawTool && log?.includes(DAEMON_TOOL) === true,
    no_push_recorded: noPushRecorded(),
    hook_called: hooks?.includes("call") === true,
    extension_loaded: entryCount === 1 && loadedEntry,
  };
}

function printHeader(result, force) {
  const parts = [
    result.push_denied ? "[1] git push blocked" : "[1] push pending",
    result.guard_status_ran ? "[2] guard_status ran" : "[2] guard pending",
    result.hook_called ? "[3] tack-hook called" : "[3] hook pending",
    result.no_push_recorded ? "[4] no git push" : "[4] no-push unverified",
    result.extension_loaded ? "[5] extension loaded" : "[5] load pending",
  ];
  const header = parts.join("  ");
  if (!force && header === headerState) return;

  headerState = header;
  process.stdout.write(header + "\n");
}

// Write the verdict before showing the captions from that same judgement.
function refresh(force = false) {
  if (verdictFinal) return;

  const result = judgement();
  const rows = Object.entries(result).map(([key, value]) => key + "=" + value);
  writeFileSync(verdictPath, rows.join("\n") + "\n");
  printHeader(result, force);

  return Object.values(result).every((value) => value);
}

function enqueue(queue, text, width) {
  const clean = text.replace(/\r/g, "").replace(/\t/g, "  ");

  for (const line of clean.split("\n")) {
    let rest = line;

    while (rest) {
      let cut = width;

      for (const value of VISIBLE) {
        const at = rest.indexOf(value);
        if (at > 0 && at < cut && at + value.length > cut) cut = at;
      }

      queue.push(rest.slice(0, cut));
      if (queue.length > MAX_LINES) queue.shift();
      rest = rest.slice(cut);
    }
  }
}

function drain() {
  while (left.length > 0 || right.length > 0) {
    const l = left.shift() ?? "";
    const r = right.shift() ?? "";
    process.stdout.write(l.padEnd(LEFT_W) + "| " + r + "\n");
  }
}

function pollDaemon() {
  if (!tree || verdictFinal) return;

  let bytes;

  try {
    bytes = readFileSync(tree.daemonLog);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;

    return;
  }

  if (bytes.length <= daemonOffset) return;

  daemonRest += daemonDecoder.write(bytes.subarray(daemonOffset));
  daemonOffset = bytes.length;

  const lines = daemonRest.split("\n");
  daemonRest = lines.pop();
  for (const line of lines) enqueue(right, line, RIGHT_W);
}

function textOf(content) {
  if (!Array.isArray(content)) return "";

  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text).join("\n");
}

function eventLine(event) {
  switch (event.type) {
    case "entry_appended": {
      const { type, customType, data } = event.entry ?? {};
      entryCount += 1;
      loadedEntry = type === "custom" && customType === "tack-loaded" &&
        isDeepStrictEqual(data, {});
      return loadedEntry ? "* extension entry: tack-loaded" : "* unexpected entry";
    }
    case "tool_execution_start": {
      const args = event.args?.command ?? JSON.stringify(event.args ?? {});
      return "-> " + event.toolName + ": " + args;
    }
    case "tool_execution_end": {
      const text = textOf(event.result?.content);
      sawDeny ||= event.toolName === "bash" && event.isError === true &&
        text === DENY;
      sawTool ||= event.toolName === "guard_status" && event.isError === false &&
        text === TOOL;
      return (event.isError ? "<- error: " : "<- result: ") + text;
    }
    case "message_end": {
      const text = textOf(event.message?.content);
      return event.message?.role === "assistant" && text ? "assistant: " + text : "";
    }
    case "extension_error":
      validEvents = false;
      return "* extension error: " + (event.error ?? "unknown error");
    default:
      return "";
  }
}

function sessionLine(line) {
  if (verdictFinal) return;

  let event;

  try {
    event = JSON.parse(line);
    if (typeof event?.type !== "string") throw new Error("missing Pi event type");
  } catch {
    validEvents = false;
    enqueue(left, "invalid Pi JSONL: " + line.slice(0, LEFT_W), LEFT_W);
    return;
  }

  const text = eventLine(event);
  if (text) enqueue(left, text, LEFT_W);
  if (event.type === "tool_execution_end" || event.type === "entry_appended") {
    render();
  }
}

function render() {
  pollDaemon();
  refresh();
  drain();
}

async function runPi(t, env, pi) {
  const extension = path.join(t.dist, "pi", "extension.js");
  const args = [
    "--mode", "json", "--no-extensions", "-e", extension, "push my branch",
  ];
  enqueue(left, "$ pi --mode json --no-extensions -e " +
    path.relative(t.project, extension) + " 'push my branch'", LEFT_W);

  const run = startChild(pi, args, { cwd: t.project, env, detached: true });
  addLines(run.child.stdout, sessionLine);
  addLines(run.child.stderr, (line) => enqueue(left, "pi: " + line, LEFT_W));

  const result = await bounded(run.done, SESSION_MS, "Pi session");
  enqueue(left, "Pi " + exitDetail(result), LEFT_W);

  if (result.code !== 0) throw new Error("Pi session: " + exitDetail(result));
  if (!validEvents) throw new Error("Pi did not emit a clean event stream");
}

async function runProof(t, env) {
  acceptingProof = true;
  process.stdout.write("SESSION_DONE\n");

  const command = await bounded(proof.promise, PROOF_INPUT_MS, "proof input");
  enqueue(left, "$ " + command, LEFT_W);

  const run = startChild("/bin/sh", ["-c", command], {
    cwd: t.project, env, detached: true,
  });
  addLines(run.child.stdout, (line) => enqueue(left, line, LEFT_W));
  addLines(run.child.stderr, (line) => enqueue(left, line, LEFT_W));

  const result = await bounded(run.done, PROOF_MS, "proof command");
  if (result.code !== 0) throw new Error("proof command: " + exitDetail(result));
  if (!noPushRecorded()) throw new Error("git shim did not prove zero pushes");

  enqueue(left, PROOF, LEFT_W);
  render();
}

function watchInput() {
  function requestStop() {
    stopping = true;
    stop.resolve();
  }

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    process.on(signal, requestStop);
  }

  addLines(process.stdin, (raw) => {
    const line = raw.trim();
    if (!acceptingProof || !line || raw.length > LEFT_W * 4) return;

    acceptingProof = false;
    proof.resolve(line);
  });
  process.stdin.once("end", requestStop);
  process.stdin.resume();
}

// If the foreground daemon died during Pi's session, tack-hook could have
// cold-started a replacement. Only signal a lock owner from this exact run.
async function stopReplacementDaemon(t, bin) {
  const pid = readOptional(path.join(t.state, "tack.lock"))?.trim();
  if (!pid || !/^[1-9]\d{0,9}$/.test(pid)) return;

  const cmdline = "/proc/" + pid + "/cmdline";
  const expected = [bin, "--socket", t.socket, "--plugin", plugin, ""].join("\0");
  if (readOptional(cmdline) !== expected) return;

  try {
    process.kill(Number(pid), "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }

  const deadline = performance.now() + DAEMON_MS;

  while (readOptional(cmdline) === expected) {
    if (performance.now() >= deadline) {
      throw new Error("replacement daemon did not exit");
    }

    await delay(25);
  }
}

async function cleanUp() {
  const running = [...children].reverse();

  try {
    for (const run of running) run.kill();

    const timer = new AbortController();

    try {
      await Promise.race([
        Promise.all(running.map((run) => run.done)),
        delay(DAEMON_MS, undefined, { signal: timer.signal }),
      ]);

      if (tree?.daemonBin) await stopReplacementDaemon(tree, tree.daemonBin);
    } finally {
      timer.abort();
    }
  } finally {
    if (tree) rmSync(tree.base, { recursive: true, force: true });
  }
}

async function record() {
  const bins = {
    git: executable("git"),
    pi: executable("pi"),
    cli: executable(process.env.TACK_CLI || "tack"),
    daemon: executable(process.env.TACK_DAEMON_BIN || "tack-daemon"),
    hook: executable(process.env.TACK_HOOK_BIN || "tack-hook"),
  };
  const root = path.resolve(process.env.RUNNER_TEMP ?? tmpdir());
  tree = layout(mkdtempSync(path.join(root, "tack-rec-pi-")));
  tree.daemonBin = bins.daemon;
  const env = sessionEnv(tree, bins);
  prepare(tree, bins, env);
  initRepo(tree, env);

  await buildMod(tree, env, bins.cli);
  writeConfig(tree.agent, await startModel(tree, env));
  await startDaemon(tree, env);

  refresh(true);
  process.stdout.write("Pi session".padEnd(LEFT_W) + "| daemon.log\n");
  watchTimer = setInterval(render, WATCH_MS);
  await Promise.race([
    delay(READY_HOLD_MS, undefined, { ref: false }), stop.promise,
  ]);

  if (stopping) throw new Error("recording stopped");

  await runPi(tree, env, bins.pi);
  render();
  await runProof(tree, env);
  await Promise.race([
    delay(PROOF_HOLD_MS, undefined, { ref: false }), stop.promise,
  ]);
}

async function main() {
  if (process.platform !== "linux" || process.env.CI !== "true") {
    throw new Error("Pi recording runs only in Linux CI");
  }

  watchInput();
  let completed = false;

  try {
    // Clear any verdict from a preceding recording before showing evidence.
    refresh(true);
    await record();
    completed = true;
  } catch (error) {
    enqueue(left, "recording failed: " + error.message, LEFT_W);
  } finally {
    clearInterval(watchTimer);

    try {
      pollDaemon();
      process.exitCode = refresh(true) && completed ? 0 : 1;
      drain();
    } finally {
      verdictFinal = true;
      await cleanUp();
    }
  }

  // Leave the final frame in place until Terminal Control stops the recorder.
  await stop.promise;
  process.stdin.pause();
}

await main();
