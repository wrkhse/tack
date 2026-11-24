// Conformance check for Claude Code: the pinned CLI loads the generated tack
// mod against a loopback Anthropic Messages stand-in, while two recorders
// hold what the harness and the mod would have run.
// Run only in CI or a disposable container with a throwaway HOME.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

const modelScript = path.join(here, "model.mjs");
const gitShim = path.join(here, "git-shim");
const modRecorder = path.join(here, "mod-recorder");
const daemonBin = path.join(repoRoot, "target", "debug", "tack-daemon");
const hookBin = path.join(repoRoot, "target", "debug", "tack-hook");
const pluginDir = path.join(repoRoot, "dist", "claude");

const RUN_TIMEOUT_MS = 90_000;
const MODEL_TIMEOUT_MS = 10_000;

const DENY_REASON = "tack: push blocked";
const TOOL_RESULT = "guard_status: daemon ok";
const DAEMON_DENY = "hook toolBefore deny push blocked";
const DAEMON_TOOL = "tool guard_status ok";
// The name in dist/claude/.claude-plugin/plugin.json.
const PLUGIN_NAME = "tack";
// Lines Claude Code writes when a hooks module is refused, fails to load or
// is unloaded, or a hook is skipped, and the lines that turn every installed
// mod off; see the mods troubleshooting page.
const HOOKS_FAILURE = /not loaded:|did not load|hook skipped|was unloaded/i;
const HOOKS_OFF = /hooks modules are turned off|hooks worker are off/i;
const STDERR_TAIL_LINES = 60;

let failures = 0;

function report(label, ok, evidence) {
  if (ok) console.log("PASS " + label);
  else {
    failures += 1;
    console.error("FAIL " + label);
  }

  const shown = evidence.length > 4000 ? evidence.slice(0, 4000) + " ... (truncated)" : evidence;
  console.log("  evidence: " + shown.replace(/\n/g, " | "));
}

function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function lines(file) {
  return readOptional(file)
    .split("\n")
    .filter((line) => line.length > 0);
}

async function stopDaemon(dir) {
  let pid;
  try {
    pid = Number(readFileSync(path.join(dir, "tack.lock"), "utf8").trim());
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
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

function printTail(label, text) {
  const tail = text
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-STDERR_TAIL_LINES);

  console.log(label + " (last " + tail.length + " lines):");
  for (const line of tail) console.log("  | " + line);
  if (tail.length === 0) console.log("  | (empty)");
}

function install(source, target) {
  copyFileSync(source, target);
  chmodSync(target, 0o755);
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

// Writes the mod recorder with its two absolute paths in place of the
// placeholders, so it works whatever environment the mod's process gets.
function installModRecorder(target, recorderFile, execFile) {
  const template = readFileSync(modRecorder, "utf8");
  const placeholders = ["@RECORDER@", "@EXEC@"];

  for (const placeholder of placeholders) {
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

function startModel(requestLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [modelScript, requestLog], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("model did not report a port; stderr: " + stderr));
    }, MODEL_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      buffer += text;
      const parts = buffer.split("\n");
      buffer = parts.pop();

      for (const line of parts) {
        const port = Number(line.trim());
        if (!/^\d+$/.test(line.trim()) || port <= 0 || settled) continue;
        settled = true;
        clearTimeout(timer);
        resolve({ child, port });
        return;
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      stderr += text;
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("model exited with " + code + "; stderr: " + stderr));
    });
  });
}

// No --bare: it turns plugin hooks off. stream-json puts every tool_result
// the session saw into the output, so the deny and the tool result show there.
function runClaude(env, projectDir, onChild) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--plugin-dir",
        pluginDir,
        "--dangerously-skip-permissions",
        "--model",
        "scripted",
        "--output-format",
        "stream-json",
        "--verbose",
        "push my branch",
      ],
      { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    onChild(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      stdout += text;
    });
    child.stderr.on("data", (text) => {
      stderr += text;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ output: stdout + stderr, stdout, stderr, code, timedOut });
    });
  });
}

function layout(base) {
  const tree = {
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
    recorder: path.join(base, "recorder.log"),
    modRecorder: path.join(base, "mod-recorder.log"),
    requestLog: path.join(base, "requests.jsonl"),
    output: path.join(base, "claude-output.jsonl"),
    stderr: path.join(base, "claude-stderr.log"),
  };

  for (const dir of [
    tree.home,
    tree.claudeConfig,
    tree.configHome,
    tree.dataHome,
    tree.cacheHome,
    tree.tmpHome,
    tree.binDir,
    tree.projectDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // tack-hook trusts the state dir only when the euid owns it with mode 0700
  // or stricter. The chmod sets the mode whatever the umask took away or left.
  mkdirSync(tree.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(tree.stateDir, 0o700);

  install(gitShim, path.join(tree.binDir, "git"));
  // The mod runs the plain name tack-hook, so the recorder takes that name
  // ahead of target/debug and hands each call to the real binary.
  installModRecorder(path.join(tree.binDir, "tack-hook"), tree.modRecorder, hookBin);

  return tree;
}

function claudeEnv(tree, port) {
  return {
    PATH: tree.binDir + path.delimiter + (process.env.PATH ?? ""),
    HOME: tree.home,
    TMPDIR: tree.tmpHome,
    SHELL: "/bin/bash",
    XDG_CONFIG_HOME: tree.configHome,
    XDG_DATA_HOME: tree.dataHome,
    XDG_STATE_HOME: tree.stateDir,
    XDG_CACHE_HOME: tree.cacheHome,
    CLAUDE_CONFIG_DIR: tree.claudeConfig,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:" + port,
    ANTHROPIC_API_KEY: "dummy",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    TACK_STATE_DIR: tree.stateDir,
    TACK_DAEMON_BIN: daemonBin,
    TACK_RECORDER: tree.recorder,
    TACK_REAL_GIT: findExecutable("git") ?? "",
  };
}

function initFrame(output) {
  for (const line of output.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;

    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      continue;
    }

    if (frame?.type === "system" && frame.subtype === "init") return frame;
  }

  return null;
}

// Claude Code's own plugins, such as cc-plugin-agents-md, load in every
// session. Only these are left out of the loaded set.
function isBuiltIn(plugin) {
  const source = typeof plugin?.source === "string" ? plugin.source : "";
  const name = typeof plugin?.name === "string" ? plugin.name : "";

  return source.endsWith("@builtin") || name.startsWith("cc-plugin-");
}

// The system/init frame names every plugin Claude Code loaded and every one
// that failed or loaded without a part, such as its hooks file. Apart from
// the built-ins, the run loads exactly the tack mod, with no plugin error.
function loadedSet(output) {
  const frame = initFrame(output);
  if (!frame) {
    return { ok: false, plugins: [], evidence: "no system/init frame in the output" };
  }

  const plugins = Array.isArray(frame.plugins) ? frame.plugins : [];
  const errors = Array.isArray(frame.plugin_errors) ? frame.plugin_errors : [];
  const builtIn = plugins.filter(isBuiltIn).map((plugin) => plugin?.name);
  const names = plugins
    .filter((plugin) => !isBuiltIn(plugin))
    .map((plugin) => plugin?.name);

  const ok = names.length === 1 && names[0] === PLUGIN_NAME && errors.length === 0;
  const evidence =
    "plugins: " +
    JSON.stringify(plugins) +
    ", built-ins left out: " +
    JSON.stringify(builtIn) +
    ", plugin_errors: " +
    JSON.stringify(errors);

  return { ok, plugins, evidence };
}

// The stream-json frames, other than system/init, and the stderr lines that
// mention hooks and the plugin's name.
function hookLines(run, name) {
  const fromStdout = run.stdout.split("\n").filter((line) => {
    const text = line.trim();
    const mentions = /hook/i.test(text) && text.includes(name);
    if (!text.startsWith("{") || !mentions) return false;

    try {
      const frame = JSON.parse(text);
      return !(frame?.type === "system" && frame.subtype === "init");
    } catch {
      return false;
    }
  });
  const fromStderr = run.stderr.split("\n").filter((line) => {
    return /hook/i.test(line) && line.includes(name);
  });

  return { fromStdout, fromStderr };
}

// Prints, for every plugin in the init frame, whether the output holds a
// hooks line for it, and fails on a line saying the tack mod's hooks module
// was refused, failed to load, was unloaded, or had a hook skipped, or that
// hooks modules are turned off for the whole process.
function checkHookLines(run, plugins) {
  const names = new Set([PLUGIN_NAME, ...plugins.map((plugin) => String(plugin?.name))]);

  for (const name of names) {
    const { fromStdout, fromStderr } = hookLines(run, name);
    const counts = "stream-json " + fromStdout.length + ", stderr " + fromStderr.length;

    console.log("hooks lines for " + name + ": " + counts);
    for (const line of [...fromStdout, ...fromStderr]) console.log("  | " + line);
  }

  const own = hookLines(run, PLUGIN_NAME);
  const ownFailures = [...own.fromStdout, ...own.fromStderr].filter((line) => {
    return HOOKS_FAILURE.test(line);
  });
  const off = run.output.split("\n").filter((line) => HOOKS_OFF.test(line));
  const failed = [...ownFailures, ...off];

  report(
    "no hooks failure reported for the tack mod",
    failed.length === 0,
    failed.length ? failed.join(" | ") : "(none)",
  );
}

// The git shim writes the arguments of each push it stops, as in
// "push origin main", so a recorded push is a line whose first word is push.
// The mod recorder's lines start with "call" and name paths such as
// fixtures/safe-push, so they are evidence only and never decide the check.
function isRecordedPush(line) {
  return /^push(\s|$)/.test(line.trim());
}

assert.equal(isRecordedPush("push origin main"), true);
assert.equal(isRecordedPush("push"), true);
assert.equal(isRecordedPush("call --plugin /work/tack/fixtures/safe-push"), false);
assert.equal(isRecordedPush("call push"), false);

function checkNoPush(tree) {
  const shim = lines(tree.recorder);
  const mod = lines(tree.modRecorder);
  const pushes = shim.filter(isRecordedPush);

  report(
    "git push was not executed",
    pushes.length === 0,
    "git shim: " +
      (shim.length ? shim.join(" | ") : "(empty)") +
      "; mod recorder: " +
      (mod.length ? mod.join(" | ") : "(empty)"),
  );
}

function check(tree, run) {
  checkNoPush(tree);

  const loaded = loadedSet(run.output);
  report("claude loaded exactly the tack mod", loaded.ok, loaded.evidence);

  checkHookLines(run, loaded.plugins);

  // A row about the mod's hook or tool proves nothing unless the mod loaded.
  if (!loaded.ok) {
    report("hook and tool rows", false, "not counted: the tack mod did not load");
    return;
  }

  checkRows(tree, run);
}

function checkRows(tree, run) {
  const daemonLog = readOptional(path.join(tree.stateDir, "daemon.log"));
  report("daemon denied the push", daemonLog.includes(DAEMON_DENY), "daemon.log: " + daemonLog);
  report("daemon ran guard_status", daemonLog.includes(DAEMON_TOOL), "daemon.log: " + daemonLog);

  const context = run.output + " [run exit=" + run.code + "]";
  report("deny reason reached the session", context.includes(DENY_REASON), context);
  report("tool result reached the session", context.includes(TOOL_RESULT), context);

  const modCalls = lines(tree.modRecorder);
  report(
    "the mod called tack-hook",
    modCalls.length > 0,
    "mod recorder: " + (modCalls.length ? modCalls.join(" | ") : "(empty)"),
  );
}

// On failure, copy the run's evidence where the workflow uploads it, before
// the throwaway tree is removed.
function keepEvidence(tree) {
  const target = process.env.TACK_CLAUDE_ARTIFACTS;
  if (!target || failures === 0) return;

  mkdirSync(target, { recursive: true });

  const files = [
    tree.output,
    tree.stderr,
    tree.requestLog,
    tree.recorder,
    tree.modRecorder,
    path.join(tree.stateDir, "daemon.log"),
  ];

  for (const file of files) {
    try {
      copyFileSync(file, path.join(target, path.basename(file)));
    } catch {
      continue;
    }
  }
}

async function main() {
  const root = process.env.RUNNER_TEMP ?? tmpdir();
  const tree = layout(mkdtempSync(path.join(root, "tack-claude-")));

  let model;
  let claude;

  try {
    model = await startModel(tree.requestLog);

    const run = await runClaude(claudeEnv(tree, model.port), tree.projectDir, (child) => {
      claude = child;
    });
    writeFileSync(tree.output, run.stdout);
    writeFileSync(tree.stderr, run.stderr);

    if (run.timedOut) report("claude finished within 90s", false, "run was killed at 90s");

    check(tree, run);
  } catch (error) {
    report("conformance run completed", false, String(error?.stack ?? error));
  } finally {
    if (claude && claude.exitCode === null) claude.kill("SIGKILL");
    if (model && model.child.exitCode === null) model.child.kill("SIGKILL");
    if (process.env.CI) await stopDaemon(tree.stateDir);

    if (failures > 0) printTail("claude stderr", readOptional(tree.stderr));

    keepEvidence(tree);
    rmSync(tree.base, { recursive: true, force: true });
  }
}

await main();

process.exitCode = failures === 0 ? 0 : 1;
