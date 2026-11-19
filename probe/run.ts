// Throwaway probe for T4, the Claude Code mod. This branch is never merged.
// It starts Claude Code, so it runs only in CI, never on a development machine.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLAUDE = process.env.CLAUDE_BIN ?? "";
const HERE = import.meta.dir;
const ROOT = mkdtempSync(join(tmpdir(), "tack-probe-"));
const MODS_DIR = join(ROOT, "mods");
const REAL_GIT = Bun.which("git") ?? "/usr/bin/git";
const RUN_TIMEOUT_MS = 150000;
const PLAIN_TIMEOUT_MS = 60000;
const MAX_REQUESTS = 80;

const MODS = [
  "m-globals", "m-events", "m-prompt", "m-tool", "m-effect",
  "m-order-a", "m-order-b", "m-dollar-value", "m-dollar-param",
  "m-dollar-closure", "m-dollar-noun", "m-throws",
  "m-catch-throw", "m-catch-slow",
];

const SEQUENCE = [
  { name: "Bash", input: { command: "git push origin main" } },
  { name: "mcp__m-tool__echo", input: { text: "hi" } },
  { name: "mcp__m-tool__fail", input: {} },
];

type Turn =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown };

let requests: Array<Record<string, unknown>> = [];

function section(title: string): void {
  console.log("\n=== " + title + " ===");
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;

  return text.slice(0, max) + "\n...[" + (text.length - max) + " more chars]";
}

function blocksOf(message: any): any[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];

  return Array.isArray(message.content) ? message.content : [];
}

function textOf(block: any): string {
  if (typeof block === "string") return block;
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return block.content.map(textOf).join(" ");

  return "";
}

function summarizeBlock(block: any): Record<string, unknown> {
  if (block.type === "tool_result") {
    return { type: block.type, isError: block.is_error, text: clip(textOf(block), 400) };
  }

  if (block.type === "tool_use") {
    return { type: block.type, name: block.name, input: block.input };
  }

  return { type: block.type, text: clip(textOf(block), 200) };
}

function summarize(body: any): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const whole = JSON.stringify(body);

  return {
    model: body.model,
    stream: body.stream,
    maxTokens: body.max_tokens,
    systemChars: JSON.stringify(body.system ?? "").length,
    toolNames: tools.map((tool: any) => tool.name),
    modTools: tools.filter((tool: any) => String(tool.name).startsWith("mcp__")),
    messages: messages.map((message: any) => ({
      role: message.role,
      blocks: blocksOf(message).map(summarizeBlock),
    })),
    hasProbeContext: whole.includes("tack-probe-context"),
    hasAppendStart: whole.includes("tack-probe-append-start"),
    hasAppendNow: whole.includes("tack-probe-append-now"),
  };
}

function nextTurn(body: any): Turn {
  const tools = Array.isArray(body.tools) ? body.tools : [];

  if (tools.length === 0) return { kind: "text", text: "probe-title" };

  const declared = new Set(tools.map((tool: any) => tool.name));
  const plan = SEQUENCE.filter((step) => declared.has(step.name));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const results = messages
    .flatMap(blocksOf)
    .filter((block: any) => block.type === "tool_result").length;
  const step = plan[results];

  if (step === undefined) return { kind: "text", text: "done" };

  return { kind: "tool", name: step.name, input: step.input };
}

function sse(event: string, data: unknown): string {
  return "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
}

function streamBody(model: string, turn: Turn, serial: number): string {
  const head = sse("message_start", {
    type: "message_start",
    message: {
      id: "msg_probe_" + serial,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const block =
    turn.kind === "tool"
      ? sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_probe_" + serial, name: turn.name, input: {} },
        }) +
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.input) },
        })
      : sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }) +
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: turn.text },
        });
  const tail =
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: turn.kind === "tool" ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }) +
    sse("message_stop", { type: "message_stop" });

  return head + block + tail;
}

function messageJson(model: string, turn: Turn, serial: number): Record<string, unknown> {
  const content =
    turn.kind === "tool"
      ? [{ type: "tool_use", id: "toolu_probe_" + serial, name: turn.name, input: turn.input }]
      : [{ type: "text", text: turn.text }];

  return {
    id: "msg_probe_" + serial,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: turn.kind === "tool" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 5 },
  };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const serial = requests.length + 1;
    const entry: Record<string, unknown> = {
      n: serial,
      method: request.method,
      path: url.pathname + url.search,
      headers: {
        anthropicVersion: request.headers.get("anthropic-version"),
        anthropicBeta: request.headers.get("anthropic-beta"),
        userAgent: request.headers.get("user-agent"),
        xApp: request.headers.get("x-app"),
        hasApiKey: request.headers.has("x-api-key"),
        hasAuthorization: request.headers.has("authorization"),
      },
    };

    requests.push(entry);

    if (serial > MAX_REQUESTS) {
      entry.answer = 429;

      return new Response("too many requests", { status: 429 });
    }

    if (request.method !== "POST" || !url.pathname.endsWith("/v1/messages")) {
      entry.answer = 404;

      return new Response("not found", { status: 404 });
    }

    let body: any;

    try {
      body = await request.json();
    } catch {
      entry.answer = 400;

      return new Response("bad json", { status: 400 });
    }

    const turn = nextTurn(body);
    const model = String(body.model);

    entry.body = summarize(body);
    entry.answer = turn;

    if (body.stream === true) {
      return new Response(streamBody(model, turn, serial), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }

    return Response.json(messageJson(model, turn, serial));
  },
});

function buildEffectMod(out: string): void {
  const built = Bun.spawnSync([
    "bun", "build", join(HERE, "effect-entry.js"),
    "--target=browser", "--format=esm", "--outfile", out,
  ]);

  section("bundle m-effect");
  console.log("exit " + built.exitCode);
  console.log(clip(built.stdout.toString() + built.stderr.toString(), 3000));

  if (!existsSync(out)) return;

  const text = readFileSync(out, "utf8");
  const count = (needle: string): number => text.split(needle).length - 1;

  console.log(JSON.stringify({
    bytes: statSync(out).size,
    nodeImports: count("node:"),
    dynamicImports: count("import("),
    requires: count("require("),
    setTimeout: count("setTimeout"),
    queueMicrotask: count("queueMicrotask"),
    console: count("console."),
    newFunction: count("new Function"),
  }));
}

function writeMods(): void {
  for (const name of MODS) {
    const mod = join(MODS_DIR, name);

    mkdirSync(join(mod, ".claude-plugin"), { recursive: true });
    mkdirSync(join(mod, "hooks"), { recursive: true });
    writeFileSync(
      join(mod, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name, version: "0.0.1", description: "tack T4 probe" }, null, 2),
    );
    writeFileSync(
      join(mod, "hooks", "hooks.json"),
      JSON.stringify({ description: "tack T4 probe", modules: ["./register.js"] }, null, 2),
    );

    if (name === "m-effect") {
      buildEffectMod(join(mod, "hooks", "register.js"));
    } else {
      copyFileSync(join(HERE, "mods-src", name + ".js"), join(mod, "hooks", "register.js"));
    }
  }
}

interface Sandbox {
  readonly project: string;
  readonly recorder: string;
  readonly env: Record<string, string>;
}

function sandbox(label: string): Sandbox {
  const dir = join(ROOT, "run-" + label);
  const bin = join(dir, "bin");
  const project = join(dir, "project");
  const recorder = join(dir, "recorder.log");

  for (const path of [bin, project, join(dir, "home"), join(dir, "config")]) {
    mkdirSync(path, { recursive: true });
  }

  const shim = [
    "#!/bin/sh",
    'case "$1" in',
    "  push|probe-shim)",
    "    printf '%s | TACK_RECORDER=%s\\n' \"$*\" \"${TACK_RECORDER:-unset}\" >> '" + recorder + "'",
    "    exit 0",
    "    ;;",
    "esac",
    "exec '" + REAL_GIT + "' \"$@\"",
    "",
  ].join("\n");

  writeFileSync(join(bin, "git"), shim);
  chmodSync(join(bin, "git"), 0o755);

  return {
    project,
    recorder,
    env: {
      ...process.env,
      PATH: bin + ":" + (process.env.PATH ?? ""),
      HOME: join(dir, "home"),
      CLAUDE_CONFIG_DIR: join(dir, "config"),
      ANTHROPIC_BASE_URL: "http://127.0.0.1:" + server.port,
      ANTHROPIC_API_KEY: "sk-ant-tack-probe-dummy",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1",
      TACK_RECORDER: recorder,
      TERM: "dumb",
    },
  };
}

interface Finished {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly ms: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function spawnClaude(args: string[], box: Sandbox, timeoutMs: number): Promise<Finished> {
  const started = Date.now();
  const child = Bun.spawn([CLAUDE, ...args], {
    cwd: box.project,
    env: box.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  clearTimeout(timer);

  return { exitCode, timedOut, ms: Date.now() - started, stdout, stderr };
}

async function plain(label: string, args: string[], max: number): Promise<void> {
  requests = [];

  const box = sandbox(label);
  const done = await spawnClaude(args, box, PLAIN_TIMEOUT_MS);

  section(label + ": claude " + args.join(" "));
  console.log("exit " + done.exitCode + " timedOut " + done.timedOut + " ms " + done.ms);
  console.log("--- stdout\n" + clip(done.stdout, max));
  console.log("--- stderr\n" + clip(done.stderr, max));
}

function printStream(stdout: string): void {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");

  console.log("--- stdout: " + lines.length + " lines");

  for (const line of lines.slice(0, 80)) {
    const isInit = line.includes('"subtype":"init"');

    console.log(clip(line, isInit ? 6000 : 700));
  }
}

function printFiles(box: Sandbox): void {
  const out = join(box.project, "probe-out");

  console.log("--- recorder");
  console.log(existsSync(box.recorder) ? readFileSync(box.recorder, "utf8") : "(no recorder file)");
  console.log("--- probe-out");

  if (!existsSync(out)) {
    console.log("(no probe-out directory)");

    return;
  }

  for (const name of readdirSync(out).sort()) {
    console.log("# " + name + "\n" + clip(readFileSync(join(out, name), "utf8"), 3000));
  }
}

async function scenario(label: string, mods: string[], stream: boolean): Promise<void> {
  requests = [];

  const box = sandbox(label);
  const args = [
    "-p", "push it",
    ...mods.flatMap((name) => ["--plugin-dir", join(MODS_DIR, name)]),
    "--model", "scripted",
    "--max-turns", "8",
    "--dangerously-skip-permissions",
    ...(stream ? ["--output-format", "stream-json", "--verbose"] : []),
  ];
  const done = await spawnClaude(args, box, RUN_TIMEOUT_MS);

  section("scenario " + label + ": mods " + (mods.join(", ") || "(none)"));
  console.log("args: " + args.map((arg) => arg.replace(MODS_DIR + "/", "")).join(" "));
  console.log("exit " + done.exitCode + " timedOut " + done.timedOut + " ms " + done.ms);

  if (stream) {
    printStream(done.stdout);
  } else {
    console.log("--- stdout\n" + clip(done.stdout, 3000));
  }

  console.log("--- stderr\n" + clip(done.stderr, 6000));
  printFiles(box);
  console.log("--- stand-in requests: " + requests.length);

  for (const entry of requests) {
    console.log(clip(JSON.stringify(entry), 3500));
  }
}

if (CLAUDE === "" || !existsSync(CLAUDE)) {
  console.error("CLAUDE_BIN is not set or does not exist: " + CLAUDE);
  process.exit(1);
}

writeMods();

await plain("version", ["--version"], 500);
await plain("help", ["--help"], 9000);
await plain("plugin-help", ["plugin", "--help"], 4000);

for (const name of MODS) {
  await plain("validate-" + name, ["plugin", "validate", join(MODS_DIR, name)], 3000);
}

await scenario("no-mods", [], true);
await scenario("main", ["m-globals", "m-events", "m-prompt", "m-tool", "m-effect", "m-order-a", "m-order-b"], true);
await scenario("order-reversed", ["m-order-b", "m-order-a"], false);
await scenario("dollar", ["m-dollar-value", "m-dollar-param", "m-dollar-closure", "m-dollar-noun"], false);
await scenario("throws-stream", ["m-throws"], true);
await scenario("throws-text", ["m-throws"], false);
await scenario("catch-throw", ["m-catch-throw"], false);
await scenario("catch-slow", ["m-catch-slow"], false);

section("done");
server.stop(true);
process.exit(0);
