# fidelity

One table per agent, as data, with a source for every cell. A missing cell is
a type error because `cells` is keyed by the closed `Capability` union.

| Capability              | What the cell claims                              |
| ----------------------- | ------------------------------------------------- |
| `toolBefore.deny`       | A handler can stop the call before it runs        |
| `toolBefore.rewrite`    | A handler can replace the shell command           |
| `toolBefore.failClosed` | A thrown handler blocks the call                  |
| `promptSent.append`     | A handler can append text to the next prompt      |
| `toolAfter.observe`     | A handler sees the final call and its result      |
| `host.sharedRealm`      | Every location in the process shares one JS realm |

Each cell says `native`, `fallback` or `unsupported`, how tack gets the
behavior, and where the agent's code or docs prove it. OpenCode sources are
`https://github.com/anomalyco/opencode/blob/v2.3.0/<path>#L<a>-L<b>`; Pi
sources are `@earendil-works/pi-coding-agent@1.5.2/<path>#L<a>-L<b>`; the
shared-realm row cites `spike/unagent/REALM-SPIKE.md`.

```ts
import { capabilities, fidelity } from "@workhorse/tack";

for (const capability of capabilities) {
  const cell = fidelity.opencode.cells[capability];

  console.log(capability, cell.fidelity, cell.source);
}
```

| Table      | Versions         | Verified with | Verified at  |
| ---------- | ---------------- | ------------- | ------------ |
| `opencode` | `>=2.3.0 <2.4.0` | `2.3.0`       | `2026-11-17` |
| `pi`       | `>=1.5.2 <1.6.0` | `1.5.2`       | `2026-11-17` |

A cell turns `unsupported` when its conformance scenario fails. The unit test
checks that every cell has a non-empty `how` and a citable source; the
conformance suite re-proves each cell in the real CLI.
