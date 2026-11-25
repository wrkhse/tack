
// Codex runs this once per call that matches ^Bash$ and reads one JSON line
// from stdout. An empty object lets the call run and a block stops it. Codex
// lets the call run on a timeout, another exit code or malformed output, so
// every path here prints exactly one of those two results and exits 0.

const GUARDED = "git push";
const HOOK_ID = 1;

function verdict(reason) {
  if (reason === null) return "{}";

  return JSON.stringify({ decision: "block", reason: "tack: " + reason });
}

function readInput(stdin, deadline) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const unwatch = deadline.watch(() => finish(refuse("timeout")));

    function finish(result) {
      if (settled) return;

      settled = true;
      unwatch();
      resolve(result);
    }

    stdin.on("data", (chunk) => {
      if (settled) return;

      size += chunk.length;
      if (size > MAX_FRAME_BYTES) {
        finish(refuse("malformed"));
        return;
      }

      chunks.push(chunk);
    });
    stdin.on("end", () => {
      try {
        const text = new TextDecoder("utf-8", { fatal: true })
          .decode(Buffer.concat(chunks, size));
        finish({ ok: true, event: JSON.parse(text) });
      } catch {
        finish(refuse("malformed"));
      }
    });
    stdin.on("error", () => finish(refuse("aborted")));
  });
}

async function decide(event, deadline) {
  if (event?.tool_name !== "Bash") return null;

  const command = event.tool_input?.command;
  if (typeof command !== "string" || !command.startsWith(GUARDED)) return null;

  const result = await forward({
    kind: "hook",
    id: HOOK_ID,
    version: PROTOCOL_VERSION,
    hook: "toolBefore",
    call: { tool: "shell", name: "Bash", input: { command }, session_id: null },
  }, deadline);

  if (!result.ok) return result.reason;

  const outcome = result.reply.outcome;
  if (outcome?.kind === "allow") {
    record("bash", HOOK_ID);
    return null;
  }

  const reason = typeof outcome?.reason === "string" ? outcome.reason.trim() : "";
  if (outcome?.kind === "deny" && reason !== "") {
    record("bash", HOOK_ID);
    return reason;
  }

  return "malformed_reply";
}

async function main(stdin, stdout, exit) {
  const deadline = startDeadline(BUDGET_MS);
  let reason;

  try {
    const input = await readInput(stdin, deadline);
    reason = input.ok ? await decide(input.event, deadline) : input.reason;
  } catch {
    reason = "daemon_error";
  }

  deadline.clear();

  try {
    stdout.write(verdict(reason) + "\n", () => exit(0));
  } catch {
    exit(0);
  }
}

main(process.stdin, process.stdout, (code) => process.exit(code));
