# End-to-end fixtures

These fixtures are the CI stand-in for the conformance paths removed from the
repository. They are ported from conformance/model/stand-in.ts and
conformance/harness/recorder.ts at base commit
663045b8e9a931a188d011484a425144cd2a1885.

- fake-model.mjs is a local OpenAI-compatible Chat Completions server. It
  scripts four turns: a title, a git push origin main shell call, a
  guard_status call, then done. Tool names come from the incoming request.
- git-shim records pushes into TACK_RECORDER and delegates every other git
  command to TACK_REAL_GIT.
- run.mjs builds a throwaway HOME and XDG tree, starts the fake model, runs the
  real OpenCode CLI against the generated plugin, and checks that the push was
  blocked while guard_status reached both the daemon log and the session.

Run these only in CI or a disposable container. The scripts create a throwaway
HOME, use a local fake provider, and need no API key. Never run them against a
real user HOME.

From the repository root, in a container with Node, Rust 1.100, and the
pinned OpenCode 2.3.0 tarball installed with its SHA-256 checksum verified:

    cargo build --workspace --bins --locked
    cargo run --locked -p tack-cli -- build fixtures/safe-push --out dist
    node adapters/opencode/wrapper.test.mjs
    node test/e2e/run.mjs

Set TACK_E2E_DIR to keep the throwaway tree and its logs for inspection;
otherwise run.mjs deletes it when it finishes.

## Recordings

The record workflow starts each recording harness under Terminal Control and
renders it in two panes: the session on the left, daemon.log on the right,
under a header that ticks off each step.

- record.mjs records OpenCode. It takes the opencode run command on stdin,
  then a proof command, and writes verdict.txt. video-edit.json is its edit
  plan.
- record-claude.mjs records Claude Code 2.1.328. On start it runs the
  loopback model from test/claude/model.mjs, a scratch git repo with
  origin/main, and `tack build fixtures/safe-push --target claude` with the
  released CLI, then runs
  `claude -p --plugin-dir <dist>/claude --dangerously-skip-permissions
  --model scripted --output-format stream-json --verbose "push my branch"`,
  without --bare, which turns plugin hooks off. It prints `Claude session`
  once ready and `SESSION_DONE` when Claude exits, then takes one proof
  command on stdin, such as
  `git log --oneline origin/main; echo NO_PUSH_REACHED_ORIGIN`, and finishes
  6 seconds after it. video-edit-claude.json is its edit plan.
- record-pi.mjs records Pi 1.6.0. It starts the loopback model from
  test/pi/model.mjs and tack-daemon, creates a scratch git repo tracking a
  local origin/main, and builds `fixtures/safe-push` with the released CLI
  for `--target pi`. It runs `pi --mode json --no-extensions` with
  `-e <dist>/pi/extension.js`. video-edit-pi.json is its edit plan.
- record-codex.mjs records Codex 0.172.0 in two sessions: one pushes and
  calls guard_status, one runs a harmless `git status --short`.
  video-edit-codex.json is its edit plan.

record-claude.mjs installs test/claude/git-shim as git and
test/claude/mod-recorder as tack-hook, first on PATH, with the recorder file
and the real tack-hook written into the recorder as quoted absolute paths.
It reads these variables:

| Variable        | Use                                            |
| --------------- | ---------------------------------------------- |
| TACK_CLI        | the released tack CLI; else tack               |
| TACK_DAEMON_BIN | the released tack-daemon; else tack-daemon     |
| TACK_HOOK_BIN   | the released tack-hook; else tack-hook on PATH |
| RUNNER_TEMP     | where the throwaway tree goes; else the tmpdir |

The session gets its own HOME, CLAUDE_CONFIG_DIR and XDG folders, a state
folder with mode 0700, `ANTHROPIC_BASE_URL` on the loopback model,
`ANTHROPIC_API_KEY=dummy`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
`DISABLE_AUTOUPDATER=1`. The model, the build and the session are bounded at
10, 10 and 90 seconds.

It writes verdict-claude.txt at the repository root, also when a step fails:

    push_denied=true
    guard_status_ran=true
    no_push_recorded=true
    hook_called=true

Each line is true when daemon.log holds `hook toolBefore deny push blocked`
and the session shows `tack: push blocked`; daemon.log holds
`tool guard_status ok` and the session shows `guard_status: daemon ok`; the
git shim recorded no push; and the mod recorder holds at least one call. It
exits 0 only when all four are true. It removes the throwaway tree and stops
what it started when it finishes, and in CI also the daemon tack-hook
started.

record-claude.mjs runs only in the record workflow on a CI runner. It
starts and stops processes, so never run it on a workstation, not even in a
scratch folder.

### Pi recording

The recorder reads `TACK_CLI`, `TACK_DAEMON_BIN`, `TACK_HOOK_BIN`, and
`RUNNER_TEMP` with the defaults in the table above. Pi gets an isolated
HOME, XDG folders, `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`,
`PI_SKIP_VERSION_CHECK=1`, and `PI_TELEMETRY=0`. Its `models.json` points
the `scripted` model at a loopback OpenAI-compatible `/v1` endpoint with a
dummy key. `TACK_STATE_DIR` is mode 0700 and holds `daemon.log`.
`TACK_DAEMON_BIN` points to the release binary, `TACK_HOOK_BIN` to the
wrapper that records successful calls, and `TACK_REAL_GIT` to real git.
The git shim records attempted pushes in `TACK_RECORDER` and delegates
other commands to real git.

The recorder prints `Pi session` when ready and `SESSION_DONE` after Pi
exits successfully. Send `git log --oneline origin/main` on stdin; the
recorder prints `NO_PUSH_REACHED_ORIGIN` after that command exits 0 and
the git shim shows no pushes. The model, build, session, and proof command
have deadlines of 10, 10, 90, and 10 seconds, respectively.

The recorder writes `verdict-pi.txt` at the repository root, also on setup
failure. A passing run has these exact rows:

    push_denied=true
    guard_status_ran=true
    no_push_recorded=true
    hook_called=true
    extension_loaded=true

The first two rows require the exact Pi tool result and corresponding
daemon log line. The next two require no git-shim push and at least one
successful hook-wrapper call. The last requires exactly one Pi
`entry_appended` event with a custom `tack-loaded` entry and empty data.
The recorder cleans up its processes and scratch tree, then stays up for
Terminal Control. It exits 0 only on proof success and an all-true verdict.

Run record-pi.mjs only in the record workflow on a Linux CI runner. Never
run the recorder, Pi, tack-hook, the daemon, or Terminal Control for this
recording on a workstation. Use static checks on the host.

### Codex recording

record-codex.mjs reads `TACK_CLI`, `TACK_DAEMON_BIN`, `TACK_HOOK_BIN` and
`RUNNER_TEMP` with the defaults in the table above, and runs the `codex`
launcher first on PATH under its own Node. The workflow installs Codex with
`npm ci --prefix test/codex --ignore-scripts` and checks its version.

Setup follows test/codex/run.mjs. Codex gets its own `HOME`, `CODEX_HOME`
and XDG folders, and `HOME/.local/state/tack`, mode 0700, is
`TACK_STATE_DIR`. `tack build fixtures/safe-push --target codex` writes the
hooks and their trust into `CODEX_HOME`, and the generated
`<dist>/codex/config.toml` goes at the top of `CODEX_HOME/config.toml`. The
recorder starts the released tack-daemon on `tack.sock`, logging to
`daemon.log`. The git shim from test/claude records pushes in
`TACK_RECORDER`; the hook recorder, first on PATH as `tack-hook`, passes
each call to the released one and logs each verdict to a file outside git.
Each session runs a fresh test/codex/model.mjs on 127.0.0.1 as a custom
Responses provider with `supports_websockets=false` and
`CODEX_API_KEY=dummy`:

| Session  | Prompt                 | The model calls                         |
| -------- | ---------------------- | --------------------------------------- |
| normal   | push my branch         | `git push origin main`, `guard_status` |
| harmless | check the working tree | `git status --short`                    |

The left pane, titled `Codex session`, shows the `codex exec --json`
events and what Codex returned to the model for each Bash call, read from
the stand-in's request log. The right pane is `daemon.log`. Panes are 72
and 48 columns and keep at most 200 lines. The workflow waits for these
exact strings in turn and marks each:

| Marker       | String                                   |
| ------------ | ---------------------------------------- |
| ready        | `Codex session`                          |
| denied       | `tack: push blocked`                     |
| tool         | `guard_status: daemon ok`                |
| allow        | `PreToolUse allowed: git status --short` |
| session-done | `SESSION_DONE`                           |
| proof        | `NO_PUSH_REACHED_ORIGIN`                 |

Each step holds the left pane still for 2.5 seconds before the next line
joins it. After `SESSION_DONE` the recorder takes one proof command on
stdin, `git log --oneline origin/main`, and prints
`NO_PUSH_REACHED_ORIGIN` once it exits 0 and the git shim holds no push.
The proof stays on screen 4 seconds before the recorder finishes. The
model, build, daemon start, each session and the proof command are bounded
at 10, 15, 5, 90 and 10 seconds. video-edit-codex.json captions the four
steps at half speed, then three quarters, holding each clip's last frame
2.5 seconds and the final frame 3.5 seconds.

The recorder writes verdict-codex.txt at the repository root, also when a
step fails, from the same judgement that ticks the header:

    push_denied=true
    guard_status_ran=true
    no_push_recorded=true
    hook_called=true
    extension_loaded=true
    harmless_allowed=true

Each row is true when the pane shows `tack: push blocked` and daemon.log
holds `tack-daemon: hook toolBefore deny push blocked`; the pane shows
`guard_status: daemon ok` and daemon.log holds
`tack-daemon: tool guard_status ok`; the git shim recorded no push; the hook
recorder holds exactly the deny, the guard_status and the allow verdicts, in
that order; `TACK_RECORDER` holds one `{"call":"tack-loaded"}` for each
session; and the pane shows the allow line, which needs `?? harmless.txt`
from real git in what Codex returned, while daemon.log holds
`tack-daemon: hook toolBefore allow`. The workflow greps each row after
`termctrl stop`. The recorder exits 0 only with an all-true verdict and the
proof shown, then removes its processes, any daemon tack-hook started, and
the scratch tree, and stays up until Terminal Control stops it.

Run record-codex.mjs only in the record workflow on a Linux CI runner; it
refuses to start elsewhere. Never run it, Codex, tack-hook, the daemon or
Terminal Control for this recording on a workstation. Use static checks on
the host. The GIF is a workflow artifact, not a file in the repository.
