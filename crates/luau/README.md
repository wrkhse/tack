# tack-luau

Embed a Luau plugin in a Rust host. Each `Sandbox` loads `plugin.luau` into
its own VM and exposes the plugin's hooks, tools, and manifest.

## Run a hook and a tool

From the repository root, use the included [safe-push
fixture](../../fixtures/safe-push). Its hook denies a shell call that starts
with `git push`; its `guard_status` tool returns a text response.

```rust
use std::path::Path;

use serde_json::json;
use tack_luau::api::{Call, Content, Outcome};
use tack_luau::{Capabilities, EngineError, Limits, Sandbox};

fn main() -> Result<(), EngineError> {
    let limits = Limits {
        memory_bytes: 16 * 1024 * 1024,
        call_deadline_ms: 100,
    };
    let sandbox = Sandbox::new(
        Path::new("fixtures/safe-push"),
        limits,
        Capabilities::default(),
    )?;

    let call = Call {
        tool: "shell".into(),
        name: "shell".into(),
        input: json!({ "command": "git push origin main" }),
        session_id: None,
    };
    let outcome = sandbox.hook("toolBefore", &call, 50)?;
    assert_eq!(outcome, Outcome::Deny { reason: "push blocked".into() });

    let content = sandbox.tool("guard_status", &json!({}), 50)?;
    assert_eq!(
        content,
        vec![Content {
            kind: "text".into(),
            text: "guard_status: daemon ok".into(),
        }],
    );

    Ok(())
}
```

## Confinement and limits

- `require` resolves from the calling module's folder and only loads modules
  within the plugin folder. It refuses absolute paths, parent components,
  escaping symlinks, and cycles.
- The host caps memory tracked by Luau's allocator and sets the time budget
  for startup, manifest reads, and each invocation. A hook or tool request
  can shorten that budget. The VM interrupt stops runaway Luau code;
  exhaustion returns a named `LimitCause`.
- By default, the per-call context contains verdict helpers but no host
  capabilities. Register callbacks with `Capabilities::insert` to expose
  them as `ctx.<name>(argument)`. Each callback exchanges JSON-compatible
  values, and a returned error carries the capability name and reason.
  Capabilities run in the host: the VM cannot interrupt a blocking Rust
  callback or cap its memory. The host must bound that work itself.
