//! The per-user daemon that evaluates hooks and runs tools inside an mlua
//! sandbox with memory and deadline limits.

pub mod transport;

use std::path::{Path, PathBuf};

use tack_protocol::wire::{
    DEFAULT_DEADLINE_MS, Outcome, PROTOCOL_VERSION, Reply, ReplyError, Request,
};
use tack_runtime::{EngineError, Sandbox};

pub const EXIT_USAGE: i32 = 2;
pub const EXIT_LOCK_BUSY: i32 = 3;
pub const EXIT_ENGINE: i32 = 4;

pub const SOCKET_NAME: &str = "tack.sock";
pub const ERR_SOCKET_MISMATCH: &str = "socket_not_in_state_dir";

pub struct Args {
    pub socket: PathBuf,
    pub plugin: PathBuf,
}

pub fn parse_args() -> Result<Args, String> {
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

pub fn state_dir_from(
    tack_state_dir: Option<&str>,
    xdg_state_home: Option<&str>,
    home: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(dir) = tack_state_dir.filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    if let Some(dir) = xdg_state_home.filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir).join("tack"));
    }

    let home = home
        .filter(|home| !home.is_empty())
        .ok_or_else(|| "cannot determine state dir: set TACK_STATE_DIR or HOME".to_owned())?;

    Ok(PathBuf::from(home).join(".local/state/tack"))
}

pub fn state_dir() -> Result<PathBuf, String> {
    let tack = std::env::var("TACK_STATE_DIR").ok();
    let xdg = std::env::var("XDG_STATE_HOME").ok();
    let home = std::env::var("HOME").ok();

    state_dir_from(tack.as_deref(), xdg.as_deref(), home.as_deref())
}

pub fn socket_in_state_dir(state_dir: &Path, socket: &Path) -> bool {
    socket == state_dir.join(SOCKET_NAME)
}

pub fn reply_error(id: u64, error: EngineError) -> Reply {
    let kind = match &error {
        EngineError::Limit(_) => ReplyError::Limit,
        EngineError::UnknownTool(_) => ReplyError::UnknownTool,
        // Script, load and invalid-result failures are all script failures.
        _ => ReplyError::Script,
    };
    let message = error.to_string();

    eprintln!("tack-daemon: engine error {message}");

    Reply::Error {
        id,
        version: PROTOCOL_VERSION,
        error: kind,
        message,
    }
}

pub fn version_error(id: u64, version: u32) -> Reply {
    eprintln!("tack-daemon: unsupported protocol version {version}");

    Reply::Error {
        id,
        version: PROTOCOL_VERSION,
        error: ReplyError::ProtocolVersion,
        message: format!("unsupported protocol version {version}"),
    }
}

pub fn dispatch(sandbox: &Sandbox, request: Request) -> Reply {
    let id = request.id();
    let version = request.version();

    if version != PROTOCOL_VERSION {
        return version_error(id, version);
    }

    match request {
        Request::Hook { id, hook, call, .. } => {
            if hook != "toolBefore" {
                eprintln!("tack-daemon: hook {hook} unsupported");

                return Reply::Error {
                    id,
                    version: PROTOCOL_VERSION,
                    error: ReplyError::UnsupportedHook,
                    message: format!("unsupported_hook:{hook}"),
                };
            }

            match sandbox.hook("toolBefore", &call, DEFAULT_DEADLINE_MS) {
                Ok(outcome) => {
                    match &outcome {
                        Outcome::Allow => eprintln!("tack-daemon: hook toolBefore allow"),
                        Outcome::Deny { reason } => {
                            eprintln!("tack-daemon: hook toolBefore deny {reason}")
                        }
                        Outcome::Rewrite { .. } => {
                            eprintln!("tack-daemon: hook toolBefore rewrite")
                        }
                    }

                    Reply::Hook {
                        id,
                        version: PROTOCOL_VERSION,
                        outcome,
                    }
                }
                Err(error) => reply_error(id, error),
            }
        }
        Request::Tool {
            id, name, input, ..
        } => match sandbox.tool(&name, &input, DEFAULT_DEADLINE_MS) {
            Ok(content) => {
                eprintln!("tack-daemon: tool {name} ok");

                Reply::Tool {
                    id,
                    version: PROTOCOL_VERSION,
                    content,
                }
            }
            Err(error) => reply_error(id, error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_dir_follows_the_environment_precedence() {
        assert_eq!(
            state_dir_from(Some("/custom"), Some("/xdg"), Some("/home/u")).unwrap(),
            PathBuf::from("/custom")
        );
        assert_eq!(
            state_dir_from(None, Some("/xdg"), Some("/home/u")).unwrap(),
            PathBuf::from("/xdg/tack")
        );
        assert_eq!(
            state_dir_from(None, None, Some("/home/u")).unwrap(),
            PathBuf::from("/home/u/.local/state/tack")
        );
        assert!(state_dir_from(None, None, None).is_err());
    }

    #[test]
    fn empty_environment_values_are_ignored() {
        assert_eq!(
            state_dir_from(Some(""), Some("/xdg"), Some("/home/u")).unwrap(),
            PathBuf::from("/xdg/tack")
        );
        assert_eq!(
            state_dir_from(None, Some(""), Some("/home/u")).unwrap(),
            PathBuf::from("/home/u/.local/state/tack")
        );
    }

    #[test]
    fn socket_must_be_the_state_dir_socket() {
        let state = PathBuf::from("/state");

        assert!(socket_in_state_dir(&state, &state.join("tack.sock")));
        assert!(!socket_in_state_dir(&state, &state.join("other.sock")));
        assert!(!socket_in_state_dir(&state, Path::new("/other/tack.sock")));
    }
}
