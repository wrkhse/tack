//! Entry point for the per-user tack daemon.

use std::fmt;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tack_daemon::in_process::InProcessStall;
use tack_daemon::stall::{StallClient, SystemClock};
use tack_daemon::transport::{TransportError, bind};
use tack_daemon::{
    ERR_SOCKET_MISMATCH, EXIT_ENGINE, EXIT_LOCK_BUSY, EXIT_USAGE, SOCKET_NAME, frames,
    socket_in_state_dir, state_dir,
};
use tack_protocol::wire::{DEFAULT_DEADLINE_MS, PROTOCOL_VERSION, Reply, ReplyError, Request};

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

/// A named error reply for a request that never reached a verdict.
fn daemon_error(id: u64, error: impl fmt::Display) -> Reply {
    let message = error.to_string();

    eprintln!("tack-daemon: {message}");

    Reply::Error {
        id,
        version: PROTOCOL_VERSION,
        error: ReplyError::DaemonError,
        message,
    }
}

type Client = StallClient<SystemClock, InProcessStall>;

/// Route one wire request through the stall and back into a wire reply.
fn handle(request: &Request, client: &Mutex<Client>) -> Reply {
    let id = request.id();
    let frame = match frames::to_stall(request) {
        Ok(frame) => frame,
        Err(error) => return daemon_error(id, error),
    };

    let reply = {
        let Ok(mut client) = client.lock() else {
            return daemon_error(id, "stall lock poisoned");
        };

        match client.call(&frame) {
            Ok(reply) => reply,
            Err(error) => return daemon_error(id, error),
        }
    };

    match frames::from_stall(request, reply) {
        Ok(reply) => reply,
        Err(error) => daemon_error(id, error),
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

    let stall = match InProcessStall::new(args.plugin) {
        Ok(stall) => stall,
        Err(error) => {
            eprintln!("tack-daemon: sandbox: tack: {error}");
            std::process::exit(EXIT_ENGINE);
        }
    };
    let client = Mutex::new(StallClient::new(
        SystemClock,
        stall,
        Duration::from_millis(DEFAULT_DEADLINE_MS),
    ));

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

    if let Err(error) = server.serve(move |request| handle(&request, &client)).await {
        eprintln!("tack-daemon: serve: {error}");
        std::process::exit(EXIT_ENGINE);
    }
}
