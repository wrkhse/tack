# tack v1 plans

The plan is [wrkhse/tack#1](https://github.com/wrkhse/tack/issues/1), approved by
the owner on 2026-11-17. Each slice is a vertical feature proven in the real
agent CLIs, in a throwaway HOME, in CI. A slice has its own page once it starts.
A planned slice's page shows how its parts are used; a started slice adds
the structure read from the code.

| Slice                                         | You can                                                                                                                     | Status      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------- |
| [T1](slices/t1.md) core, OpenCode, Pi         | Write `toolBefore` (deny, rewrite), `promptSent` (append) and `toolAfter`, run them in OpenCode and Pi; two plugins combine | Implemented |
| [T2](slices/t2.md) session actions and events | `ctx.session` actions, `responseFinished`, `sessionIdle`, `permissionAsked`, acting outside a hook                          | Planned     |
| T3 tools                                      | Register a tool once: native in OpenCode, Pi and Claude Code mods, an MCP server for Codex                                  | Planned     |
| T4 Claude Code mod                            | Run the same plugins as a Claude Code mod                                                                                   | Planned     |
| T5 `tack-hook` runner and action queue        | Run the plugins in Codex through one shared runner per event                                                                | Planned     |
| T6 Claude Code hook entries                   | The same plugins with mods off                                                                                              | Planned     |
| T7 UI basics                                  | Status line, toast, ask and dialog, slash commands                                                                          | Planned     |
| T8 UI surfaces                                | Panels, sidebars and bands in each harness that has them                                                                    | Planned     |
