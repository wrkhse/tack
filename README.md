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

  toolBefore = function(call, ctx)
    if call.tool == "shell"
      and string.find(call.input.command, "^git push") then
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

The slice 1 build is published as a **pre-release** on the
[releases page](https://github.com/wrkhse/tack/releases). Each release carries
one tarball per target and a single `SHA256SUMS` covering all three. Download
the tarball for your target, verify it, unpack it, and put both binaries on
your `PATH`:

```bash
TAG=v0.1.0-rc.1
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
`x86_64-unknown-linux-gnu`. The tarball contains `tack` and `tack-daemon`.
`SHA256SUMS` lists all three tarballs; the `grep` above checks the one you
downloaded. This is a pre-release for trying slice 1, not a stable release.

### From source

Clone the repository and build the workspace with the pinned toolchain in
`rust-toolchain.toml` (Rust 1.100):

```bash
git clone https://github.com/wrkhse/tack.git
cd tack
cargo build --release
```

The binary is at `target/release/tack`. A command to build a Luau plugin is
planned in slice 1.

## Roadmap

- Slice 1: one plugin, OpenCode, unsandboxed daemon — In progress
  ([tack#34](https://github.com/wrkhse/tack/issues/34)).
- More harnesses and MCP support — Planned.
