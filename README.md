# Workhorse: tack

This branch holds `@workhorse/tack`, an SDK for writing a coding-agent plugin once and running it in OpenCode, Pi, Claude Code and Codex. It is independent of the rest of Workhorse.

Status: v1 is being built in slices; see [docs/plans](docs/plans/README.md). The research behind it is in [`spike/unagent/`](spike/unagent/README.md), kept as evidence.

The Workhorse bridge uses the layer-1 [control wire protocol](https://github.com/wrkhse/barn/blob/main/docs/control.md); tack links to that spec and to no Rust crate.

Other branches:

- `main`: the high-level overview of Workhorse.
- `daemon-v0`: everything before this split (daemon, spikes, uniform-stack proposal).
- `legacy`, `fleet-v0`: earlier versions.
