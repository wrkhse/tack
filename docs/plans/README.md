# tack v1 plans

Implemented features and the shipped parts of T3:

- [T1: hooks for OpenCode and Pi](slices/t1.md): **Implemented.** Deny or
  rewrite tool calls, append to prompts, observe tool results, and combine
  plugins by priority.
- [T2: session actions and events](slices/t2.md): **Implemented.** Act on a
  session outside a hook and observe session, response and permission events.
- [T3: tools](slices/t3.md): **Building.** Register tools in OpenCode and Pi
  and serve them through a generated stdio MCP entry.

[Roadmap: tack#1](https://github.com/wrkhse/tack/issues/1).

[Claude Code mod RFC: tack#28](https://github.com/wrkhse/tack/issues/28).
