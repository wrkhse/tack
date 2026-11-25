// Run only in Linux CI or a disposable Linux container. Each real Pi session
// sees one generated extension, an isolated HOME and a loopback model.

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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const here = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const daemonBin = path.join(repoRoot, "target", "debug", "tack-daemon");
const hookBin = path.join(repoRoot, "target", "debug", "tack-hook");
const pluginDir = path.join(repoRoot, "fixtures", "safe-push");
const extension = path.join(repoRoot, "dist", "pi", "extension.js");
const gitShim = path.join(repoRoot, "test", "claude", "git-shim");

const MODEL_START_MS = 10_000;
const DAEMON_START_MS = 5_000;
const RUN_TIMEOUT_MS = 40_000;
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
const EXPECTED_RECORDER = [
  '{"call":"bash","id":1}',
  '{"call":"guard_status","id":2}',
];
// The command tack allows in the harmless case, and the untracked file whose
// `?? ` line in its output shows the real git ran in the project.
const HARMLESS = "git status --short";
const UNTRACKED = "harmless.txt";

const cases = [
  { name: "normal", model: "normal", bash: "tack: push blocked" },
  { name: "harmless", model: "harmless", allow: HARMLESS },
  { name: "missing-hook", model: "bash", bash: "tack: hook_missing" },
  { name: "daemon-crash", model: "bash", bash: "tack: socket_closed" },
  { name: "timeout", model: "bash", bash: "tack: timeout" },
  { name: "invalid-reply", model: "bash", bash: "tack: malformed_reply" },
  { name: "invalid-guard-status", model: "invalid-tool" },
];

function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;

    return undefined;
  }
}

function findExecutable(name, searchPath) {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;

    const file = path.resolve(dir, name);

    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }

  return undefined;
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
    requests: path.join(base, "requests.jsonl"),
    recorder: path.join(base, "recorder.log"),
    hookAttempts: path.join(base, "hook-attempts.log"),
    sleepPid: path.join(base, "sleep.pid"),
    gitShim: path.join(base, "git-shim"),
    gitRuns: path.join(base, "git-runs.log"),
  };
}

function piEnv(tree) {
  return {
    PATH: [tree.bin, "/usr/bin", "/bin"].join(path.delimiter),
    HOME: tree.home,
    TMPDIR: tree.tmp,
    SHELL: "/bin/bash",
    XDG_CONFIG_HOME: tree.config,
    XDG_DATA_HOME: tree.data,
    XDG_STATE_HOME: tree.state,
    XDG_CACHE_HOME: tree.cache,
    PI_CODING_AGENT_DIR: tree.agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    TACK_STATE_DIR: tree.state,
    TACK_DAEMON_BIN: daemonBin,
    TACK_RECORDER: tree.recorder,
    TACK_REAL_GIT: "/usr/bin/git",
    TACK_TEST_HOOK_ATTEMPTS: tree.hookAttempts,
    TACK_TEST_SLEEP_PID: tree.sleepPid,
    TACK_TEST_GIT_SHIM: tree.gitShim,
    TACK_TEST_GIT_RUNS: tree.gitRuns,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
  };
}

function initProject(tree, env) {
  function git(...args) {
    const result = spawnSync(env.TACK_REAL_GIT, args, {
      cwd: tree.project, env, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
    });

    if (result.error) throw result.error;

    if (result.status !== 0) {
      throw new Error("git " + args.join(" ") + ": " + result.stderr);
    }
  }

  const origin = path.join(tree.base, "origin.git");
  git("init", "--initial-branch=main");
  git("-c", "user.name=Pi conformance", "-c", "user.email=pi@example.invalid",
    "commit", "--allow-empty", "--no-gpg-sign", "-m", "Fixture");
  git("clone", "--bare", ".", origin);
  git("remote", "add", "origin", origin);
  git("fetch", "origin", "refs/heads/main:refs/remotes/origin/main");
  git("branch", "--set-upstream-to=origin/main", "main");
}

const hookShims = new Map([
  ["timeout", 'echo "$$" > "$TACK_TEST_SLEEP_PID"\nexec /bin/sleep 15'],
  ["invalid-reply", "printf '%s\\n' 'not JSON'"],
  ["invalid-guard-status", "printf '%s\\n' 'unexpected tack-hook invocation'"],
]);

function installHook(tree, env, caseName) {
  const hook = path.join(tree.bin, "tack-hook");

  if (caseName === "normal" || caseName === "harmless" || caseName === "daemon-crash") {
    accessSync(hookBin, constants.X_OK);
    symlinkSync(hookBin, hook);
    return;
  }

  if (caseName === "missing-hook") {
    // The isolated PATH omits target/debug; a dangling shim exercises ENOENT,
    // not a binary that started and returned a failing exit code.
    symlinkSync(path.join(tree.bin, "absent"), hook);
    if (findExecutable("tack-hook", env.PATH)) throw new Error("tack-hook is not absent");

    return;
  }

  const script = hookShims.get(caseName);
  if (!script) throw new Error("no shim for " + caseName);

  writeFileSync(hook, '#!/bin/sh\nprintf "%s\\n" invoked >> "$TACK_TEST_HOOK_ATTEMPTS"\n' +
    script + "\n", { mode: 0o755 });
}

// The shared git shim on PATH. A case with an allowed command wraps it in a
// recorder that logs each call's exit status and arguments once it returns,
// so the log shows the command ran; the shim itself stays unchanged.
function installGit(tree, expected) {
  const git = path.join(tree.bin, "git");

  if (!expected.allow) {
    copyFileSync(gitShim, git);
    chmodSync(git, 0o755);
    return;
  }

  copyFileSync(gitShim, tree.gitShim);
  chmodSync(tree.gitShim, 0o755);
  writeFileSync(tree.gitRuns, "");
  writeFileSync(git, '#!/bin/sh\n"$TACK_TEST_GIT_SHIM" "$@"\nstatus=$?\n' +
    "printf '%s %s\\n' \"$status\" \"$*\" >> \"$TACK_TEST_GIT_RUNS\"\n" +
    'exit "$status"\n', { mode: 0o755 });
}

function prepare(tree, env, expected) {
  for (const dir of [tree.home, tree.agent, tree.config, tree.data, tree.cache,
    tree.tmp, tree.bin, tree.project]) {
    mkdirSync(dir);
  }

  mkdirSync(tree.state, { mode: 0o700 });
  chmodSync(tree.state, 0o700);
  writeFileSync(tree.recorder, "");
  writeFileSync(tree.hookAttempts, "");

  installGit(tree, expected);
  symlinkSync(process.execPath, path.join(tree.bin, "node"));
  installHook(tree, env, expected.name);
  initProject(tree, env);
  if (expected.allow) writeFileSync(path.join(tree.project, UNTRACKED), "untracked\n");
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

function startChild(bin, args, options, onStdout) {
  const child = spawn(bin, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "", outputLimit: false };
  let closed = false;
  let spawnError;

  function sendSignal(signal) {
    if (closed || child.pid === undefined) return;

    try {
      process.kill(options.detached ? -child.pid : child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }

  function stop() {
    sendSignal("SIGKILL");
  }

  for (const stream of ["stdout", "stderr"]) {
    child[stream].setEncoding("utf8").on("data", (text) => {
      if (output[stream].length + text.length > MAX_OUTPUT_CHARS) {
        output.outputLimit = true;
        stop();
        return;
      }

      output[stream] += text;
      if (stream === "stdout") onStdout?.(output.stdout);
    });
  }

  child.once("error", (error) => { spawnError = error.message; });
  const done = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ ...output, code, signal, spawnError });
    });
  });

  return { pid: child.pid, sendSignal, stop, done };
}

async function modelPort(model, firstLine) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("model did not report its port")), MODEL_START_MS);
  });
  const exit = model.done.then((run) => {
    throw new Error("model exited before ready: " + (run.spawnError ?? run.stderr));
  });

  try {
    const line = await Promise.race([firstLine, deadline, exit]);
    const port = Number(line);
    if (!/^[1-9]\d{0,4}$/.test(line) || port > 65535) throw new Error("invalid port: " + line);

    return port;
  } finally {
    clearTimeout(timer);
  }
}

function readEvents() {
  const events = [];
  const invalid = [];
  let offset = 0;

  function collect(stdout) {
    // Pi JSONL is framed by LF only, even inside a Unicode transcript.
    for (let end = stdout.indexOf("\n", offset); end !== -1; end = stdout.indexOf("\n", offset)) {
      const line = stdout.slice(offset, end);
      offset = end + 1;

      try {
        const event = JSON.parse(line);
        if (typeof event?.type !== "string") throw new Error("missing event type");

        events.push({ event, at: performance.now() });
      } catch {
        invalid.push(line);
      }
    }
  }

  return { events, invalid, collect, complete: (stdout) => offset === stdout.length };
}

async function runPi(pi, tree, env) {
  const jsonl = readEvents();
  const child = startChild(
    pi, ["--mode", "json", "--no-extensions", "-e", extension, "push my branch"],
    { cwd: tree.project, env, detached: true }, jsonl.collect,
  );
  const timer = setTimeout(child.stop, RUN_TIMEOUT_MS);

  try {
    const run = await child.done;
    writeFileSync(path.join(tree.base, "pi-output.jsonl"), run.stdout);
    writeFileSync(path.join(tree.base, "pi-stderr.log"), run.stderr);

    return {
      ...run,
      events: jsonl.events,
      validJsonl: jsonl.invalid.length === 0 && jsonl.complete(run.stdout),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(label, timeout, ready) {
  const deadline = performance.now() + timeout;

  while (performance.now() < deadline) {
    if (ready()) return;

    await delay(25);
  }

  throw new Error("timed out waiting for " + label);
}

function hookConnected(socket) {
  // Linux reports the queued, unaccepted stream as SS_CONNECTING (02)
  // with inode 0 and the listener's path. Only this case's hook connects.
  const rows = readFileSync("/proc/net/unix", "utf8").split("\n");

  return rows.some((row) => {
    const entry = row.match(/^\S+\s+\S+\s+\S+\s+00000000\s+0001\s+02\s+0 (.*)$/);
    return entry?.[1] === socket;
  });
}

async function crashAfterConnect(daemon, socket) {
  await waitFor("tack-hook connection", RUN_TIMEOUT_MS, () => hookConnected(socket));
  daemon.stop();

  const { signal } = await daemon.done;
  if (signal !== "SIGKILL") throw new Error("tack-daemon did not exit via SIGKILL");
}

async function runCrash(pi, tree, env, daemon, socket) {
  await waitFor("daemon socket", DAEMON_START_MS, () => {
    const stat = statSync(socket, { throwIfNoEntry: false });
    return stat?.isSocket() && (stat.mode & 0o777) === 0o600;
  });

  // Pause the real daemon before invoking Pi so it cannot reply before the kill.
  daemon.sendSignal("SIGSTOP");
  const status = "/proc/" + daemon.pid + "/status";
  await waitFor("stopped daemon", DAEMON_START_MS,
    () => /^State:\s+T\b/m.test(readOptional(status) ?? ""));

  const [session, crash] = await Promise.allSettled([
    runPi(pi, tree, env),
    crashAfterConnect(daemon, socket),
  ]);
  if (crash.status === "rejected") throw crash.reason;
  if (session.status === "rejected") throw session.reason;

  return session.value;
}

function ownProcess(pidFile, command) {
  const text = readOptional(pidFile)?.trim();
  if (!text || !/^[1-9]\d{0,9}$/.test(text)) return undefined;

  let cmdline;

  try {
    cmdline = readOptional("/proc/" + text + "/cmdline");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }

  if (!isDeepStrictEqual(cmdline?.split("\0"), [...command, ""])) return undefined;

  return Number(text);
}

async function stopOwned(pidFile, command) {
  const pid = ownProcess(pidFile, command);
  if (pid === undefined) return;

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (ownProcess(pidFile, command) !== pid) return;

    await delay(25);
  }

  throw new Error("test child did not exit: " + pid);
}

function textOf(content) {
  if (!Array.isArray(content)) return "";

  return content.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

function toolEvents(events, type, name) {
  return events.filter(({ event }) => event.type === type &&
    event.toolName === name && event.toolCallId === "call_" + name);
}

function checkSession(run, expected, check) {
  const events = run?.events ?? [];
  const last = events.filter(({ event }) => event.type === "message_end").at(-1)?.event.message;
  check("Pi completed with valid JSONL", run?.code === 0 && run.validJsonl &&
    !run.outputLimit && last?.role === "assistant" && last.stopReason === "stop" &&
    textOf(last.content) === "done", { exit: run?.code, signal: run?.signal, error: run?.spawnError });

  const entries = events.filter(({ event }) => event.type === "entry_appended")
    .map(({ event }) => [event.entry?.type, event.entry?.customType, event.entry?.data]);
  const extensionErrors = events.filter(({ event }) => event.type === "extension_error");
  const stderrErrors = run?.stderr.split("\n").filter((line) =>
    /^(?:Extension error\b|Error:)|Failed to load extension/i.test(line));
  check("exactly one tack-loaded entry and no extension errors",
    isDeepStrictEqual(entries, [["custom", "tack-loaded", {}]]) &&
      extensionErrors.length === 0 && stderrErrors?.length === 0,
    { entries, extensionErrors, stderrErrors });

  const toolEnds = events.filter(({ event }) => event.type === "tool_execution_end");
  const names = toolEnds.map(({ event }) => event.toolName);
  const expectedNames = expected.model === "normal" ? ["bash", "guard_status"] :
    expected.model === "bash" || expected.model === "harmless" ? ["bash"] : ["guard_status"];
  check("exact scripted tools finished", isDeepStrictEqual(names, expectedNames), names);
}

function checkBash(events, expected, check) {
  const [start] = toolEvents(events, "tool_execution_start", "bash");
  const [end] = toolEvents(events, "tool_execution_end", "bash");
  const text = textOf(end?.event.result?.content);
  check("bash denied: " + expected.bash, end?.event.isError === true &&
    text === expected.bash &&
    isDeepStrictEqual(start?.event.args, { command: "git push origin main" }), text);

  if (expected.name === "timeout") {
    const elapsed = start && end ? Math.round(end.at - start.at) : undefined;
    // Pi emits start before tool_call. Allow scheduling jitter in CI but fail
    // if the extension returns early or waits for the 15 s shim to exit.
    check("8500 ms hook deadline", elapsed >= 8_000 && elapsed <= 10_000, elapsed);
  }
}

function checkStatus(events, normal, check) {
  const [start] = toolEvents(events, "tool_execution_start", "guard_status");
  const [end] = toolEvents(events, "tool_execution_end", "guard_status");
  const text = textOf(end?.event.result?.content);

  if (normal) {
    check("guard_status: daemon ok", end?.event.isError === false &&
      text === "guard_status: daemon ok" && isDeepStrictEqual(start?.event.args, {}), text);
  } else {
    check("invalid guard_status: tack: malformed", end?.event.isError === true &&
      text === "tack: malformed" && isDeepStrictEqual(start?.event.args, { unexpected: true }), text);
  }
}

// The adapter lines each case expects: both calls in the normal case, the
// allowed Bash call in the harmless case, and none for a failure.
function expectedRecorder(expected) {
  if (expected.name === "normal") {
    return ["exact bash and guard_status tack-hook recorder lines", EXPECTED_RECORDER];
  }

  if (expected.allow) return ["exact bash tack-hook recorder line", [EXPECTED_RECORDER[0]]];

  return ["no tack-hook recorder lines", []];
}

function checkRecorders(tree, expected, check) {
  const recorder = readOptional(tree.recorder);
  const lines = recorder?.split("\n");
  const terminated = lines?.pop() === "";
  const pushes = lines?.filter((line) => /^push(?: |$)/.test(line));
  const calls = lines?.filter((line) => !/^push(?: |$)/.test(line));
  const [label, want] = expectedRecorder(expected);

  check("git shim recorded zero pushes", terminated && pushes?.length === 0, pushes);
  check(label, terminated && isDeepStrictEqual(calls, want), calls);
}

// What the stand-in model received as each bash result, one entry per request
// that carried one.
function modelSaw(tree) {
  const seen = [];

  for (const line of (readOptional(tree.requests) ?? "").split("\n")) {
    if (!line) continue;

    try {
      const outputs = JSON.parse(line).outputs;
      if (outputs && Object.hasOwn(outputs, "call_bash")) seen.push(outputs.call_bash);
    } catch {
      seen.push({ invalid: line });
    }
  }

  return seen;
}

// tack allowed the harmless command and it ran: the bash result is real git's
// output with no denial, the stand-in model received that same text, the
// wrapped shim logged one run with exit status 0, and the daemon logged
// exactly one allow. Pi may run git for itself; only the command's own
// arguments count.
function checkAllowed(tree, events, check) {
  const [start] = toolEvents(events, "tool_execution_start", "bash");
  const [end] = toolEvents(events, "tool_execution_end", "bash");
  const text = textOf(end?.event.result?.content);
  const args = HARMLESS.slice("git ".length);
  const runs = (readOptional(tree.gitRuns) ?? "").split("\n")
    .filter((line) => line.slice(line.indexOf(" ") + 1) === args);
  const lines = readOptional(path.join(tree.state, "daemon.log"))?.split("\n");
  const terminated = lines?.pop() === "";
  const seen = modelSaw(tree);

  // Pi returns the command's combined output as the text; git ends it with LF.
  check("bash allowed: " + HARMLESS + " ran with no denial", end?.event.isError === false &&
    isDeepStrictEqual(text.trimEnd().split("\n"), ["?? " + UNTRACKED]) &&
    isDeepStrictEqual(start?.event.args, { command: HARMLESS }), text);
  check("stand-in model saw the bash output", text !== "" && isDeepStrictEqual(seen, [text]),
    seen);
  check("git shim recorded " + HARMLESS + " executing once with exit status 0",
    isDeepStrictEqual(runs, ["0 " + args]), readOptional(tree.gitRuns));
  check("exact daemon log line: hook toolBefore allow", terminated &&
    isDeepStrictEqual(lines, ["tack-daemon: hook toolBefore allow"]), lines);
}

function checkCase(tree, run, expected, check) {
  const events = run?.events ?? [];
  const normal = expected.name === "normal";
  checkSession(run, expected, check);
  checkRecorders(tree, expected, check);
  if (expected.bash) checkBash(events, expected, check);
  if (expected.allow) checkAllowed(tree, events, check);
  if (expected.model === "normal" || expected.model === "invalid-tool") {
    checkStatus(events, normal, check);
  }

  const attempts = readOptional(tree.hookAttempts);
  if (expected.name === "invalid-guard-status") {
    check("invalid guard_status did not invoke tack-hook", attempts === "", attempts);
  } else if (hookShims.has(expected.name)) {
    check("failure shim invoked once", attempts === "invoked\n", attempts);
  }

  if (normal) {
    const lines = readOptional(path.join(tree.state, "daemon.log"))?.split("\n");
    const terminated = lines?.pop() === "";
    check("exact daemon log lines", terminated && isDeepStrictEqual(lines, [
      "tack-daemon: hook toolBefore deny push blocked",
      "tack-daemon: tool guard_status ok",
    ]), lines);
  }
}

function keepEvidence(tree, target) {
  mkdirSync(target, { recursive: true });

  for (const file of [tree.requests, tree.recorder, tree.hookAttempts, tree.gitRuns,
    path.join(tree.base, "pi-output.jsonl"), path.join(tree.base, "pi-stderr.log"),
    path.join(tree.base, "model-stderr.log"), path.join(tree.state, "daemon.log")]) {
    try {
      copyFileSync(file, path.join(target, path.basename(file)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function runCase(pi, expected, root, target, check) {
  const tree = layout(mkdtempSync(path.join(root, "tack-pi-")));
  const env = piEnv(tree);
  const socket = path.join(tree.state, "tack.sock");
  const daemonArgs = ["--socket", socket, "--plugin", pluginDir];
  let daemon;
  let model;
  let run;

  try {
    prepare(tree, env, expected);

    const { promise, resolve } = Promise.withResolvers();
    model = startChild(process.execPath, [path.join(here, "model.mjs"), expected.model, tree.requests],
      { cwd: tree.project, env }, (stdout) => {
        const end = stdout.indexOf("\n");
        if (end !== -1) resolve(stdout.slice(0, end));
      });

    writeConfig(tree.agent, await modelPort(model, promise));

    if (expected.name === "daemon-crash") {
      daemon = startChild(daemonBin, daemonArgs, { cwd: tree.project, env });
      run = await runCrash(pi, tree, env, daemon, socket);
    } else {
      run = await runPi(pi, tree, env);
    }
  } catch (error) {
    check("conformance session ran", false, String(error.stack ?? error));
  } finally {
    try {
      if (model) {
        model.stop();
        const result = await model.done;
        writeFileSync(path.join(tree.base, "model-stderr.log"), result.stderr);
      }

      checkCase(tree, run, expected, check);
    } finally {
      try {
        if (daemon) {
          daemon.stop();
          const result = await daemon.done;
          writeFileSync(path.join(tree.state, "daemon.log"), result.stdout + result.stderr);
        }

        await stopOwned(path.join(tree.state, "tack.lock"), [daemonBin, ...daemonArgs]);
        await stopOwned(tree.sleepPid, ["/bin/sleep", "15"]);
      } finally {
        try {
          keepEvidence(tree, target);
        } finally {
          rmSync(tree.base, { recursive: true, force: true });
        }
      }
    }
  }
}

async function main() {
  if (process.platform !== "linux") throw new Error("Pi conformance requires disposable Linux");

  const pi = findExecutable("pi", process.env.PATH ?? "");
  if (!pi) throw new Error("pi is not on PATH");

  const root = process.env.RUNNER_TEMP ?? tmpdir();
  const artifacts = process.env.TACK_PI_ARTIFACTS ?? path.join(repoRoot, "target", "pi-conformance");
  mkdirSync(artifacts, { recursive: true });

  const rows = [];
  const caseRows = new Map();
  let failed = false;

  for (const expected of cases) {
    const own = [];
    caseRows.set(expected.name, own);
    const check = (label, ok, evidence) => {
      failed ||= ok !== true;
      const row = (ok === true ? "PASS " : "FAIL ") + expected.name + ": " + label;
      rows.push(row);
      own.push(row);
      console.log(row);
      if (ok !== true) console.error("  evidence: " + JSON.stringify(evidence)?.slice(0, 4000));
    };

    try {
      await runCase(pi, expected, root, path.join(artifacts, expected.name), check);
    } catch (error) {
      check("conformance evidence and cleanup", false, String(error.stack ?? error));
    }
  }

  // Its own row: every check of the harmless case passed, and it ran some.
  const harmless = caseRows.get("harmless") ?? [];
  const allowed = harmless.length > 0 && harmless.every((row) => row.startsWith("PASS "));
  const allowedRow = "harmless_allowed=" + allowed;
  console.log(allowedRow);
  writeFileSync(path.join(artifacts, "verdict.txt"), [...rows, allowedRow].join("\n") + "\n");

  return failed || !allowed ? 1 : 0;
}

process.exitCode = await main();
