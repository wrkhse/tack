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
