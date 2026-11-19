# tack

tack lets you write one coding-agent plugin and load it in OpenCode and Pi. A
plugin guards tool calls, adds text to prompts, watches results, acts on its
session and registers tools. The same tools also reach any MCP client over
stdio.

```mermaid
flowchart LR
    Plugin["safe-push.ts<br/>createAgentPlugin"] -->|"bun build"| OC["OpenCode 2.3<br/>.opencode/plugins/"]
    Plugin -->|"bun build"| Pi["Pi 1.5<br/>pi -e"]
    Plugin -->|"serveMcp"| MCP["MCP client<br/>stdio"]
```

## Install

tack is not published to npm. Build it from a source checkout pinned to a
commit, with Bun 1.4.4 and Node 26.13.1:

```bash
git clone https://github.com/wrkhse/tack.git ~/tack
cd ~/tack
git checkout 44475633cc07432dd9b12ef23240407b285d6423
bun install --frozen-lockfile
```

The install also pins the agents tack supports: OpenCode 2.3.0 in
`node_modules/.bin/opencode` and Pi 1.5.2 in `node_modules/.bin/pi`.

## Rewrite a push into a dry run

Save this as `~/tack/safe-push.ts`. It imports tack's entry point, the
package's `exports["."]`:

```ts
import { createAgentPlugin } from "./src/index.ts";

const safePush = createAgentPlugin(() => ({
  name: "safe-push",
  priority: 10,

  toolBefore: (call) =>
    call.tool === "shell" && call.input.command.startsWith("git push")
      ? { rewrite: { command: `${call.input.command} --dry-run` } }
      : undefined,
}));

export default safePush.opencode();
```

Bundle it into your project's plugin folder, where OpenCode loads it on
start. Each bundle carries its own copy of tack.

```bash
bun build safe-push.ts --target=node --format=esm \
  --outfile ~/my-app/.opencode/plugins/safe-push/index.js
```

Open the project with the pinned OpenCode; `--standalone` starts a private
server at that version.

```bash
cd ~/my-app
~/tack/node_modules/.bin/opencode --standalone
```

Pick a provider with `/connect` and a model with `/models`. When the model
runs `git push origin main`, the shell runs
`git push origin main --dry-run`.

## Load the plugin in Pi

Replace the last line of `safe-push.ts` with the Pi output, bundle it, and
pass it with `-e`:

```ts
export default safePush.pi();
```

```bash
bun build safe-push.ts --target=node --format=esm --outfile safe-push.pi.js
cd ~/my-app
~/tack/node_modules/.bin/pi -e ~/tack/safe-push.pi.js
```

## Guard a tool call

`toolBefore` sees every call before it runs. Return `{ deny: reason }` to
stop it, `{ rewrite: { command } }` to change a shell command, or
`undefined` to let it pass. `call.tool` is `"shell"` for OpenCode's
`shell` and Pi's `bash` and `powershell`; `call.name` keeps the agent's own
name.

```ts
toolBefore: (call) =>
  call.tool === "shell" && call.input.command.includes("--force")
    ? { deny: "Force pushes need a person." }
    : undefined,
```

Plugins run by `priority`, lowest first. Each rewrite reaches the next
plugin, and the first deny stops the call. A handler that throws or runs past
its `budgetMs` denies the call, unless `onError.toolBefore` is `"allow"`.

## Act on a session

Every hook gets `ctx.session`. `append` adds a message nobody typed, and
`when` says when the agent reads it:

- `"now"`: at the running turn's next step.
- `"next"`: after the turn ends. This is the default.
- `"wake"`: as `"now"`, and starts a turn on an idle session.

```ts
toolAfter: (call, result, ctx) => {
  if (result.isError) {
    void ctx.session.append(`Check the log for ${call.name}.`, { when: "next" });
  }
},
```

The handle also has `compact()`, `interrupt()` and `setModel(model)`. Each
action resolves to an `Outcome` and never throws. The hooks `sessionCreated`,
`sessionEnded`, `responseFinished`, `sessionIdle` and `permissionAsked`
report what the session does.

## Add a tool

List tools in the definition. tack registers each one natively in OpenCode
and Pi, and decodes every call against `input` before `run` sees it. Save
this as `~/tack/monitor.ts`:

```ts
import { createAgentPlugin, tool } from "./src/index.ts";

const monitorCreate = tool<{ key: string }>({
  name: "monitor_create",
  description: "Start watching a Jira issue",
  input: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
  run: (input) => ({ content: [`watching ${input.key}`] }),
});

export const monitor = createAgentPlugin(() => ({
  name: "monitor",
  tools: { monitor_create: monitorCreate },
}));
```

Export `monitor.opencode()` or `monitor.pi()` from an entry and bundle it as
above. A handler gets 30 seconds by default (`timeoutMs` changes it), and a
result over 256 KiB is refused, never cut.

## Serve tools over MCP

`serveMcp` serves a plugin's tools to any MCP client over stdio. Save an
entry as `~/tack/monitor.mcp.ts`, then bundle it:

```ts
import { serveMcp } from "./src/index.ts";
import { monitor } from "./monitor.ts";

await serveMcp(monitor);
```

```bash
bun build monitor.mcp.ts --target=node --format=esm --outfile monitor.mcp.js
```

Point the client at the bundle, here in your project's `opencode.json`:

```json
{
  "mcp": {
    "servers": {
      "monitor": {
        "type": "local",
        "command": ["node", "/Users/you/tack/monitor.mcp.js"]
      }
    }
  }
}
```

The server runs no hooks and has no session, so a tool with
`needsSession: true` is refused when the server starts.

## Check what an agent supports

`fidelity` holds one table per agent. Each cell says whether a capability is
`native`, `fallback` or `unsupported`, and cites the agent source that
proves it.

```ts
import { capabilities, fidelity } from "./src/index.ts";

for (const capability of capabilities) {
  const cell = fidelity.pi.cells[capability];

  console.log(capability, cell.fidelity, cell.source);
}
```

## Roadmap

The plan is [tack#1](https://github.com/wrkhse/tack/issues/1).

- [x] OpenCode and Pi
- [x] Tools over MCP stdio
- [ ] Claude Code mod ([#28](https://github.com/wrkhse/tack/issues/28))
- [ ] Codex through `tack-hook`
- [ ] Claude Code hook entries
- [ ] UI: status, toast, dialogs, commands
- [ ] UI surfaces

## More

- [Plans](docs/plans/README.md)
- [Adapters](src/agents/README.md) · [Hooks](src/hooks/README.md) ·
  [Host](src/host/README.md) · [Session](src/session/README.md)
- [Tools](src/tools/README.md) · [MCP](src/mcp/README.md) ·
  [Fidelity](src/fidelity/README.md)
- [Conformance](conformance/README.md) ·
  [Research](spike/unagent/README.md)
