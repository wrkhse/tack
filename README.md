# tack

tack is a Rust CLI and daemon for running one Luau plugin in OpenCode.

Slice 1's design: a plugin is compiled into a generated OpenCode JavaScript
wrapper. The wrapper forwards hooks and tool runs as NDJSON over an owner-only
Unix socket to an auto-started, per-user daemon. The daemon runs the plugin's
Luau in an `mlua` sandbox with a 16 MiB memory limit and a 100 ms deadline per
call.

A plugin is a Luau table. This one denies `git push` and exposes one tool:

```lua
--!strict
local guardStatus = require("./guard-status")

return {
  name = "safe-push",

  toolBefore = function(payload, ctx)
    if ctx.tool == "shell"
      and string.find(payload.command, "^git push") then
      return ctx.deny("push blocked")
    end
  end,

  tools = { guard_status = guardStatus },
}
```

## Design path

Slice 1 builds toward this path:

```mermaid
flowchart LR
    Plugin["Luau plugin"] -->|"tack build"| Wrapper["generated wrapper<br/>OpenCode JS"]
    Wrapper -->|"NDJSON"| Socket["owner-only<br/>Unix socket"]
    Socket --> Daemon["per-user daemon<br/>auto-started"]
    Daemon --> Sandbox["mlua sandbox<br/>16 MiB, 100 ms"]
    Sandbox --> OpenCode["OpenCode"]
```

## Install

### Release candidate (pre-release)

The current build is published as a **pre-release** on the
[releases page](https://github.com/wrkhse/tack/releases). Each release carries
one tarball per target and a single `SHA256SUMS` covering all three. Download
the tarball for your target, verify it, unpack it, and put its three binaries
on your `PATH`:

```bash
TAG=v0.1.0-rc.3
TARGET=x86_64-apple-darwin
base="https://github.com/wrkhse/tack/releases/download/$TAG"

curl -fsSLO "$base/tack-$TAG-$TARGET.tar.gz"
curl -fsSLO "$base/SHA256SUMS"

# Linux (use `shasum -a 256 -c -` on macOS):
grep "tack-$TAG-$TARGET.tar.gz" SHA256SUMS | sha256sum -c -

tar -xzf "tack-$TAG-$TARGET.tar.gz"
export PATH="$PWD:$PATH"
```

Valid targets are `aarch64-apple-darwin`, `x86_64-apple-darwin`, and
`x86_64-unknown-linux-gnu`. The tarball contains three binaries: `tack`,
`tack-daemon` and `tack-hook`. `SHA256SUMS` lists all three tarballs; the
`grep` above checks the one you downloaded.

A Claude mod build sends each guarded Bash call and each tack tool run to
`tack-hook`. This command builds one and prints the paths it emits:

```bash
tack build fixtures/safe-push --out dist --target claude
```

This is a pre-release for trying the current slice, not a stable release.

### From source

Clone the repository and build the workspace with the pinned toolchain in
`rust-toolchain.toml` (Rust 1.100):

```bash
git clone https://github.com/wrkhse/tack.git
cd tack
cargo build --release
```

Build the example plugin with
`target/release/tack build fixtures/safe-push --out dist`.

## Roadmap

- [Slice 1: one plugin, OpenCode, unsandboxed daemon](docs/plans/slices/slice-1.md) —
  Implemented (v0.1.0-rc.2).
- More harnesses and MCP support — Planned.
