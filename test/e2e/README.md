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
    node test/wrapper.test.mjs
    node test/e2e/run.mjs

Set TACK_E2E_DIR to keep the throwaway tree and its logs for inspection;
otherwise run.mjs deletes it when it finishes.
