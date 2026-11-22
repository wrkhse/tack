//! Entry point for the per-user tack daemon.

use std::path::PathBuf;
use std::sync::Arc;

use tack_protocol::wire::{DEFAULT_DEADLINE_MS, DEFAULT_MEMORY_BYTES, Outcome, Reply, Request};
use tack_runtime::transport::TransportError;
use tack_runtime::{EngineError, Sandbox};

const EXIT_USAGE: i32 = 2;
const EXIT_LOCK_BUSY: i32 = 3;
const EXIT_ENGINE: i32 = 4;

struct Args {
    socket: PathBuf,
    plugin: PathBuf,
}

fn parse_args() -> Result<Args, String> {
    let mut socket = None;
    let mut plugin = None;
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket = Some(args.next().ok_or("--socket needs a path")?.into()),
            "--plugin" => plugin = Some(args.next().ok_or("--plugin needs a dir")?.into()),
            other => return Err(format!("unknown argument {other}")),
        }
    }

    Ok(Args {
        socket: socket.ok_or("missing --socket <path>")?,
        plugin: plugin.ok_or("missing --plugin <dir>")?,
    })
}

fn engine_message(error: &EngineError) -> String {
    error.to_string()
}

fn dispatch(sandbox: &Sandbox, request: Request) -> Reply {
    match request {
        Request::Hook { id, hook, call } => {
            if hook != "toolBefore" {
                eprintln!("tack-daemon: hook {hook} unsupported");

                return Reply::Error {
                    id,
                    message: format!("unsupported_hook:{hook}"),
                };
            }

            match sandbox.hook("toolBefore", &call, DEFAULT_DEADLINE_MS) {
                Ok(Outcome::Allow) => {
                    eprintln!("tack-daemon: hook toolBefore allow");

                    Reply::Hook {
                        id,
                        outcome: Outcome::Allow,
                    }
                }
                Ok(Outcome::Deny { reason }) => {
                    eprintln!("tack-daemon: hook toolBefore deny {reason}");

                    Reply::Hook {
                        id,
                        outcome: Outcome::Deny { reason },
                    }
                }
                Ok(Outcome::Rewrite { input }) => {
                    eprintln!("tack-daemon: hook toolBefore rewrite");

                    Reply::Hook {
                        id,
                        outcome: Outcome::Rewrite { input },
                    }
                }
                Err(error) => {
                    let message = engine_message(&error);
                    eprintln!("tack-daemon: hook toolBefore error {message}");

                    Reply::Error { id, message }
                }
            }
        }
        Request::Tool { id, name, input } => {
            match sandbox.tool(&name, &input, DEFAULT_DEADLINE_MS) {
                Ok(content) => {
                    eprintln!("tack-daemon: tool {name} ok");

                    Reply::Tool { id, content }
                }
                Err(error) => {
                    let message = engine_message(&error);
                    eprintln!("tack-daemon: tool {name} error {message}");

                    Reply::Error { id, message }
                }
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("tack-daemon: {message}");
            std::process::exit(EXIT_USAGE);
        }
    };

    let sandbox = match Sandbox::new(&args.plugin, DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS) {
        Ok(sandbox) => Arc::new(sandbox),
        Err(error) => {
            eprintln!("tack-daemon: sandbox: {}", engine_message(&error));
            std::process::exit(EXIT_ENGINE);
        }
    };

    let lock = args.socket.with_extension("lock");
    let server = match tack_runtime::transport::bind(&args.socket, &lock).await {
        Ok(server) => server,
        Err(TransportError::LockBusy) => {
            eprintln!("tack-daemon: lock_busy");
            std::process::exit(EXIT_LOCK_BUSY);
        }
        Err(error) => {
            eprintln!("tack-daemon: bind: {error}");
            std::process::exit(EXIT_ENGINE);
        }
    };

    if let Err(error) = server
        .serve(move |request| dispatch(&sandbox, request))
        .await
    {
        eprintln!("tack-daemon: serve: {error}");
        std::process::exit(EXIT_ENGINE);
    }
}
