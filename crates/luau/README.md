# tack-luau

Embed a Luau plugin in a Rust host. Each `Sandbox` loads `plugin.luau` into
its own VM and exposes the plugin's hooks, named runnables, and manifest.

## Run a hook and a runnable

This plugin denies a request when the host context marks it read-only. Its
`status` runnable returns a JSON object.

```rust
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tack_luau::api::{Invocation, Outcome};
use tack_luau::{Capabilities, Limits, Sandbox};

struct PluginDir(PathBuf);

impl Drop for PluginDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let path = std::env::temp_dir().join(format!("luau-{}-{nonce}", std::process::id()));
    fs::create_dir(&path)?;
    let plugin = PluginDir(path);
    fs::write(
        plugin.0.join("plugin.luau"),
        r#"
        return {
            name = "storage",
            beforeWrite = function(payload, ctx)
                if ctx.readOnly then
                    return ctx.deny("read-only host")
                end
            end,
            tools = {
                status = {
                    run = function() return { ready = true } end,
                },
            },
        }
        "#,
    )?;

    let limits = Limits::new(16 * 1024 * 1024, 100)?;
    let sandbox = Sandbox::new(&plugin.0, limits, Capabilities::default())?;

    let invocation = Invocation {
        hook: "beforeWrite".into(),
        payload: json!({ "key": "notes" }),
        context: json!({ "readOnly": true }),
    };
    let outcome = sandbox.hook(&invocation, 50)?;
    assert_eq!(outcome, Outcome::Deny { reason: "read-only host".into() });

    let status = sandbox.run("status", &json!({}), 50)?;
    assert_eq!(status, json!({ "ready": true }));

    Ok(())
}
```

Hooks take `(payload, ctx)`. The fields of a host context object appear
directly on `ctx`; another value appears as `ctx.host`. Verdict helpers
and registered capabilities take precedence over host fields. A hook can
use `ctx.rewrite(payload)` to replace the entire payload.

The manifest contains the plugin's `name`, `needs`, a bounded `grants`
array of capability names, and a `tools` array. `grants` defaults to empty,
so no capability is granted; barn enforces grants at runtime. Tool entries
carry their name and other non-function fields.

## Confinement and limits

- `require` resolves from the calling module's folder and only loads modules
  within the plugin folder. It refuses absolute paths, parent components,
  escaping symlinks, and cycles.
- The host sets a Luau allocator ceiling of at least 16 MiB and a time budget
  for startup, manifest reads, and each invocation. A hook or runnable request
  can shorten that budget. The VM interrupt stops runaway Luau code;
  exhaustion returns a named `LimitCause`.
- By default, the per-call context contains verdict helpers but no host
  capabilities. Register callbacks with `Capabilities::insert` to expose
  them as `ctx.<name>(argument)`. Each callback exchanges JSON-compatible
  values, and a returned error carries the capability name and reason.
  Capabilities run in the host: the VM cannot interrupt a blocking Rust
  callback or cap its memory. The host must bound that work itself.
