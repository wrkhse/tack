//! Entry point for `tack-hook`: one request line in, one reply line out,
//! exit 0 so the caller always reads a verdict.

use std::io::Write;
use std::path::PathBuf;

use tack_hook::locate::{self, SOCKET_NAME};
use tack_hook::start::Launch;
use tack_hook::{Budget, Call, Failure, Limits, forward, plugin_dir, read_request};
use tack_protocol::wire::ReplyError;

fn main() {
    let line = run();
    let mut stdout = std::io::stdout().lock();

    if stdout.write_all(&line).is_ok() {
        let _ = stdout.flush();
    }
}

fn run() -> Vec<u8> {
    // One deadline from process start bounds the whole run.
    let budget = Budget::from_now(Limits::DEFAULT);

    let plugin = match plugin_dir(std::env::args_os().skip(1)) {
        Ok(plugin) => plugin,
        Err(failure) => return failure.into_line(0),
    };

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let failure = Failure::new(
                ReplyError::DaemonError,
                format_args!("cannot start the runtime: {error}"),
            );

            return failure.into_line(0);
        }
    };

    let line = runtime.block_on(handle(plugin, budget));

    // A stdin read that never ends must not hold the process open.
    runtime.shutdown_background();

    line
}

async fn handle(plugin: Option<PathBuf>, budget: Budget) -> Vec<u8> {
    let call = match receive(&budget).await.and_then(Call::parse) {
        Ok(call) => call,
        Err(failure) => return failure.into_line(0),
    };

    let reply = match locate::state_dir() {
        Ok(state) => {
            let socket = state.join(SOCKET_NAME);
            // The daemon binary is found only for a cold start, so a running
            // daemon still answers when none sits beside the hook.
            let start = plugin.map(|plugin| {
                let socket = socket.clone();

                move || {
                    let launch = Launch {
                        bin: locate::daemon_bin()?,
                        socket,
                        plugin,
                        state,
                    };

                    launch.spawn()
                }
            });

            forward(&call, &socket, start, budget).await
        }
        Err(failure) => Err(failure),
    };

    reply.unwrap_or_else(|failure| failure.into_line(call.id()))
}

async fn receive(budget: &Budget) -> Result<Vec<u8>, Failure> {
    let read = tokio::task::spawn_blocking(|| read_request(&mut std::io::stdin().lock()));

    match tokio::time::timeout_at(budget.deadline(), read).await {
        Ok(Ok(line)) => line,
        Ok(Err(error)) => Err(Failure::new(
            ReplyError::Aborted,
            format_args!("reading stdin failed: {error}"),
        )),
        Err(_) => Err(budget.timed_out("request on stdin")),
    }
}
