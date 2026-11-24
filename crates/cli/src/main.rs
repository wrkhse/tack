//! The tack command-line entry point.

use std::path::{Path, PathBuf};

use tack_cli::{BuildError, BuildOptions, build, build_claude, build_pi};

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
    Pi,
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
        "pi" => Ok(Target::Pi),
        _ => Err(CliError::Usage(format!("unknown target {value}"))),
    }
}

fn version() -> String {
    format!("tack {}", env!("CARGO_PKG_VERSION"))
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

    if timed && target != Target::OpenCode {
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
        Target::Pi => build_pi(plugin_dir, out).map(|path| vec![path]),
    }
}

/// Run one command, handing each line of output to `emit` so tests can read
/// it without a child process.
fn dispatch(args: &[String], emit: &mut impl FnMut(&str)) -> Result<(), CliError> {
    match args {
        [] => emit(&version()),
        [flag] if flag == "--version" => emit(&version()),
        [command, plugin_dir, rest @ ..] if command == "build" => {
            let args = parse_build_args(rest)?;
            let written = run_build(Path::new(plugin_dir), &args).map_err(CliError::Build)?;

            for path in written {
                emit(&path.display().to_string());
            }
        }
        _ => return Err(CliError::Usage("unknown arguments".into())),
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(error) = dispatch(&args, &mut |line| println!("{line}")) {
        match error {
            CliError::Usage(message) => {
                eprintln!("tack: {message}");
                eprintln!(
                    "usage: tack [--version | build <plugin-dir> --out <dist-dir> \
                     [--target opencode|claude|pi] \
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
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    /// A temporary output folder removed when the test ends.
    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock is after the epoch")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "tack-cli-dispatch-{}-{}-{}",
                std::process::id(),
                unique,
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&root).expect("scratch folder");
            Self { root }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn fixture() -> String {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/safe-push")
            .display()
            .to_string()
    }

    fn owned(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_owned()).collect()
    }

    /// Run `dispatch` and collect every emitted line.
    fn run(args: &[&str]) -> (Result<(), CliError>, Vec<String>) {
        let mut lines = Vec::new();
        let result = dispatch(&owned(args), &mut |line| lines.push(line.to_owned()));
        (result, lines)
    }

    fn dispatched(args: &[&str]) -> Vec<String> {
        let (result, lines) = run(args);
        let Ok(()) = result else {
            panic!("dispatch succeeds");
        };
        lines
    }

    fn dispatch_usage(args: &[&str]) -> (String, Vec<String>) {
        let (result, lines) = run(args);
        let Err(error) = result else {
            panic!("expected a usage error");
        };
        (usage(error), lines)
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
        assert_eq!(
            parsed_with_target(&["--out", "/dist", "--target", "pi"]).1,
            Target::Pi
        );
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

    #[test]
    fn dispatch_emits_the_version() {
        let expected = vec![format!("tack {}", env!("CARGO_PKG_VERSION"))];

        assert_eq!(dispatched(&[]), expected);
        assert_eq!(dispatched(&["--version"]), expected);
    }

    #[test]
    fn parse_build_args_refuses_pi_timeouts() {
        for flag in ["--call-timeout-ms", "--start-timeout-ms"] {
            assert_eq!(
                usage(error_for(&[
                    "--out", "/dist", "--target", "pi", flag, "250"
                ])),
                "the timeout options apply only to --target opencode"
            );
        }
    }

    #[test]
    fn dispatch_build_emits_the_opencode_paths() {
        let scratch = Scratch::new();
        let out = scratch.root.join("dist");
        let out_arg = out.display().to_string();
        let expected = vec![
            out.join("opencode/index.js").display().to_string(),
            out.join("opencode/manifest.json").display().to_string(),
        ];

        let default = dispatched(&["build", &fixture(), "--out", &out_arg]);
        let named = dispatched(&[
            "build",
            &fixture(),
            "--out",
            &out_arg,
            "--target",
            "opencode",
        ]);

        assert_eq!(default, expected);
        assert_eq!(named, expected);
    }

    #[test]
    fn dispatch_build_emits_the_claude_paths() {
        let scratch = Scratch::new();
        let out = scratch.root.join("dist");
        let out_arg = out.display().to_string();

        let lines = dispatched(&["build", &fixture(), "--out", &out_arg, "--target", "claude"]);

        assert_eq!(
            lines,
            vec![
                out.join("claude/.claude-plugin/plugin.json")
                    .display()
                    .to_string(),
                out.join("claude/hooks/hooks.json").display().to_string(),
                out.join("claude/hooks/register.js").display().to_string(),
            ]
        );
    }

    #[test]
    fn dispatch_build_emits_only_the_pi_extension() {
        let scratch = Scratch::new();
        let out = scratch.root.join("dist");
        let out_arg = out.display().to_string();

        let lines = dispatched(&["build", &fixture(), "--out", &out_arg, "--target", "pi"]);

        let pi = out.join("pi");
        let extension = pi.join("extension.js");
        let paths = |folder: &Path| {
            std::fs::read_dir(folder)
                .expect("output directory")
                .map(|entry| entry.expect("output entry").path())
                .collect::<Vec<_>>()
        };

        assert_eq!(lines, [extension.display().to_string()]);
        assert_eq!(paths(&out), std::slice::from_ref(&pi));
        assert_eq!(paths(&pi), std::slice::from_ref(&extension));

        let script = std::fs::read_to_string(extension).expect("emitted extension");
        let canonical = std::fs::canonicalize(fixture()).expect("canonical plugin");
        let literal = serde_json::json!(canonical.to_str().expect("UTF-8 path"));
        let golden = include_str!("../../../adapters/pi/golden/register.js");

        assert_eq!(
            script,
            golden.replace(r#""/plugins/safe-push""#, &literal.to_string())
        );
    }

    #[test]
    fn dispatch_build_refuses_an_unknown_need_for_pi() {
        let scratch = Scratch::new();
        let out = scratch.root.join("dist");
        std::fs::write(
            scratch.root.join("plugin.luau"),
            r#"return { name = "barn-plugin", needs = { "barn" }, tools = {} }"#,
        )
        .expect("fixture file");

        let (result, lines) = run(&[
            "build",
            scratch.root.to_str().expect("UTF-8 plugin path"),
            "--out",
            out.to_str().expect("UTF-8 output path"),
            "--target",
            "pi",
        ]);

        let Err(CliError::Build(BuildError::NeedMissing(need))) = result else {
            panic!("unknown need must be refused");
        };
        assert_eq!(need, "barn");
        assert_eq!(lines, Vec::<String>::new());
        assert!(!out.exists());
    }

    #[test]
    fn dispatch_refuses_an_unknown_command() {
        let scratch = Scratch::new();
        let out_arg = scratch.root.join("dist").display().to_string();
        let unknown = (String::from("unknown arguments"), Vec::new());

        assert_eq!(
            dispatch_usage(&["bogus", &fixture(), "--out", &out_arg]),
            unknown
        );
        assert_eq!(dispatch_usage(&["build"]), unknown);
        assert_eq!(dispatch_usage(&["--bogus"]), unknown);
        assert!(!scratch.root.join("dist").exists());
    }

    #[test]
    fn dispatch_reports_a_build_usage_error() {
        assert_eq!(
            dispatch_usage(&["build", &fixture()]),
            (String::from("build needs --out <dist-dir>"), Vec::new())
        );
    }
}
