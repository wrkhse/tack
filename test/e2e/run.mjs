// End-to-end check: a real OpenCode session loads the generated plugin and a
// scripted local model, while a git shim records what the agent would have run.
// Run only in CI or a disposable container with a throwaway HOME.

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

const fakeModel = path.join(here, "fake-model.mjs");
const gitShim = path.join(here, "git-shim");
const daemonBin = path.join(repoRoot, "target", "debug", "tack-daemon");
const pluginDir = path.join(repoRoot, "dist", "opencode");

const RUN_TIMEOUT_MS = 90_000;
const MODEL_TIMEOUT_MS = 10_000;

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

function writeConfig(configHome, baseUrl) {
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

function startModel() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fakeModel], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("fake model did not report a port; stderr: " + stderr));
    }, MODEL_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
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
      reject(new Error("fake model exited with " + code + "; stderr: " + stderr));
    });
  });
}

function runOpenCode(env, projectDir, onChild) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "opencode",
      ["run", "--standalone", "--format", "json", "-m", "fake/scripted", "push it"],
      { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    onChild(child);

    let output = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      output += text;
    });
    child.stderr.on("data", (text) => {
      output += text;
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
      resolve({ output, code, timedOut });
    });
  });
}

async function main() {
  const base = process.env.TACK_E2E_DIR
    ? path.resolve(process.env.TACK_E2E_DIR)
    : mkdtempSync(path.join(tmpdir(), "tack-e2e-"));
  const created = !process.env.TACK_E2E_DIR;

  const home = path.join(base, "home");
  const configHome = path.join(base, "xdg", "config");
  const stateHome = path.join(base, "xdg", "state");
  const dataHome = path.join(base, "xdg", "data");
  const cacheHome = path.join(base, "xdg", "cache");
  const tmpHome = path.join(base, "tmp");
  const binDir = path.join(base, "bin");
  const projectDir = path.join(base, "project");
  const stateDir = path.join(stateHome, "tack");
  const recorder = path.join(base, "recorder.log");

  for (const dir of [
    home,
    configHome,
    stateHome,
    dataHome,
    cacheHome,
    tmpHome,
    binDir,
    projectDir,
    stateDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const shim = path.join(binDir, "git");
  copyFileSync(gitShim, shim);
  chmodSync(shim, 0o755);

  let model;
  let opencode;

  try {
    model = await startModel();
    writeConfig(configHome, "http://127.0.0.1:" + model.port + "/v1");

    const env = {
      PATH: binDir + path.delimiter + (process.env.PATH ?? ""),
      HOME: home,
      TMPDIR: tmpHome,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateHome,
      XDG_CACHE_HOME: cacheHome,
      TACK_STATE_DIR: stateHome,
      TACK_DAEMON_BIN: daemonBin,
      TACK_RECORDER: recorder,
      TACK_REAL_GIT: findExecutable("git") ?? "",
      OPENCODE_DB: path.join(base, "opencode.sqlite"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_FILEWATCHER: "1",
    };

    const run = await runOpenCode(env, projectDir, (child) => {
      opencode = child;
    });
    const evidence = "exit=" + run.code + ", captured " + run.output.length + " bytes";

    const recorded = readOptional(recorder)
      .split("\n")
      .filter((line) => line.length > 0);
    const pushes = recorded.filter((line) => line.startsWith("push"));
    report(
      "git push was not executed",
      pushes.length === 0,
      "recorder: " + (recorded.length ? recorded.join(" | ") : "(empty)"),
    );

    const daemonLog = readOptional(path.join(stateDir, "daemon.log"));
    const deny = "hook toolBefore deny push blocked";
    const tool = "tool guard_status ok";
    report("daemon denied the push", daemonLog.includes(deny), "daemon.log: " + daemonLog);
    report("daemon ran guard_status", daemonLog.includes(tool), "daemon.log: " + daemonLog);

    const context = run.output + " [run " + evidence + "]";
    report("deny reason reached the session", context.includes("push blocked"), context);
    report(
      "tool result reached the session",
      context.includes("guard_status: daemon ok"),
      context,
    );

    if (run.timedOut) report("opencode run finished within 90s", false, "run was killed at 90s");
  } finally {
    if (opencode && opencode.exitCode === null) opencode.kill("SIGKILL");
    if (model && model.child.exitCode === null) model.child.kill("SIGKILL");
    if (created) rmSync(base, { recursive: true, force: true });
  }
}

await main();

process.exitCode = failures === 0 ? 0 : 1;
