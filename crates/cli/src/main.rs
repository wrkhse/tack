//! The tack command-line entry point.

use std::path::Path;

use tack_cli::{BuildError, BuildOptions, build};

const MAX_TIMEOUT_MS: u64 = 60_000;

enum CliError {
    Usage(String),
    Build(BuildError),
}

fn print_version() {
    println!("tack {}", env!("CARGO_PKG_VERSION"));
}

fn parse_timeout(flag: &str, value: &str) -> Result<u64, CliError> {
    let timeout = value
        .parse::<u64>()
        .map_err(|_| CliError::Usage(format!("{flag} needs a non-negative number")))?;
    if timeout > MAX_TIMEOUT_MS {
        return Err(CliError::Usage(format!(
            "{flag} must be at most {MAX_TIMEOUT_MS}"
        )));
    }
    Ok(timeout)
}

fn parse_build_args(rest: &[String]) -> Result<(&str, BuildOptions), CliError> {
    let mut out = None;
    let mut options = BuildOptions::default();
    let mut args = rest.iter();

    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| CliError::Usage(format!("{flag} needs a value")))?
            .as_str();
        match flag.as_str() {
            "--out" => out = Some(value),
            "--call-timeout-ms" => {
                options.call_timeout_ms = parse_timeout(flag, value)?;
            }
            "--start-timeout-ms" => {
                options.start_timeout_ms = parse_timeout(flag, value)?;
            }
            _ => return Err(CliError::Usage(format!("unknown build option {flag}"))),
        }
    }

    let out = out.ok_or_else(|| CliError::Usage("build needs --out <dist-dir>".into()))?;
    Ok((out, options))
}

fn dispatch(args: &[String]) -> Result<(), CliError> {
    match args {
        [] => print_version(),
        [flag] if flag == "--version" => print_version(),
        [command, plugin_dir, rest @ ..] if command == "build" => {
            let (out, options) = parse_build_args(rest)?;
            let (index, manifest) =
                build(Path::new(plugin_dir), Path::new(out), options).map_err(CliError::Build)?;
            println!("{}", index.display());
            println!("{}", manifest.display());
        }
        _ => return Err(CliError::Usage("unknown arguments".into())),
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(error) = dispatch(&args) {
        match error {
            CliError::Usage(message) => {
                eprintln!("tack: {message}");
                eprintln!(
                    "usage: tack [--version | build <plugin-dir> --out <dist-dir> \
                     [--call-timeout-ms <n>] [--start-timeout-ms <n>]]"
                );
                std::process::exit(2);
            }
            CliError::Build(error) => {
                eprintln!("tack: {error}");
                std::process::exit(1);
            }
        }
    }
}
