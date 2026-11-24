//! The tack command-line entry point.

use std::path::{Path, PathBuf};

use tack_cli::{BuildError, BuildOptions, build, build_claude};

const MAX_TIMEOUT_MS: u64 = 60_000;

enum CliError {
    Usage(String),
    Build(BuildError),
}

/// The agent a build emits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Target {
    OpenCode,
    Claude,
}

struct BuildArgs<'a> {
    out: &'a str,
    target: Target,
    options: BuildOptions,
}

fn parse_target(value: &str) -> Result<Target, CliError> {
    match value {
        "opencode" => Ok(Target::OpenCode),
        "claude" => Ok(Target::Claude),
        _ => Err(CliError::Usage(format!("unknown target {value}"))),
    }
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

fn parse_build_args(rest: &[String]) -> Result<BuildArgs<'_>, CliError> {
    let mut out = None;
    let mut target = Target::OpenCode;
    let mut timed = false;
    let mut options = BuildOptions::default();
    let mut args = rest.iter();

    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| CliError::Usage(format!("{flag} needs a value")))?
            .as_str();
        match flag.as_str() {
            "--out" => out = Some(value),
            "--target" => target = parse_target(value)?,
            "--call-timeout-ms" => {
                options.call_timeout_ms = parse_timeout(flag, value)?;
                timed = true;
            }
            "--start-timeout-ms" => {
                options.start_timeout_ms = parse_timeout(flag, value)?;
                timed = true;
            }
            _ => return Err(CliError::Usage(format!("unknown build option {flag}"))),
        }
    }

    let out = out.ok_or_else(|| CliError::Usage("build needs --out <dist-dir>".into()))?;

    if timed && target == Target::Claude {
        return Err(CliError::Usage(
            "the timeout options apply only to --target opencode".into(),
        ));
    }

    Ok(BuildArgs {
        out,
        target,
        options,
    })
}

fn run_build(plugin_dir: &Path, args: &BuildArgs) -> Result<Vec<PathBuf>, BuildError> {
    let out = Path::new(args.out);

    match args.target {
        Target::OpenCode => {
            let (index, manifest) = build(plugin_dir, out, args.options)?;
            Ok(vec![index, manifest])
        }
        Target::Claude => build_claude(plugin_dir, out),
    }
}

fn dispatch(args: &[String]) -> Result<(), CliError> {
    match args {
        [] => print_version(),
        [flag] if flag == "--version" => print_version(),
        [command, plugin_dir, rest @ ..] if command == "build" => {
            let args = parse_build_args(rest)?;
            let written = run_build(Path::new(plugin_dir), &args).map_err(CliError::Build)?;

            for path in written {
                println!("{}", path.display());
            }
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
                     [--target opencode|claude] \
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

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_owned()).collect()
    }

    fn parsed_with_target(args: &[&str]) -> (String, Target, BuildOptions) {
        let args = owned(args);
        let Ok(BuildArgs {
            out,
            target,
            options,
        }) = parse_build_args(&args)
        else {
            panic!("arguments parse");
        };
        (out.to_owned(), target, options)
    }

    fn parsed(args: &[&str]) -> (String, BuildOptions) {
        let (out, _, options) = parsed_with_target(args);
        (out, options)
    }

    fn error_for(args: &[&str]) -> CliError {
        let args = owned(args);
        let Err(error) = parse_build_args(&args) else {
            panic!("expected a usage error");
        };
        error
    }

    fn usage(error: CliError) -> String {
        match error {
            CliError::Usage(message) => message,
            CliError::Build(_) => panic!("expected a usage error"),
        }
    }

    #[test]
    fn parse_build_args_reads_the_out_dir() {
        let (out, options) = parsed(&["--out", "/dist"]);
        assert_eq!(out, "/dist");

        let defaults = BuildOptions::default();
        assert_eq!(options.call_timeout_ms, defaults.call_timeout_ms);
        assert_eq!(options.start_timeout_ms, defaults.start_timeout_ms);
    }

    #[test]
    fn parse_build_args_reads_both_timeouts() {
        let (out, options) = parsed(&[
            "--out",
            "/dist",
            "--call-timeout-ms",
            "250",
            "--start-timeout-ms",
            "750",
        ]);
        assert_eq!(out, "/dist");
        assert_eq!(options.call_timeout_ms, 250);
        assert_eq!(options.start_timeout_ms, 750);
    }

    #[test]
    fn parse_build_args_reports_bad_arguments() {
        assert_eq!(usage(error_for(&[])), "build needs --out <dist-dir>");
        assert_eq!(usage(error_for(&["--out"])), "--out needs a value");
        assert_eq!(
            usage(error_for(&["--bogus", "x"])),
            "unknown build option --bogus"
        );
        assert_eq!(
            usage(error_for(&["--out", "/dist", "--call-timeout-ms", "nope"])),
            "--call-timeout-ms needs a non-negative number"
        );
        assert_eq!(
            usage(error_for(&[
                "--out",
                "/dist",
                "--start-timeout-ms",
                "60001"
            ])),
            "--start-timeout-ms must be at most 60000"
        );
    }

    #[test]
    fn parse_build_args_reads_the_target() {
        assert_eq!(parsed_with_target(&["--out", "/dist"]).1, Target::OpenCode);
        assert_eq!(
            parsed_with_target(&["--out", "/dist", "--target", "opencode"]).1,
            Target::OpenCode
        );

        let (out, target, _) = parsed_with_target(&["--target", "claude", "--out", "/dist"]);
        assert_eq!(out, "/dist");
        assert_eq!(target, Target::Claude);
    }

    #[test]
    fn parse_build_args_refuses_a_bad_target_and_claude_timeouts() {
        assert_eq!(
            usage(error_for(&["--out", "/dist", "--target", "codex"])),
            "unknown target codex"
        );
        assert_eq!(
            usage(error_for(&[
                "--out",
                "/dist",
                "--target",
                "claude",
                "--call-timeout-ms",
                "250"
            ])),
            "the timeout options apply only to --target opencode"
        );
        assert_eq!(
            usage(error_for(&[
                "--start-timeout-ms",
                "250",
                "--target",
                "claude",
                "--out",
                "/dist"
            ])),
            "the timeout options apply only to --target opencode"
        );
    }
}
