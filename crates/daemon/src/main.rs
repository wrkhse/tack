//! Entry point for the per-user tack daemon.

use std::path::PathBuf;
use std::sync::Arc;

use tack_daemon::transport::{TransportError, bind};
use tack_daemon::{
    ERR_SOCKET_MISMATCH, EXIT_ENGINE, EXIT_LOCK_BUSY, EXIT_USAGE, SOCKET_NAME, dispatch,
    socket_in_state_dir, state_dir,
};
use tack_protocol::wire::{DEFAULT_DEADLINE_MS, DEFAULT_MEMORY_BYTES};
use tack_runtime::Sandbox;

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

#[tokio::main]
async fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("tack-daemon: {message}");
            std::process::exit(EXIT_USAGE);
        }
    };

    let state = match state_dir() {
        Ok(state) => state,
        Err(message) => {
            eprintln!("tack-daemon: {message}");
            std::process::exit(EXIT_USAGE);
        }
    };
    if !socket_in_state_dir(&state, &args.socket) {
        eprintln!(
            "tack-daemon: {ERR_SOCKET_MISMATCH}: expected {} got {}",
            state.join(SOCKET_NAME).display(),
            args.socket.display()
        );
        std::process::exit(EXIT_USAGE);
    }

    let sandbox = match Sandbox::new(&args.plugin, DEFAULT_MEMORY_BYTES, DEFAULT_DEADLINE_MS) {
        Ok(sandbox) => Arc::new(sandbox),
        Err(error) => {
            eprintln!("tack-daemon: sandbox: {error}");
            std::process::exit(EXIT_ENGINE);
        }
    };

    let server = match bind(&state, &args.socket) {
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
