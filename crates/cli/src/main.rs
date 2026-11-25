//! The tack command-line entry point.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use tack_cli::{BuildError, BuildOptions, build, build_claude, build_codex, build_pi};

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
    Codex,
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
        "codex" => Ok(Target::Codex),
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

fn run_build(
    plugin_dir: &Path,
    args: &BuildArgs,
    env: &impl Fn(&str) -> Option<OsString>,
) -> Result<Vec<PathBuf>, BuildError> {
    let out = Path::new(args.out);

    match args.target {
        Target::OpenCode => {
            let (index, manifest) = build(plugin_dir, out, args.options)?;
            Ok(vec![index, manifest])
        }
        Target::Claude => build_claude(plugin_dir, out),
        Target::Pi => build_pi(plugin_dir, out).map(|path| vec![path]),
        Target::Codex => {
            let codex_home = env("CODEX_HOME");
            let home = env("HOME");
            let codex_home =
                tack_adapter_codex::resolve_home(codex_home.as_deref(), home.as_deref())
                    .map_err(BuildError::Codex)?;

            build_codex(plugin_dir, out, &codex_home)
        }
    }
}

/// Run one command, reading the environment through `env` and handing each
/// line of output to `emit`, so tests need neither a child process nor
/// changes to the process environment.
fn dispatch(
    args: &[String],
    env: &impl Fn(&str) -> Option<OsString>,
    emit: &mut impl FnMut(&str),
) -> Result<(), CliError> {
    match args {
        [] => emit(&version()),
        [flag] if flag == "--version" => emit(&version()),
        [command, plugin_dir, rest @ ..] if command == "build" => {
            let args = parse_build_args(rest)?;
            let written = run_build(Path::new(plugin_dir), &args, env).map_err(CliError::Build)?;

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
    let env = |name: &str| std::env::var_os(name);

    if let Err(error) = dispatch(&args, &env, &mut |line| println!("{line}")) {
        match error {
            CliError::Usage(message) => {
                eprintln!("tack: {message}");
                eprintln!(
                    "usage: tack [--version | build <plugin-dir> --out <dist-dir> \
                     [--target opencode|claude|pi|codex] \
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

    /// Run `dispatch` with an empty environment and collect every emitted line.
    fn run(args: &[&str]) -> (Result<(), CliError>, Vec<String>) {
        run_with_env(args, &[])
    }

    fn run_with_env(args: &[&str], vars: &[(&str, &Path)]) -> (Result<(), CliError>, Vec<String>) {
        let env = |name: &str| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.as_os_str().to_owned())
        };
        let mut lines = Vec::new();
        let result = dispatch(&owned(args), &env, &mut |line| lines.push(line.to_owned()));
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
            usage(error_for(&["--out", "/dist", "--target", "cursor"])),
            "unknown target cursor"
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
    fn parse_build_args_reads_codex_and_refuses_its_timeouts() {
        assert_eq!(
            parsed_with_target(&["--out", "/dist", "--target", "codex"]).1,
            Target::Codex
        );

        for flag in ["--call-timeout-ms", "--start-timeout-ms"] {
            assert_eq!(
                usage(error_for(&[
                    "--out", "/dist", "--target", "codex", flag, "250"
                ])),
                "the timeout options apply only to --target opencode"
            );
        }
    }

    #[test]
    fn dispatch_build_emits_the_codex_paths_and_the_codex_home_files() {
        let scratch = Scratch::new();
        let out = scratch.root.join("dist");
        let home = scratch.root.join("codex-home");
        std::fs::create_dir_all(&out).expect("out");
        std::fs::create_dir_all(&home).expect("home");
        let out_arg = out.display().to_string();

        let (result, lines) = run_with_env(
            &["build", &fixture(), "--out", &out_arg, "--target", "codex"],
            &[("CODEX_HOME", &home)],
        );

        let Ok(()) = result else {
            panic!("codex build succeeds");
        };
        let codex = std::fs::canonicalize(&out).expect("out").join("codex");
        let home = std::fs::canonicalize(&home).expect("home");
        let expected: Vec<String> = [
            codex.join("hooks.json"),
            codex.join("pre-tool-use.js"),
            codex.join("session-start.js"),
            codex.join("mcp.js"),
            codex.join("config.toml"),
            codex.join("run-hook.sh"),
            home.join("hooks.json"),
            home.join("config.toml"),
        ]
        .iter()
        .map(|path| path.display().to_string())
        .collect();

        assert_eq!(lines, expected);
    }

    #[test]
    fn dispatch_build_codex_without_a_home_writes_nothing() {
        let scratch = Scratch::new();
        let out = scratch.root.join("dist");
        let out_arg = out.display().to_string();

        let (result, lines) = run(&["build", &fixture(), "--out", &out_arg, "--target", "codex"]);

        let Err(CliError::Build(BuildError::Codex(error))) = result else {
            panic!("a missing Codex home is refused");
        };
        assert_eq!(
            error.to_string(),
            "codex_home:neither CODEX_HOME nor HOME is set"
        );
        assert_eq!(lines, Vec::<String>::new());
        assert!(!out.exists());
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

    fn assert_pi_extension_matches_template(script: &str, plugin_dir_literal: &str) {
        let template = include_str!("../../../adapters/pi/register.js");
        let template_lines = template.split_inclusive('\n');
        let script_lines = script.split_inclusive('\n');

        assert_eq!(template_lines.clone().count(), script_lines.clone().count());

        for (before, after) in template_lines.zip(script_lines) {
            if !before.contains("__TACK_") {
                assert_eq!(before, after);
            }
        }

        let values = [
            ("PLUGIN_DIR", plugin_dir_literal),
            ("PROTOCOL_VERSION", "1"),
            ("BUDGET_MS", "8500"),
            ("MAX_FRAME_BYTES", "1048576"),
            (
                "DENY_REASONS",
                concat!(
                    r#"["socket_missing","timeout","socket_closed","malformed_reply","#,
                    r#""protocol_version","limit","script","unknown_tool","daemon_error","#,
                    r#""aborted","unsupported_hook","socket_untrusted","hook_missing","busy"]"#,
                ),
            ),
        ];
        let mut expected = template.to_owned();

        for (name, value) in values {
            let prefix = format!("const {name} = ");
            let constant = script.lines().find_map(|line| line.strip_prefix(&prefix));

            assert_eq!(
                constant.and_then(|line| line.strip_suffix(';')),
                Some(value)
            );

            expected = expected.replace(&format!("__TACK_{name}__"), value);
        }

        assert_eq!(script, expected);
        assert_eq!(script.find("__TACK_"), None);
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

        assert_pi_extension_matches_template(&script, &literal.to_string());
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

    #[test]
    fn dispatch_build_codex_refuses_a_bad_home_without_writing_adapter_files() {
        let scratch = Scratch::new();
        let home = scratch.root.join("home");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::write(home.join("config.toml"), "hooks = {}\n").expect("config");
        std::fs::write(home.join("hooks.json"), "{}\n").expect("hooks");
        let out = scratch.root.join("dist");

        let (result, lines) = run_with_env(
            &[
                "build",
                &fixture(),
                "--out",
                &out.display().to_string(),
                "--target",
                "codex",
            ],
            &[("CODEX_HOME", &home)],
        );

        let Err(CliError::Build(BuildError::Codex(_))) = result else {
            panic!("a Codex home tack cannot merge into is refused");
        };
        assert_eq!(lines, Vec::<String>::new());
        assert!(!out.join("codex").exists());
        assert_eq!(
            std::fs::read(home.join("config.toml")).expect("config"),
            b"hooks = {}\n"
        );
        assert_eq!(
            std::fs::read(home.join("hooks.json")).expect("hooks"),
            b"{}\n"
        );
    }
}
