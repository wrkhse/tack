use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use super::*;

static NEXT: AtomicU64 = AtomicU64::new(0);

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
            "tack-codex-home-{}-{}-{}",
            std::process::id(),
            unique,
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("scratch folder");
        Self { root }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn handlers(dir: &str) -> [Handler; 2] {
    [
        Handler {
            event: Event::PreToolUse,
            matcher: Some("^Bash$"),
            command: format!("sh '{dir}/run-hook.sh' '{dir}/pre-tool-use.js'"),
        },
        Handler {
            event: Event::SessionStart,
            matcher: None,
            command: format!("sh '{dir}/run-hook.sh' '{dir}/session-start.js'"),
        },
    ]
}

fn other_group() -> Value {
    json!({
        "matcher": "^Write$",
        "hooks": [{ "type": "command", "command": "./lint.sh" }]
    })
}

#[test]
fn a_fresh_home_gets_both_groups_and_their_trust() {
    let scratch = Scratch::new();
    let [pre, start] = handlers("/out/codex");

    let installed = install(&scratch.root, &handlers("/out/codex")).expect("install");

    let source = scratch.root.join("hooks.json").display().to_string();
    let hooks: Value =
        serde_json::from_str(&fs::read_to_string(&installed.hooks).expect("hooks")).expect("JSON");
    let config = fs::read_to_string(&installed.config).expect("config");

    assert_eq!(
        hooks,
        json!({ "hooks": { "PreToolUse": [pre.group()], "SessionStart": [start.group()] } })
    );
    assert_eq!(
        config,
        format!(
            "[hooks.state.\"{source}:pre_tool_use:0:0\"]\nenabled = true\n\
             trusted_hash = \"{}\"\n\n\
             [hooks.state.\"{source}:session_start:0:0\"]\nenabled = true\n\
             trusted_hash = \"{}\"\n",
            pre.trusted_hash(),
            start.trusted_hash()
        )
    );
}

#[test]
fn other_groups_keep_their_index_and_a_rebuild_replaces_tack_in_place() {
    let first = handlers("/old/codex");
    let second = handlers("/new/codex");
    let existing = json!({
        "description": "mine",
        "hooks": { "PreToolUse": [other_group()], "Stop": [other_group()] }
    })
    .to_string();

    let (once, groups) = merge_hooks(Some(&existing), &first).expect("first build");
    assert_eq!(groups, [1, 0]);

    let mut edited: Value = serde_json::from_str(&once).expect("JSON");
    edited["hooks"]["PreToolUse"]
        .as_array_mut()
        .expect("list")
        .push(other_group());

    let (twice, groups) = merge_hooks(Some(&edited.to_string()), &second).expect("rebuild");
    let twice: Value = serde_json::from_str(&twice).expect("JSON");

    assert_eq!(groups, [1, 0]);
    assert_eq!(
        twice,
        json!({
            "description": "mine",
            "hooks": {
                "PreToolUse": [other_group(), second[0].group(), other_group()],
                "SessionStart": [second[1].group()],
                "Stop": [other_group()]
            }
        })
    );
}

#[test]
fn hooks_files_tack_cannot_merge_are_refused() {
    let tack = handlers("/out/codex");
    let twice = json!({ "hooks": { "PreToolUse": [tack[0].group(), tack[0].group()] } });

    for (text, expected) in [
        ("[]", "codex_hooks:not an object"),
        (r#"{"extra":1}"#, "codex_hooks:unknown field extra"),
        (r#"{"hooks":[]}"#, "codex_hooks:hooks is not an object"),
        (
            r#"{"hooks":{"PreToolUse":{}}}"#,
            "codex_hooks:PreToolUse is not a list",
        ),
        (
            &twice.to_string(),
            "codex_hooks:two tack groups in PreToolUse",
        ),
    ] {
        let error = merge_hooks(Some(text), &tack).expect_err("refused");
        assert_eq!(error.to_string(), expected);
    }
}

#[test]
fn state_merge_keeps_other_tables_and_rewrites_only_tack_keys() {
    let trust = [(
        "/h/hooks.json:pre_tool_use:1:0".to_owned(),
        "sha256:new".to_owned(),
    )];
    let existing = "model = \"o3\"\n\n\
        [hooks.state.\"/h/hooks.json:pre_tool_use:0:0\"]\nenabled = false\n\n\
        [hooks.state.\"/h/hooks.json:pre_tool_use:1:0\"]\nenabled = true\n\
        trusted_hash = \"sha256:old\"\n\n\
        [projects.\"/repo\"]\ntrust_level = \"trusted\"\n";

    let merged = merge_state(existing, &trust).expect("merge");

    assert_eq!(
        merged,
        "model = \"o3\"\n\n\
         [hooks.state.\"/h/hooks.json:pre_tool_use:0:0\"]\nenabled = false\n\n\
         [projects.\"/repo\"]\ntrust_level = \"trusted\"\n\n\
         [hooks.state.\"/h/hooks.json:pre_tool_use:1:0\"]\nenabled = true\n\
         trusted_hash = \"sha256:new\"\n"
    );
    assert_eq!(merge_state(&merged, &trust).expect("again"), merged);
}

#[test]
fn state_merge_refuses_what_it_cannot_place() {
    let trust = [(
        "/h/hooks.json:pre_tool_use:0:0".to_owned(),
        "sha256:x".to_owned(),
    )];

    for (text, expected) in [
        ("notes = \"\"\"\nx\n\"\"\"\n", "a multi-line string"),
        ("[[hooks.PreToolUse]]\n", "an array of hooks tables"),
        (
            "hooks = { state = {} }\n",
            "hooks.state outside its own tables",
        ),
        (
            "hooks.state.x.enabled = true\n",
            "hooks.state outside its own tables",
        ),
        (
            "[hooks]\nstate = {}\n",
            "hooks.state outside its own tables",
        ),
        (
            "[hooks.state]\n\"/h/hooks.json:pre_tool_use:0:0\" = {}\n",
            "a tack hook key outside its table header",
        ),
    ] {
        assert_eq!(
            merge_state(text, &trust),
            Err(CodexError::Config(expected.to_owned())),
            "{text}"
        );
    }
}

#[test]
fn a_refused_config_leaves_both_files_untouched() {
    let scratch = Scratch::new();
    let hooks = scratch.root.join("hooks.json");
    let config = scratch.root.join("config.toml");
    fs::write(&hooks, "{}\n").expect("hooks");
    fs::write(&config, "hooks = {}\n").expect("config");

    let error = install(&scratch.root, &handlers("/out/codex")).expect_err("refused");

    assert_eq!(
        error,
        CodexError::Config("hooks.state outside its own tables".into())
    );
    assert_eq!(fs::read_to_string(&hooks).expect("hooks"), "{}\n");
    assert_eq!(fs::read_to_string(&config).expect("config"), "hooks = {}\n");
}

#[test]
fn read_optional_reports_a_path_it_cannot_read_and_only_a_missing_one_is_none() {
    let scratch = Scratch::new();
    let file = scratch.root.join("config.toml");
    fs::write(&file, "x = 1\n").expect("file");

    assert_eq!(read_optional(&scratch.root.join("missing.toml")), Ok(None));
    assert_eq!(read_optional(&file), Ok(Some("x = 1\n".to_owned())));
    assert!(matches!(
        read_optional(&scratch.root),
        Err(CodexError::Io(_))
    ));
}

fn command_group(command: &str) -> Value {
    json!({ "hooks": [{ "type": "command", "command": command, "timeout": 10 }] })
}

#[test]
fn only_the_wrapped_tack_script_is_a_tack_group() {
    let wrapped = "sh '/out/codex/run-hook.sh' '/out/codex/pre-tool-use.js'";

    assert!(is_tack_group(&command_group(wrapped), Event::PreToolUse));

    for command in [
        "bash '/out/codex/run-hook.sh' '/out/codex/pre-tool-use.js'",
        "sh '/out/codex/other.sh' '/out/codex/pre-tool-use.js'",
        "node '/out/codex/pre-tool-use.js'",
        "sh '/out/codex/run-hook.sh' '/out/codex/session-start.js'",
        "sh '/out/codex/run-hook.sh' '/out/codex/pre-tool-use.js' --extra",
    ] {
        assert!(
            !is_tack_group(&command_group(command), Event::PreToolUse),
            "{command}"
        );
    }

    let prompt = json!({ "hooks": [{ "type": "prompt", "command": wrapped }] });
    let two = json!({ "hooks": [
        { "type": "command", "command": wrapped },
        { "type": "command", "command": wrapped }
    ] });

    assert!(!is_tack_group(&prompt, Event::PreToolUse));
    assert!(!is_tack_group(&two, Event::PreToolUse));
}

#[test]
fn a_state_key_outside_hooks_or_another_key_inside_it_is_kept() {
    let trust = [(
        "/h/hooks.json:pre_tool_use:0:0".to_owned(),
        "sha256:x".to_owned(),
    )];
    let existing = "[tui]\nstate = \"compact\"\n\n[hooks]\ndescription = \"mine\"\n";

    let merged = merge_state(existing, &trust).expect("both lines are kept");

    assert_eq!(
        merged,
        "[tui]\nstate = \"compact\"\n\n[hooks]\ndescription = \"mine\"\n\n\
         [hooks.state.\"/h/hooks.json:pre_tool_use:0:0\"]\nenabled = true\n\
         trusted_hash = \"sha256:x\"\n"
    );
}

#[test]
fn the_home_resolves_as_codex_resolves_it() {
    let scratch = Scratch::new();
    let file = scratch.root.join("file");
    fs::write(&file, "").expect("file");

    let canonical = fs::canonicalize(&scratch.root).expect("canonical");
    let messy = scratch
        .root
        .join(".")
        .join("..")
        .join(scratch.root.file_name().expect("name"));

    assert_eq!(
        resolve_home(Some(messy.as_os_str()), None).expect("CODEX_HOME"),
        canonical
    );
    assert_eq!(
        resolve_home(None, Some(scratch.root.as_os_str())).expect("HOME"),
        scratch.root.join(".codex")
    );
    assert!(scratch.root.join(".codex").is_dir());
    assert!(matches!(
        resolve_home(Some(file.as_os_str()), None),
        Err(CodexError::Home(_))
    ));
    assert!(matches!(
        resolve_home(Some(OsStr::new("")), Some(OsStr::new("relative"))),
        Err(CodexError::Home(_))
    ));
}

#[test]
fn a_rebuild_after_a_user_group_is_inserted_removes_the_stale_tack_state() {
    let scratch = Scratch::new();
    install(&scratch.root, &handlers("/out/codex")).expect("first install");

    let hooks_path = scratch.root.join("hooks.json");
    let mut hooks: Value =
        serde_json::from_str(&fs::read_to_string(&hooks_path).expect("hooks")).expect("JSON");
    hooks["hooks"]["PreToolUse"]
        .as_array_mut()
        .expect("list")
        .insert(0, other_group());
    fs::write(&hooks_path, hooks.to_string()).expect("edited hooks");

    install(&scratch.root, &handlers("/new/codex")).expect("rebuild");
    let config = fs::read_to_string(scratch.root.join("config.toml")).expect("config");

    let source = hooks_path.display().to_string();
    let stale = state_header(&format!("{source}:pre_tool_use:0:0"));
    let current = state_header(&format!("{source}:pre_tool_use:1:0"));

    assert!(!config.contains(&stale), "{config}");
    assert!(config.contains(&current), "{config}");
}
