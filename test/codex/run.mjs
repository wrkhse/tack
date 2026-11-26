// Run only in Linux CI, inside a network namespace that holds loopback alone.
// Each case builds the Codex adapter with the real tack CLI into throwaway
// CODEX_HOME, HOME and XDG folders, reads Codex's own view of the hooks it
// will load through `codex app-server`, then runs `codex exec --json`
// against a loopback Responses stand-in. No run passes a trust bypass.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const here = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const daemonBin = path.join(repoRoot, "target", "debug", "tack-daemon");
const hookBin = path.join(repoRoot, "target", "debug", "tack-hook");
const pluginDir = realpathSync(path.join(repoRoot, "fixtures", "safe-push"));
const gitShim = path.join(repoRoot, "test", "claude", "git-shim");

const MODEL_START_MS = 10_000;
const DAEMON_START_MS = 5_000;
const BUILD_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 30_000;
const DIRECT_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
const MAX_TREE_ENTRIES = 256;
const PUSH = "git push origin main";
// The command tack allows in the harmless case, and the untracked file whose
// `?? ` line in its output shows the real git ran in the project.
const HARMLESS = "git status --short";
const UNTRACKED = "harmless.txt";
// Codex leaves additionalContextLimit out of the hash at its default.
const DEFAULT_CONTEXT_LIMIT = 2500;
// What the adapter appends to TACK_RECORDER: the SessionStart load marker,
// then one line for each call the daemon answered.
const ADAPTER_LINES = {
  loaded: '{"call":"tack-loaded"}',
  bash: '{"call":"bash","id":1}',
  allow: '{"call":"bash","id":1}',
  status: '{"call":"guard_status","id":1}',
};
// What the hook recorder logs for each verdict tack-hook returned.
const VERDICT_LINES = {
  bash: '{"request":"hook","hook":"toolBefore","outcome":"deny"}',
  allow: '{"request":"hook","hook":"toolBefore","outcome":"allow"}',
  status: '{"request":"tool","name":"guard_status","outcome":"tool"}',
};

// session: a full codex exec run. direct: the PreToolUse command run as
// Codex runs it, with no model. detect: a broken install the trust and load
// assertions must catch. allow: the Bash command tack lets run.
const cases = [
  {
    name: "normal",
    kind: "session",
    model: "normal",
    hook: "real",
    rebuild: true,
    bash: "tack: push blocked",
    status: "ok",
  },
  {
    name: "harmless",
    kind: "session",
    model: "harmless",
    hook: "real",
    allow: HARMLESS,
  },
  {
    name: "missing-hook",
    kind: "session",
    model: "bash",
    hook: "missing",
    bash: "tack: hook_missing",
  },
  {
    name: "daemon-crash",
    kind: "session",
    model: "bash",
    hook: "real",
    crash: true,
    bash: "tack: socket_closed",
  },
  {
    name: "timeout",
    kind: "session",
    model: "bash",
    hook: "sleep",
    bash: "tack: timeout",
  },
  {
    name: "invalid-reply",
    kind: "session",
    model: "bash",
    hook: "garbage",
    bash: "tack: malformed_reply",
  },
  {
    name: "invalid-guard-status",
    kind: "session",
    model: "invalid-tool",
    hook: "real",
    status: "invalid",
  },
  {
    name: "mcp-start-failure",
    kind: "session",
    model: "bash",
    hook: "real",
    mcpBroken: true,
    bash: "tack: push blocked",
  },
  {
    name: "node-missing",
    kind: "direct",
    node: "missing",
    hook: "real",
    reason: "tack: node_missing",
  },
  {
    name: "node-crash",
    kind: "direct",
    node: "crash",
    hook: "real",
    reason: "tack: node_failed",
  },
  {
    name: "stale-trust",
    kind: "detect",
    model: "bash",
    hook: "real",
    tamper: "stale",
  },
  {
    name: "config-parse-error",
    kind: "detect",
    model: "bash",
    hook: "real",
    tamper: "parse",
  },
];

const EVENT_LABELS = new Map([
  ["preModelRequest", "pre_model_request"],
  ["postModelRequest", "post_model_request"],
  ["preToolUse", "pre_tool_use"],
  ["permissionRequest", "permission_request"],
  ["postToolUse", "post_tool_use"],
  ["preCompact", "pre_compact"],
  ["postCompact", "post_compact"],
  ["sessionStart", "session_start"],
  ["sessionEnd", "session_end"],
  ["userPromptSubmit", "user_prompt_submit"],
  ["subagentStart", "subagent_start"],
  ["subagentStop", "subagent_stop"],
  ["stop", "stop"],
  ["interrupt", "interrupt"],
]);

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
  const home = path.join(base, "home");
  const xdgState = path.join(home, ".local", "state");

  return {
    base,
    home,
    codexHome: path.join(base, "codex-home"),
    config: path.join(base, "xdg-config"),
    data: path.join(base, "xdg-data"),
    cache: path.join(base, "xdg-cache"),
    xdgState,
    // tack's state folder by every route tack-hook resolves it: TACK_STATE_DIR,
    // XDG_STATE_HOME/tack and HOME/.local/state/tack name the same folder, so
    // an MCP server started with a reduced environment still finds the daemon.
    state: path.join(xdgState, "tack"),
    tmp: path.join(base, "tmp"),
    bin: path.join(base, "bin"),
    project: path.join(base, "project"),
    distA: path.join(base, "dist-a"),
    distB: path.join(base, "dist-b"),
    requests: path.join(base, "requests.jsonl"),
    recorder: path.join(base, "recorder.log"),
    hookCalls: path.join(base, "hook-calls.log"),
    hookAttempts: path.join(base, "hook-attempts.log"),
    gitShim: path.join(base, "git-shim"),
    gitRuns: path.join(base, "git-runs.log"),
    sleepPid: path.join(base, "sleep.pid"),
  };
}

function xdgEnv(tree) {
  return {
    HOME: tree.home,
    CODEX_HOME: tree.codexHome,
    XDG_CONFIG_HOME: tree.config,
    XDG_DATA_HOME: tree.data,
    XDG_STATE_HOME: tree.xdgState,
    XDG_CACHE_HOME: tree.cache,
  };
}

function codexEnv(tree) {
  return {
    ...xdgEnv(tree),
    PATH: [tree.bin, "/usr/bin", "/bin"].join(path.delimiter),
    TMPDIR: tree.tmp,
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    CODEX_API_KEY: "dummy",
    OPENAI_API_KEY: "dummy",
    TACK_STATE_DIR: tree.state,
    TACK_DAEMON_BIN: daemonBin,
    TACK_RECORDER: tree.recorder,
    TACK_REAL_GIT: "/usr/bin/git",
    TACK_TEST_HOOK_ATTEMPTS: tree.hookAttempts,
    TACK_TEST_SLEEP_PID: tree.sleepPid,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
  };
}

// Session flags, not user config: feedback and metrics stay off and an
// optional MCP server is waited for, not skipped. Analytics and update checks
// are off in tack's generated config. The model is a custom Responses
// provider on the loopback stand-in, over plain HTTP: the built-in openai
// provider uses the Responses websocket, and a custom one does only when
// supports_websockets is set.
function sessionFlags(port) {
  const flags = [
    "feedback.enabled=false",
    'otel.metrics_exporter="none"',
    "mcp_optional_startup_grace_ms=0",
    'web_search="disabled"',
  ];

  if (port !== undefined) {
    flags.push(
      'model_provider="loopback"',
      'model_providers.loopback.name="loopback"',
      'model_providers.loopback.base_url="http://127.0.0.1:' + port + '/v1"',
      'model_providers.loopback.env_key="CODEX_API_KEY"',
      'model_providers.loopback.wire_api="responses"',
      "model_providers.loopback.supports_websockets=false",
    );
  }

  return flags.flatMap((flag) => ["-c", flag]);
}

function initProject(tree, env) {
  function git(...args) {
    const result = spawnSync(env.TACK_REAL_GIT, args, {
      cwd: tree.project,
      env,
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });

    if (result.error) throw result.error;

    if (result.status !== 0) {
      throw new Error("git " + args.join(" ") + ": " + result.stderr);
    }
  }

  const origin = path.join(tree.base, "origin.git");
  git("init", "--initial-branch=main");
  git(
    "-c",
    "user.name=Codex conformance",
    "-c",
    "user.email=codex@example.invalid",
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "-m",
    "Fixture",
  );
  git("clone", "--bare", ".", origin);
  git("remote", "add", "origin", origin);
  git("fetch", "origin", "refs/heads/main:refs/remotes/origin/main");
  git("branch", "--set-upstream-to=origin/main", "main");
}

// The hook recorder runs as tack-hook first on PATH. It passes the call to
// the real tack-hook unchanged, logs every invocation to the attempts file,
// and logs one line to the calls file for each verdict the daemon gave.
// Every path is written in, since an MCP server may run with a reduced
// environment. It is CommonJS so Node runs it without a file extension.
const RECORDER_BODY = String.raw`
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const LIMIT = 2 * 1024 * 1024;
const input = [];
let size = 0;

appendFileSync(ATTEMPTS, "invoked\n");

process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size > LIMIT) process.exit(70);
  input.push(chunk);
});
process.stdin.on("end", () => relay(Buffer.concat(input)));

function relay(stdin) {
  const child = spawn(REAL, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"] });
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

function recorderSource(attempts, calls) {
  const values = [
    "const REAL = " + JSON.stringify(hookBin) + ";",
    "const ATTEMPTS = " + JSON.stringify(attempts) + ";",
    "const CALLS = " + JSON.stringify(calls) + ";",
  ];

  return [
    "#!" + process.execPath,
    '"use strict";',
    ...values,
    RECORDER_BODY,
  ].join("\n");
}

const hookShims = new Map([
  ["sleep", 'echo "$$" > "$TACK_TEST_SLEEP_PID"\nexec /bin/sleep 15'],
  ["garbage", "printf '%s\\n' 'not JSON'"],
]);

function installHook(tree, env, mode) {
  const hook = path.join(tree.bin, "tack-hook");

  if (mode === "real") {
    accessSync(hookBin, constants.X_OK);
    writeFileSync(hook, recorderSource(tree.hookAttempts, tree.hookCalls), {
      mode: 0o755,
    });
    return;
  }

  if (mode === "missing") {
    // The isolated PATH omits target/debug; a dangling link exercises ENOENT,
    // not a binary that started and returned a failing exit code.
    symlinkSync(path.join(tree.bin, "absent"), hook);
    if (findExecutable("tack-hook", env.PATH))
      throw new Error("tack-hook is not absent");

    return;
  }

  const script = hookShims.get(mode);
  if (!script) throw new Error("no shim for " + mode);

  writeFileSync(
    hook,
    '#!/bin/sh\nprintf "%s\\n" invoked >> "$TACK_TEST_HOOK_ATTEMPTS"\n' +
      script +
      "\n",
    { mode: 0o755 },
  );
}

function installNode(tree, env, mode) {
  const node = path.join(tree.bin, "node");

  if (mode === "missing") {
    if (findExecutable("node", env.PATH))
      throw new Error("node is on the isolated PATH");

    return;
  }

  if (mode === "crash") {
    writeFileSync(node, "#!/bin/sh\nkill -SEGV $$\n", { mode: 0o755 });
    return;
  }

  symlinkSync(process.execPath, node);
}

function shellQuote(text) {
  return "'" + text.replaceAll("'", "'\\''") + "'";
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
  writeFileSync(
    git,
    "#!/bin/sh\n" +
      shellQuote(tree.gitShim) +
      ' "$@"\nstatus=$?\n' +
      'printf \'%s %s\\n\' "$status" "$*" >> ' +
      shellQuote(tree.gitRuns) +
      '\nexit "$status"\n',
    { mode: 0o755 },
  );
}

function prepare(tree, env, expected) {
  for (const dir of [
    tree.home,
    tree.codexHome,
    tree.config,
    tree.data,
    tree.cache,
    tree.tmp,
    tree.bin,
    tree.project,
  ]) {
    mkdirSync(dir, { mode: 0o700 });
  }

  mkdirSync(tree.state, { recursive: true, mode: 0o700 });
  chmodSync(tree.state, 0o700);
  writeFileSync(tree.recorder, "");
  writeFileSync(tree.hookCalls, "");
  writeFileSync(tree.hookAttempts, "");

  installGit(tree, expected);
  installNode(tree, env, expected.node);
  installHook(tree, env, expected.hook);
  initProject(tree, env);
  if (expected.allow)
    writeFileSync(path.join(tree.project, UNTRACKED), "untracked\n");
}

function tackBuild(tack, tree, out) {
  const result = spawnSync(
    tack,
    ["build", pluginDir, "--out", out, "--target", "codex"],
    {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...xdgEnv(tree) },
      encoding: "utf8",
      timeout: BUILD_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );

  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// Every entry under dir as a sorted relative path, directories with a
// trailing slash, bounded so a runaway build cannot make the walk unbounded.
function entries(dir) {
  const found = readdirSync(dir, { recursive: true, withFileTypes: true });
  if (found.length > MAX_TREE_ENTRIES)
    throw new Error(dir + " holds over " + MAX_TREE_ENTRIES);

  return found
    .map((entry) => {
      const relative = path.relative(
        dir,
        path.join(entry.parentPath, entry.name),
      );
      return entry.isDirectory() ? relative + "/" : relative;
    })
    .sort();
}

// Before any Codex process runs, the throwaway folders hold only what tack
// build wrote into Codex's user config and the empty tack state folder.
function checkPristine(tree, check) {
  const found = {
    home: entries(tree.home),
    codexHome: entries(tree.codexHome),
    xdg: [tree.config, tree.data, tree.cache].flatMap(entries),
  };
  const codexOk =
    found.codexHome.includes("config.toml") &&
    found.codexHome.every((file) =>
      ["config.toml", "hooks.json", "tack-hashes"].includes(file),
    );

  check(
    "throwaway folders hold only tack's generated config and state",
    codexOk &&
      found.xdg.length === 0 &&
      isDeepStrictEqual(found.home, [
        ".local/",
        ".local/state/",
        ".local/state/tack/",
      ]),
    found,
  );
}

// The user step tack's build leaves: its generated config.toml fragment goes
// at the top of Codex's config.toml, before any table there. A fragment from
// an earlier build is taken off first.
function installFragment(tree, out, previous, check) {
  const fragment = readFileSync(path.join(out, "codex", "config.toml"), "utf8");
  const configPath = path.join(tree.codexHome, "config.toml");
  const config = readFileSync(configPath, "utf8");
  const lines = fragment.split("\n");

  if (previous !== undefined && !config.startsWith(previous)) {
    throw new Error("tack build moved the generated fragment in " + configPath);
  }

  const analytics = lines.indexOf("[analytics]");
  check(
    "generated config turns analytics and update checks off",
    lines.includes("check_for_update_on_startup = false") &&
      analytics !== -1 &&
      lines[analytics + 1] === "enabled = false" &&
      lines.includes("[mcp_servers.tack]"),
    fragment,
  );
  writeFileSync(
    configPath,
    fragment + "\n" + config.slice(previous?.length ?? 0),
  );

  return fragment + "\n";
}

function startChild(bin, args, options, onStdout) {
  const child = spawn(bin, args, {
    ...options,
    stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
  });
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

  // A detached child's group may outlive it, such as an MCP server or a hook
  // a killed Codex left behind; the group is killed once the child is gone.
  function reap() {
    if (!options.detached || child.pid === undefined) return;

    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
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

  child.stdin?.on("error", () => {});
  child.once("error", (error) => {
    spawnError = error.message;
  });
  const done = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ ...output, code, signal, spawnError });
    });
  });

  return { pid: child.pid, stdin: child.stdin, sendSignal, stop, reap, done };
}

// Codex JSONL and app-server JSON-RPC are framed by LF only.
function lineReader(onLine) {
  let offset = 0;

  return {
    collect(stdout) {
      for (
        let end = stdout.indexOf("\n", offset);
        end !== -1;
        end = stdout.indexOf("\n", offset)
      ) {
        const line = stdout.slice(offset, end);
        offset = end + 1;
        onLine(line);
      }
    },
    complete: (stdout) => offset === stdout.length,
  };
}

// Codex's own view of the hooks it loads for the project: each hook's key,
// enabled flag, trust status and current hash, from app-server hooks/list.
async function listHooks(codexJs, tree, env) {
  const messages = [];
  const { promise, resolve } = Promise.withResolvers();
  const reader = lineReader((line) => {
    try {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.id === 2) resolve(message);
    } catch {
      messages.push({ invalid: line });
    }
  });
  const child = startChild(
    process.execPath,
    [codexJs, ...sessionFlags(), "app-server"],
    { cwd: tree.project, env, detached: true, stdin: "pipe" },
    reader.collect,
  );
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const timer = setTimeout(() => resolve({ timeout: true }), LIST_TIMEOUT_MS);

  try {
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "tack_conformance", title: null, version: "0.0.0" },
      },
    });
    send({ method: "initialized" });
    send({ id: 2, method: "hooks/list", params: { cwds: [tree.project] } });

    const exited = child.done.then((run) => ({
      exited: run.code,
      stderr: run.stderr,
    }));
    const reply = await Promise.race([promise, exited]);
    writeFileSync(
      path.join(tree.base, "hooks-list.jsonl"),
      JSON.stringify(reply) + "\n",
      { flag: "a" },
    );

    return { reply, messages };
  } finally {
    clearTimeout(timer);
    child.stop();
    const run = await child.done;
    child.reap();
    writeFileSync(path.join(tree.base, "app-server-stderr.log"), run.stderr, {
      flag: "a",
    });
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

// Codex's trust hash of one command handler: the normalized identity as TOML
// would hold it (no null fields), as sorted compact JSON, under SHA-256.
function hookHash(hook) {
  const handler = {
    type: "command",
    command: hook.command,
    timeout: hook.timeoutSec,
    async: hook.async ?? false,
  };
  if (hook.statusMessage != null) handler.statusMessage = hook.statusMessage;

  const limit = hook.additionalContextLimit;
  if (limit != null && limit !== DEFAULT_CONTEXT_LIMIT)
    handler.additionalContextLimit = limit;

  const identity = {
    event_name: EVENT_LABELS.get(hook.eventName),
    hooks: [handler],
  };
  if (hook.matcher != null) identity.matcher = hook.matcher;

  const json = JSON.stringify(sortKeys(identity));
  return "sha256:" + createHash("sha256").update(json, "utf8").digest("hex");
}

function matchesBash(matcher) {
  if (matcher == null || matcher === "" || matcher === "*") return true;

  try {
    return new RegExp("^(?:" + matcher + ")$").test("Bash");
  } catch {
    return false;
  }
}

function hookProblems(hook, home, outs) {
  const label = EVENT_LABELS.get(hook.eventName);
  const prefix = hook.sourcePath + ":" + label + ":";
  const problems = [];
  const keyTail = hook.key?.startsWith(prefix)
    ? hook.key.slice(prefix.length)
    : undefined;

  if (!keyTail || !/^\d+:\d+$/.test(keyTail)) problems.push("key " + hook.key);
  if (hook.source !== "user" || hook.isManaged !== false)
    problems.push("source " + hook.source);
  if (path.dirname(hook.sourcePath) !== home)
    problems.push("source path " + hook.sourcePath);
  if (
    hook.handlerType !== "command" ||
    !outs.some((out) => hook.command?.includes(out))
  ) {
    problems.push(
      "handler " + JSON.stringify(hook.command ?? hook.handlerType),
    );
  }
  if (hook.enabled !== true) problems.push("disabled");
  if (hook.trustStatus !== "trusted")
    problems.push("trust " + hook.trustStatus);
  if (hook.handlerType === "command" && hook.currentHash !== hookHash(hook)) {
    problems.push("hash " + hook.currentHash + " != " + hookHash(hook));
  }

  return problems.map((problem) => hook.key + ": " + problem);
}

// Every listed hook is tack's: CODEX_HOME held nothing before tack build.
// Each must be enabled and trusted under the hash Codex computes, one
// PreToolUse handler must match Bash and one SessionStart handler must load.
function trustProblems(listing, tree, out) {
  const data = listing.reply?.result?.data;
  if (!Array.isArray(data) || data.length !== 1) {
    return ["hooks/list: " + JSON.stringify(listing.reply).slice(0, 2000)];
  }

  const { hooks, warnings, errors } = data[0];
  const home = realpathSync(tree.codexHome);
  const outs = [out, realpathSync(out)];
  const problems = hooks.flatMap((hook) => hookProblems(hook, home, outs));
  const keys = hooks.map((hook) => hook.key);
  const guards = hooks.filter(
    (hook) => hook.eventName === "preToolUse" && matchesBash(hook.matcher),
  );
  const starts = hooks.filter((hook) => hook.eventName === "sessionStart");

  if (warnings.length > 0 || errors.length > 0)
    problems.push("warnings " + JSON.stringify({ warnings, errors }));
  if (new Set(keys).size !== keys.length)
    problems.push("duplicate keys " + JSON.stringify(keys));
  if (guards.length !== 1)
    problems.push(guards.length + " PreToolUse handlers match Bash");
  if (starts.length !== 1)
    problems.push(starts.length + " SessionStart handlers");

  return problems;
}

function hooksOf(listing) {
  return listing.reply?.result?.data?.[0]?.hooks ?? [];
}

async function startModel(tree, env, script) {
  const { promise, resolve } = Promise.withResolvers();
  const model = startChild(
    process.execPath,
    [path.join(here, "model.mjs"), script, tree.requests],
    { cwd: tree.project, env },
    (stdout) => {
      const end = stdout.indexOf("\n");
      if (end !== -1) resolve(stdout.slice(0, end));
    },
  );
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("model did not report its port")),
      MODEL_START_MS,
    );
  });
  const exit = model.done.then((run) => {
    throw new Error(
      "model exited before ready: " + (run.spawnError ?? run.stderr),
    );
  });

  try {
    const line = await Promise.race([promise, deadline, exit]);
    const port = Number(line);
    if (!/^[1-9]\d{0,4}$/.test(line) || port > 65535)
      throw new Error("invalid port: " + line);

    return { model, port };
  } catch (error) {
    model.stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runCodex(codexJs, tree, env, port) {
  const events = [];
  const invalid = [];
  const reader = lineReader((line) => {
    try {
      const event = JSON.parse(line);
      if (typeof event?.type !== "string")
        throw new Error("missing event type");

      events.push(event);
    } catch {
      invalid.push(line);
    }
  });
  const args = [
    codexJs,
    ...sessionFlags(port),
    "exec",
    "--json",
    "--sandbox",
    "danger-full-access",
    "-m",
    "scripted",
    "push my branch",
  ];
  const child = startChild(
    process.execPath,
    args,
    { cwd: tree.project, env, detached: true },
    reader.collect,
  );
  const timer = setTimeout(child.stop, RUN_TIMEOUT_MS);

  try {
    const run = await child.done;
    writeFileSync(path.join(tree.base, "codex-output.jsonl"), run.stdout);
    writeFileSync(path.join(tree.base, "codex-stderr.log"), run.stderr);

    return {
      ...run,
      events,
      validJsonl: invalid.length === 0 && reader.complete(run.stdout),
    };
  } finally {
    clearTimeout(timer);
    child.reap();
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
    const entry = row.match(
      /^\S+\s+\S+\s+\S+\s+00000000\s+0001\s+02\s+0 (.*)$/,
    );
    return entry?.[1] === socket;
  });
}

async function crashAfterConnect(daemon, socket) {
  await waitFor("tack-hook connection", RUN_TIMEOUT_MS, () =>
    hookConnected(socket),
  );
  daemon.stop();

  const { signal } = await daemon.done;
  if (signal !== "SIGKILL")
    throw new Error("tack-daemon did not exit via SIGKILL");
}

async function runCrash(codexJs, tree, env, port, daemon, socket) {
  await waitFor("daemon socket", DAEMON_START_MS, () => {
    const stat = statSync(socket, { throwIfNoEntry: false });
    return stat?.isSocket() && (stat.mode & 0o777) === 0o600;
  });

  // Pause the real daemon before Codex starts so it cannot reply before the kill.
  daemon.sendSignal("SIGSTOP");
  const status = "/proc/" + daemon.pid + "/status";
  await waitFor("stopped daemon", DAEMON_START_MS, () =>
    /^State:\s+T\b/m.test(readOptional(status) ?? ""),
  );

  const [session, crash] = await Promise.allSettled([
    runCodex(codexJs, tree, env, port),
    crashAfterConnect(daemon, socket),
  ]);
  if (crash.status === "rejected") throw crash.reason;
  if (session.status === "rejected") throw session.reason;

  return session.value;
}

// A pid from a pid file, only while it still runs a command with the given
// leading arguments, so a reused pid is never signalled.
function ownProcess(pidFile, prefix) {
  const text = readOptional(pidFile)?.trim();
  if (!text || !/^[1-9]\d{0,9}$/.test(text)) return undefined;

  const cmdline = readOptional("/proc/" + text + "/cmdline")?.split("\0");
  if (!isDeepStrictEqual(cmdline?.slice(0, prefix.length), prefix))
    return undefined;

  return Number(text);
}

async function stopOwned(pidFile, prefix) {
  const pid = ownProcess(pidFile, prefix);
  if (pid === undefined) return;

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (ownProcess(pidFile, prefix) !== pid) return;

    await delay(25);
  }

  throw new Error("test child did not exit: " + pid);
}

// The PreToolUse command run as Codex runs a command hook, with `$SHELL -lc`
// and the hook input on stdin, here with no model in the loop.
function runPreToolUse(command, tree, env) {
  const input = {
    session_id: "conformance",
    transcript_path: null,
    cwd: tree.project,
    hook_event_name: "PreToolUse",
    model: "scripted",
    permission_mode: "bypassPermissions",
    turn_id: "turn-1",
    tool_name: "Bash",
    tool_input: { command: PUSH },
    tool_use_id: "call_bash",
  };

  return spawnSync(env.SHELL, ["-lc", command], {
    cwd: tree.project,
    env,
    input: JSON.stringify(input) + "\n",
    encoding: "utf8",
    timeout: DIRECT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_CHARS,
  });
}

// Changes one handler of the PreToolUse group after tack wrote its trust, as a
// changed rebuild would without the trust rewrite, or breaks the file's syntax.
function tamper(sourcePath, mode) {
  const text = readFileSync(sourcePath, "utf8");

  if (mode === "parse") {
    writeFileSync(
      sourcePath,
      text + (sourcePath.endsWith(".json") ? "\n{\n" : "\n[[[\n"),
    );
    return;
  }

  if (sourcePath.endsWith(".json")) {
    const file = JSON.parse(text);
    const handler = file.hooks.PreToolUse[0].hooks[0];
    handler.timeout = (handler.timeout ?? 600) + 1;
    writeFileSync(sourcePath, JSON.stringify(file, null, 2) + "\n");
    return;
  }

  const header = "[[hooks.PreToolUse.hooks]]";
  const at = text.indexOf(header);
  if (at === -1) throw new Error("no " + header + " in " + sourcePath);

  const end = at + header.length;
  writeFileSync(
    sourcePath,
    text.slice(0, end) + '\nstatusMessage = "tampered"' + text.slice(end),
  );
}

// Routes through any interface but loopback, from this process's own network
// namespace. /proc/net follows the namespace; /sys/class/net does not.
function outboundRoutes() {
  const ipv4 = (readOptional("/proc/net/route") ?? "")
    .split("\n")
    .slice(1)
    .map((row) => row.trim().split(/\s+/)[0]);
  const ipv6 = (readOptional("/proc/net/ipv6_route") ?? "")
    .split("\n")
    .map((row) => row.trim().split(/\s+/).at(-1));

  return [...ipv4, ...ipv6].filter((iface) => iface && iface !== "lo");
}

// Inside the CI namespace this process sees only loopback, no route leaves it,
// and an outbound connect fails at once.
async function checkOffline(check) {
  const interfaces = Object.keys(networkInterfaces()).sort();
  const routes = outboundRoutes();
  const refused = await new Promise((resolve) => {
    const socket = net.connect({
      host: "192.0.2.1",
      port: 443,
      timeout: 2_000,
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => resolve(error.code));
  });

  check(
    "only loopback, no route off it, and outbound connections refused",
    process.env.TACK_CODEX_OFFLINE === "1" &&
      isDeepStrictEqual(interfaces, ["lo"]) &&
      routes.length === 0 &&
      typeof refused === "string",
    { interfaces, routes, refused, flag: process.env.TACK_CODEX_OFFLINE },
  );
}

function readRequests(tree) {
  const text = readOptional(tree.requests) ?? "";

  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { invalid: line };
      }
    });
}

function responsesRequests(requests) {
  return requests.filter(
    (request) => request.path === "/v1/responses" && !request.error,
  );
}

// The reason Codex gave the model for a blocked Bash call, from the output
// the next Responses request carries.
function blockReason(requests) {
  const output = requests
    .map((request) => request.outputs?.call_bash)
    .find((text) => typeof text === "string");
  const match = /blocked by PreToolUse hook: (.*)\. (?:Command|Tool): /s.exec(
    output ?? "",
  );

  return { output, reason: match?.[1] };
}

function statusCalls(events) {
  return events
    .filter(
      (event) =>
        event.type === "item.completed" &&
        event.item?.type === "mcp_tool_call" &&
        event.item.tool === "guard_status",
    )
    .map((event) => event.item);
}

function itemText(item) {
  if (typeof item?.error?.message === "string") return item.error.message;

  return (item?.result?.content ?? [])
    .map((part) => part?.text ?? "")
    .join("\n");
}

function checkSession(run, check) {
  const events = run.events;
  const failures = events.filter(
    (event) => event.type === "turn.failed" || event.type === "error",
  );
  const messages = events.filter(
    (event) =>
      event.type === "item.completed" && event.item?.type === "agent_message",
  );

  check(
    "Codex completed with valid JSONL and the final text done",
    run.code === 0 &&
      run.validJsonl &&
      !run.outputLimit &&
      failures.length === 0 &&
      messages.at(-1)?.item.text === "done" &&
      events.at(-1)?.type === "turn.completed",
    {
      exit: run.code,
      signal: run.signal,
      error: run.spawnError,
      failures,
      last: events.at(-1),
      stderr: run.stderr.split("\n").slice(-20),
    },
  );
}

function checkStatus(calls, expected, check) {
  const [call] = calls;
  const text = itemText(call);

  if (expected === "ok") {
    check(
      "guard_status: daemon ok",
      calls.length === 1 &&
        call.server === "tack" &&
        call.status === "completed" &&
        isDeepStrictEqual(call.arguments, {}) &&
        text === "guard_status: daemon ok",
      calls,
    );
  } else {
    check(
      "invalid guard_status fails with tack: malformed",
      calls.length === 1 &&
        call.server === "tack" &&
        call.status === "failed" &&
        isDeepStrictEqual(call.arguments, { unexpected: true }) &&
        text === "tack: malformed",
      calls,
    );
  }
}

// Codex may stop before the model when the required tack MCP server fails, or
// run on without it. Either way it names the failure and nothing is pushed;
// a run that goes on blocks the push and never offers guard_status.
function checkMcpFailure(run, requests, outcome, check) {
  const text = [
    run.stderr,
    ...run.events.map((event) => JSON.stringify(event)),
  ].join("\n");
  const named = text
    .split("\n")
    .filter((line) => /mcp/i.test(line) && /\btack\b/.test(line));
  const offered = requests
    .flatMap((request) => request.tools ?? [])
    .filter((name) => /guard_status/.test(name));
  const messages = run.events.filter(
    (event) =>
      event.type === "item.completed" && event.item?.type === "agent_message",
  );
  const stopped =
    run.code !== 0 && !run.outputLimit && outcome.calls.length === 0;
  const ranOn =
    run.code === 0 &&
    run.validJsonl &&
    outcome.reason === "tack: push blocked" &&
    offered.length === 0 &&
    outcome.calls.length === 0 &&
    messages.at(-1)?.item.text === "done";

  check("Codex names the tack MCP server's start failure", named.length > 0, {
    exit: run.code,
    stderr: run.stderr.split("\n").slice(-20),
  });
  check(
    "Codex stopped, or ran on with the push blocked and no guard_status",
    stopped || ranOn,
    {
      exit: run.code,
      reason: outcome.reason,
      offered,
      calls: outcome.calls.length,
    },
  );

  return stopped;
}

// TACK_RECORDER holds the git shim's push lines and the adapter's lines: one
// SessionStart marker and one line for each call the daemon answered. The
// hook recorder holds the verdicts the real tack-hook returned.
function checkRecorders(tree, observed, stopped, check) {
  const lines = (readOptional(tree.recorder) ?? "\n").split("\n");
  const terminated = lines.pop() === "";
  const pushes = lines.filter((line) => /^push(?: |$)/.test(line));
  const adapter = lines.filter((line) => !/^push(?: |$)/.test(line));
  const markers = adapter.filter((line) => line === ADAPTER_LINES.loaded);
  const calls = adapter.filter((line) => line !== ADAPTER_LINES.loaded);
  const verdicts = (readOptional(tree.hookCalls) ?? "").split("\n");
  verdicts.pop();

  check(
    "git shim recorded zero pushes",
    terminated && pushes.length === 0,
    pushes,
  );
  // A Codex that stopped at startup may stop before SessionStart runs.
  check(
    "exactly one SessionStart marker from tack's handlers",
    markers.length === 1 || (stopped && markers.length === 0),
    adapter,
  );
  check(
    "adapter recorder lines match the successful calls one for one",
    isDeepStrictEqual(
      calls,
      observed.map((call) => ADAPTER_LINES[call]),
    ),
    adapter,
  );
  check(
    "tack-hook verdict lines match the successful calls one for one",
    isDeepStrictEqual(
      verdicts,
      observed.map((call) => VERDICT_LINES[call]),
    ),
    verdicts,
  );
}

function checkTimeout(requests, check) {
  const index = requests.findIndex((request) => request.reply === "call_bash");
  const next = requests
    .slice(index + 1)
    .find((request) => "call_bash" in (request.outputs ?? {}));
  const elapsed =
    index === -1 || !next ? undefined : next.at - requests[index].at;

  // The relay names the timeout before the 15 s shim exits.
  check(
    "timeout returned before the stalled tack-hook exited",
    elapsed < 14_000,
    elapsed,
  );
}

function checkCase(tree, run, expected, check) {
  const requests = responsesRequests(readRequests(tree));
  const { output, reason } = blockReason(requests);
  const calls = statusCalls(run.events);
  const statusOk =
    expected.status === "ok" &&
    calls.length === 1 &&
    itemText(calls[0]) === "guard_status: daemon ok" &&
    calls[0].status === "completed";

  let stopped = false;

  if (expected.mcpBroken) {
    stopped = checkMcpFailure(run, requests, { reason, calls }, check);
  } else {
    checkSession(run, check);
  }

  if (expected.bash && !expected.mcpBroken)
    check("bash denied: " + expected.bash, reason === expected.bash, {
      output,
    });
  if (expected.name === "timeout") checkTimeout(requests, check);

  if (expected.status) {
    checkStatus(calls, expected.status, check);
  } else {
    check("no guard_status call", calls.length === 0, calls);
  }

  if (expected.allow) checkAllowed(tree, output, reason, check);

  checkRecorders(
    tree,
    [
      ...(reason === "tack: push blocked" ? ["bash"] : []),
      ...(expected.allow ? ["allow"] : []),
      ...(statusOk ? ["status"] : []),
    ],
    stopped,
    check,
  );
  checkAttempts(tree, expected, check);

  if (expected.name === "normal") {
    const lines = readOptional(path.join(tree.state, "daemon.log"))?.split(
      "\n",
    );
    const terminated = lines?.pop() === "";
    check(
      "exact daemon log lines",
      terminated &&
        isDeepStrictEqual(lines, [
          "tack-daemon: hook toolBefore deny push blocked",
          "tack-daemon: tool guard_status ok",
        ]),
      lines,
    );
  }
}

// tack allowed the harmless command and it ran: Codex returned real git's
// output to the model with no block, the wrapped shim logged the one call
// with exit status 0, and the daemon logged exactly one allow. Codex may run
// git for itself; only calls with the command's own arguments count.
function checkAllowed(tree, output, reason, check) {
  const args = HARMLESS.slice("git ".length);
  const runs = (readOptional(tree.gitRuns) ?? "")
    .split("\n")
    .filter((line) => line.slice(line.indexOf(" ") + 1) === args);
  const lines = readOptional(path.join(tree.state, "daemon.log"))?.split("\n");
  const terminated = lines?.pop() === "";

  // Codex frames the command's output, so the untracked file's line is a
  // substring of what it returned to the model.
  check(
    "bash allowed: " + HARMLESS + " ran with no block reason",
    reason === undefined &&
      typeof output === "string" &&
      output.includes("?? " + UNTRACKED) &&
      !output.includes("blocked by PreToolUse hook"),
    { output },
  );
  check(
    "git shim recorded " + HARMLESS + " executing once with exit status 0",
    isDeepStrictEqual(runs, ["0 " + args]),
    readOptional(tree.gitRuns),
  );
  check(
    "exact daemon log line: hook toolBefore allow",
    terminated &&
      isDeepStrictEqual(lines, ["tack-daemon: hook toolBefore allow"]),
    lines,
  );
  check(
    "tack-hook invoked once",
    readOptional(tree.hookAttempts) === "invoked\n",
    readOptional(tree.hookAttempts),
  );
}

function checkAttempts(tree, expected, check) {
  const attempts = readOptional(tree.hookAttempts);

  if (expected.name === "invalid-guard-status") {
    check(
      "invalid guard_status did not invoke tack-hook",
      attempts === "",
      attempts,
    );
  } else if (hookShims.has(expected.hook)) {
    check("failure shim invoked once", attempts === "invoked\n", attempts);
  }
}

async function checkRebuild(env, first, check) {
  const { tack, codexJs, tree } = env;
  const before = hooksOf(first);
  const firstProblems = trustProblems(first, tree, tree.distA);
  check(
    "first build: exactly tack's handlers are enabled and trusted",
    firstProblems.length === 0,
    { problems: firstProblems, hooks: before },
  );

  const again = tackBuild(tack, tree, tree.distB);
  check("rebuild into a second folder succeeds", again.ok, again);
  env.fragment = installFragment(tree, tree.distB, env.fragment, check);

  const second = await listHooks(codexJs, tree, env.codex);
  const after = hooksOf(second);
  const keys = (hooks) => hooks.map((hook) => hook.key).sort();
  const guard = (hooks) =>
    hooks.find((hook) => hook.eventName === "preToolUse");

  check(
    "rebuild keeps the handler IDs and rewrites the PreToolUse trust hash",
    before.length > 0 &&
      isDeepStrictEqual(keys(before), keys(after)) &&
      guard(before) !== undefined &&
      guard(after) !== undefined &&
      guard(before).currentHash !== guard(after).currentHash,
    { before: keys(before), after: keys(after) },
  );

  return second;
}

async function runDetect(env, expected, listing, check) {
  const { codexJs, tree } = env;
  const baseline = trustProblems(listing, tree, tree.distA);
  const guard = hooksOf(listing).find(
    (hook) => hook.eventName === "preToolUse",
  );
  check(
    "before the break, tack's handlers are enabled and trusted",
    baseline.length === 0 && guard !== undefined,
    baseline,
  );
  if (!guard) return;

  tamper(guard.sourcePath, expected.tamper);
  const after = await listHooks(codexJs, tree, env.codex);
  const problems = trustProblems(after, tree, tree.distA);
  const stale = hooksOf(after).some(
    (hook) => hook.key === guard.key && hook.trustStatus === "modified",
  );
  check(
    expected.tamper === "stale"
      ? "trust assertion detects the stale PreToolUse hash"
      : "trust assertion detects the unparsable hooks config",
    problems.length > 0 && (expected.tamper !== "stale" || stale),
    problems,
  );

  const { model, port } = await startModel(tree, env.codex, expected.model);

  try {
    const run = await runCodex(codexJs, tree, env.codex, port);
    const { output, reason } = blockReason(
      responsesRequests(readRequests(tree)),
    );
    check(
      "load assertion detects the push no handler blocked",
      reason !== "tack: push blocked",
      { exit: run.code, output },
    );
  } finally {
    model.stop();
    await model.done;
  }
}

function checkDirect(env, expected, listing, check) {
  const { tree } = env;
  const problems = trustProblems(listing, tree, tree.distA);
  const guard = hooksOf(listing).find(
    (hook) => hook.eventName === "preToolUse" && matchesBash(hook.matcher),
  );
  check(
    "exactly tack's handlers are enabled and trusted",
    problems.length === 0,
    problems,
  );
  if (!guard) return;

  const result = runPreToolUse(guard.command, tree, env.codex);
  check(
    "node " +
      expected.node +
      ": wrapper exits 2 with " +
      expected.reason +
      " on stderr",
    result.status === 2 &&
      result.stdout === "" &&
      result.stderr.trim() === expected.reason,
    {
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  );
  check(
    "no tack-hook call without a working node",
    readOptional(tree.hookAttempts) === "",
    readOptional(tree.hookAttempts),
  );
}

function breakMcp(out, check) {
  const dir = path.join(out, "codex");
  const servers = entries(dir).filter(
    (file) => !file.endsWith("/") && /mcp/i.test(file),
  );
  check(
    "one generated MCP server file to remove",
    servers.length === 1,
    servers,
  );

  for (const file of servers) rmSync(path.join(dir, file));
}

// Builds, checks the folders and Codex's trust view, then runs the case.
async function exerciseCase(env, expected, check) {
  const { tack, codexJs, tree } = env;
  prepare(tree, env.codex, expected);

  const built = tackBuild(tack, tree, tree.distA);
  check("tack build --target codex succeeds", built.ok, built);
  if (!built.ok) return undefined;

  checkPristine(tree, check);
  env.fragment = installFragment(tree, tree.distA, undefined, check);
  let listing = await listHooks(codexJs, tree, env.codex);
  if (expected.kind === "detect")
    return runDetect(env, expected, listing, check);
  if (expected.kind === "direct")
    return checkDirect(env, expected, listing, check);

  let out = tree.distA;

  if (expected.rebuild) {
    listing = await checkRebuild(env, listing, check);
    out = tree.distB;
  }

  const problems = trustProblems(listing, tree, out);
  check(
    expected.rebuild
      ? "rebuild keeps exactly tack's handlers enabled and trusted"
      : "exactly tack's handlers are enabled and trusted",
    problems.length === 0,
    { problems, hooks: hooksOf(listing) },
  );
  if (expected.mcpBroken) breakMcp(out, check);

  return runSession(env, expected);
}

async function runSession(env, expected) {
  const { codexJs, tree } = env;
  const { model, port } = await startModel(tree, env.codex, expected.model);

  try {
    if (!expected.crash)
      return { run: await runCodex(codexJs, tree, env.codex, port) };

    const daemon = startChild(daemonBin, env.daemonArgs, {
      cwd: tree.project,
      env: env.codex,
    });

    try {
      return {
        run: await runCrash(codexJs, tree, env.codex, port, daemon, env.socket),
      };
    } finally {
      daemon.stop();
      const result = await daemon.done;
      writeFileSync(
        path.join(tree.state, "daemon.log"),
        result.stdout + result.stderr,
        { flag: "a" },
      );
    }
  } finally {
    model.stop();
    const result = await model.done;
    writeFileSync(path.join(tree.base, "model-stderr.log"), result.stderr);
  }
}

function keepEvidence(tree, target) {
  mkdirSync(target, { recursive: true });

  const files = [
    tree.requests,
    tree.recorder,
    tree.hookCalls,
    tree.hookAttempts,
    path.join(tree.base, "codex-output.jsonl"),
    path.join(tree.base, "codex-stderr.log"),
    path.join(tree.base, "app-server-stderr.log"),
    path.join(tree.base, "hooks-list.jsonl"),
    path.join(tree.base, "model-stderr.log"),
    path.join(tree.state, "daemon.log"),
    tree.gitRuns,
    path.join(tree.codexHome, "config.toml"),
    path.join(tree.codexHome, "hooks.json"),
  ];

  for (const file of files) {
    try {
      const name = file.startsWith(tree.codexHome)
        ? "codex-home-" + path.basename(file)
        : path.basename(file);
      copyFileSync(file, path.join(target, name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function runCase(bins, expected, root, target, check) {
  const tree = layout(mkdtempSync(path.join(root, "tack-codex-")));
  const socket = path.join(tree.state, "tack.sock");
  const env = {
    ...bins,
    tree,
    socket,
    codex: codexEnv(tree),
    daemonArgs: ["--socket", socket, "--plugin", pluginDir],
  };

  try {
    const result = await exerciseCase(env, expected, check);
    if (expected.kind === "session") {
      if (result?.run) checkCase(tree, result.run, expected, check);
      else check("conformance session ran", false, "no session");
    }
  } catch (error) {
    check("conformance case ran", false, String(error.stack ?? error));
  } finally {
    try {
      await stopOwned(path.join(tree.state, "tack.lock"), [
        daemonBin,
        "--socket",
        socket,
      ]);
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

function checker(rows, name, own = []) {
  return (label, ok, evidence) => {
    const row = (ok === true ? "PASS " : "FAIL ") + name + ": " + label;
    rows.push(row);
    own.push(row);
    console.log(row);
    if (ok !== true)
      console.error("  evidence: " + JSON.stringify(evidence)?.slice(0, 4000));
  };
}

async function main() {
  // The harness sends SIGSTOP and SIGKILL to the processes it starts.
  if (process.platform !== "linux" || process.env.CI !== "true") {
    throw new Error("Codex conformance runs only in Linux CI");
  }

  const searchPath = process.env.PATH ?? "";
  const codex = findExecutable("codex", searchPath);
  const tack = findExecutable("tack", searchPath);
  if (!codex || !tack) throw new Error("codex and tack must be on PATH");

  // The npm launcher runs under this Node, so no case needs node on PATH.
  const bins = { tack, codexJs: realpathSync(codex) };
  const root = process.env.RUNNER_TEMP ?? tmpdir();
  const artifacts =
    process.env.TACK_CODEX_ARTIFACTS ??
    path.join(repoRoot, "target", "codex-conformance");
  mkdirSync(artifacts, { recursive: true });

  const rows = [];
  const caseRows = new Map();
  await checkOffline(checker(rows, "network"));

  for (const expected of cases) {
    const own = [];
    caseRows.set(expected.name, own);
    await runCase(
      bins,
      expected,
      root,
      path.join(artifacts, expected.name),
      checker(rows, expected.name, own),
    );
  }

  await checkOffline(checker(rows, "network"));

  // Its own row: every check of the harmless case passed, and it ran some.
  const harmless = caseRows.get("harmless") ?? [];
  const allowed =
    harmless.length > 0 && harmless.every((row) => row.startsWith("PASS "));
  const allowedRow = "harmless_allowed=" + allowed;
  console.log(allowedRow);
  writeFileSync(
    path.join(artifacts, "verdict.txt"),
    [...rows, allowedRow].join("\n") + "\n",
  );

  return rows.every((row) => row.startsWith("PASS ")) && allowed ? 0 : 1;
}

process.exitCode = await main();
