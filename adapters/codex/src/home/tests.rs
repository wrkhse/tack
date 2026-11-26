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

    let merged = merge_state(
        existing,
        &trust,
        "/h/hooks.json",
        &HashSet::new(),
        &HookKeys::default(),
        HashRecord::Present,
    )
    .expect("merge");

    assert_eq!(
        merged,
        "model = \"o3\"\n\n\
         [hooks.state.\"/h/hooks.json:pre_tool_use:0:0\"]\nenabled = false\n\n\
         [projects.\"/repo\"]\ntrust_level = \"trusted\"\n\n\
         [hooks.state.\"/h/hooks.json:pre_tool_use:1:0\"]\nenabled = true\n\
         trusted_hash = \"sha256:new\"\n"
    );
    assert_eq!(
        merge_state(
            &merged,
            &trust,
            "/h/hooks.json",
            &HashSet::new(),
            &HookKeys::default(),
            HashRecord::Present
        )
        .expect("again"),
        merged
    );
}

#[test]
fn state_merge_drops_only_tables_holding_an_old_tack_hash() {
    let trust = [(
        "/h/hooks.json:pre_tool_use:4:0".to_owned(),
        "sha256:tack".to_owned(),
    )];
    let stale = HashSet::from(["sha256:old".to_owned()]);

    // 0:0 holds tack's old hash, 1:0 a user's hash, 2:0 no hash, 4:0 is a
    // current tack key, and another hooks file's table holds the old hash too.
    let existing = "model = \"o3\"\n\n\
        [hooks.state.\"/h/hooks.json:pre_tool_use:0:0\"]\nenabled = true\n\
        trusted_hash = \"sha256:old\"\n\n\
        [hooks.state.\"/h/hooks.json:pre_tool_use:1:0\"]\nenabled = true\n\
        trusted_hash = \"sha256:user\"\n\n\
        [hooks.state.\"/h/hooks.json:pre_tool_use:2:0\"]\nenabled = false\n\n\
        [hooks.state.\"/h/hooks.json:pre_tool_use:4:0\"]\nenabled = true\n\
        trusted_hash = \"sha256:previous\"\n\n\
        [hooks.state.\"/p/hooks.json:pre_tool_use:0:0\"]\nenabled = true\n\
        trusted_hash = \"sha256:old\"\n\n\
        [projects.\"/repo\"]\ntrust_level = \"trusted\"\n";

    let merged = merge_state(
        existing,
        &trust,
        "/h/hooks.json",
        &stale,
        &HookKeys::default(),
        HashRecord::Present,
    )
    .expect("merge");

    assert_eq!(
        merged,
        "model = \"o3\"\n\n\
         [hooks.state.\"/h/hooks.json:pre_tool_use:1:0\"]\nenabled = true\n\
         trusted_hash = \"sha256:user\"\n\n\
         [hooks.state.\"/h/hooks.json:pre_tool_use:2:0\"]\nenabled = false\n\n\
         [hooks.state.\"/p/hooks.json:pre_tool_use:0:0\"]\nenabled = true\n\
         trusted_hash = \"sha256:old\"\n\n\
         [projects.\"/repo\"]\ntrust_level = \"trusted\"\n\n\
         [hooks.state.\"/h/hooks.json:pre_tool_use:4:0\"]\nenabled = true\n\
         trusted_hash = \"sha256:tack\"\n"
    );
    assert_eq!(
        merge_state(
            &merged,
            &trust,
            "/h/hooks.json",
            &stale,
            &HookKeys::default(),
            HashRecord::Present
        )
        .expect("again"),
        merged
    );
}

#[test]
fn state_merge_keeps_a_state_table_from_another_source_that_shares_the_prefix() {
    let stale = HashSet::from(["sha256:old".to_owned()]);

    // "/h/hooks.json:extra" is another hooks file whose path starts with this
    // source and a colon, so its table holds the old hash but is not tack's.
    let existing = "model = \"o3\"\n\n\
        [hooks.state.\"/h/hooks.json:pre_tool_use:0:0\"]\nenabled = true\n\
        trusted_hash = \"sha256:old\"\n\n\
        [hooks.state.\"/h/hooks.json:extra:pre_tool_use:0:0\"]\nenabled = true\n\
        trusted_hash = \"sha256:old\"\n\n\
        [projects.\"/repo\"]\ntrust_level = \"trusted\"\n";

    let merged = merge_state(
        existing,
        &[],
        "/h/hooks.json",
        &stale,
        &HookKeys::default(),
        HashRecord::Present,
    )
    .expect("merge");

    assert_eq!(
        merged,
        "model = \"o3\"\n\n\
         [hooks.state.\"/h/hooks.json:extra:pre_tool_use:0:0\"]\nenabled = true\n\
         trusted_hash = \"sha256:old\"\n\n\
         [projects.\"/repo\"]\ntrust_level = \"trusted\"\n"
    );
}

const HASHES_HEADER: &str = "# The hashes tack's Codex hooks were trusted under, newest last.\n";

fn hash(index: usize) -> String {
    format!("sha256:{index:064x}")
}

#[test]
fn state_merge_uses_recorded_old_tack_hashes_when_no_tack_group_remains() {
    let scratch = Scratch::new();
    let [pre, start] = handlers("/out/codex");
    let source = scratch.root.join(HOOKS_FILE).display().to_string();
    let old = format!("sha256:{}", "0123456789abcdef".repeat(4));

    // No tack group is left in hooks.json, so no old hash comes from it. Only
    // tack-hashes marks the table at group 1 as tack's.
    fs::write(scratch.root.join(HOOKS_FILE), "{}\n").expect("hooks");
    fs::write(
        scratch.root.join(CONFIG_FILE),
        format!(
            "model = \"o3\"\n\n[hooks.state.\"{source}:pre_tool_use:1:0\"]\n\
             enabled = true\ntrusted_hash = \"{old}\"\n"
        ),
    )
    .expect("config");
    fs::write(scratch.root.join(HASHES_FILE), format!("{old}\n")).expect("hashes");

    let installed = install(&scratch.root, &handlers("/out/codex")).expect("install");

    // config.toml holds only its tables: no record of any hash.
    assert_eq!(
        fs::read_to_string(&installed.config).expect("config"),
        format!(
            "model = \"o3\"\n\n\
             [hooks.state.\"{source}:pre_tool_use:0:0\"]\nenabled = true\n\
             trusted_hash = \"{pre}\"\n\n\
             [hooks.state.\"{source}:session_start:0:0\"]\nenabled = true\n\
             trusted_hash = \"{start}\"\n",
            pre = pre.trusted_hash(),
            start = start.trusted_hash()
        )
    );
    assert_eq!(
        fs::read_to_string(&installed.hashes).expect("hashes"),
        format!(
            "{HASHES_HEADER}{old}\n{}\n{}\n",
            pre.trusted_hash(),
            start.trusted_hash()
        )
    );
}

#[test]
fn a_rebuild_records_each_hash_once_beside_the_config() {
    let scratch = Scratch::new();
    let [pre, start] = handlers("/out/codex");

    let first = install(&scratch.root, &handlers("/out/codex")).expect("first install");
    let config = fs::read_to_string(&first.config).expect("config");
    let second = install(&scratch.root, &handlers("/out/codex")).expect("rebuild");

    assert_eq!(first.hashes, scratch.root.join(HASHES_FILE));
    assert_eq!(
        fs::read_to_string(&second.hashes).expect("hashes"),
        format!(
            "{HASHES_HEADER}{}\n{}\n",
            pre.trusted_hash(),
            start.trusted_hash()
        )
    );
    assert_eq!(fs::read_to_string(&second.config).expect("config"), config);
}

#[test]
fn a_malformed_hash_record_is_refused_and_nothing_is_written() {
    let scratch = Scratch::new();
    let hashes = scratch.root.join(HASHES_FILE);
    fs::write(&hashes, "sha256:not-hex\n").expect("hashes");

    let error = install(&scratch.root, &handlers("/out/codex")).expect_err("refused");

    assert_eq!(
        error,
        CodexError::Config("a malformed tack-hashes line".into())
    );
    assert_eq!(
        fs::read_to_string(&hashes).expect("hashes"),
        "sha256:not-hex\n"
    );
    assert!(!scratch.root.join(HOOKS_FILE).exists());
    assert!(!scratch.root.join(CONFIG_FILE).exists());
}

#[test]
fn only_exact_hashes_comments_and_blank_lines_are_read() {
    let a = format!("sha256:{}", "0123456789abcdef".repeat(4));
    let b = hash(7);

    assert_eq!(
        parse_hashes(&format!("# note\n\n  # indented\n{a}\n   \n{b}\n{a}\n")),
        Ok(vec![a.clone(), b])
    );

    for line in [
        format!(" {a}"),
        format!("{a} "),
        format!("sha256:{}", "a".repeat(63)),
        format!("sha256:{}", "a".repeat(65)),
        format!("sha256:{}", "A".repeat(64)),
        format!("sha256:{}g", "a".repeat(63)),
        format!("md5:{}", "a".repeat(64)),
        "sha256:".to_owned(),
    ] {
        assert_eq!(
            parse_hashes(&format!("{a}\n{line}\n")),
            Err(CodexError::Config("a malformed tack-hashes line".into())),
            "{line}"
        );
    }
}

#[test]
fn the_hash_record_keeps_the_newest_and_never_drops_one_in_use() {
    let recorded: Vec<String> = (0..40).map(hash).collect();
    let trust = [
        ("a".to_owned(), hash(3)),
        ("b".to_owned(), hash(100)),
        ("c".to_owned(), String::new()),
    ];

    let rendered = render_hashes(&recorded, &trust);

    // 38 earlier hashes and the two in use: the oldest are dropped down to 32,
    // and hash 3, still in use, moves to the newest end instead.
    let mut expected: Vec<String> = (10..40).map(hash).collect();
    expected.push(hash(3));
    expected.push(hash(100));

    assert_eq!(
        rendered,
        format!("{HASHES_HEADER}{}\n", expected.join("\n"))
    );
    assert_eq!(rendered.lines().count(), MAX_HASHES + 1);
}

#[test]
fn a_hash_record_is_read_as_its_newest_hashes_only() {
    let lines: Vec<String> = (0..40).map(hash).collect();

    assert_eq!(
        parse_hashes(&format!("{}\n", lines.join("\n"))),
        Ok((8..40).map(hash).collect())
    );
}

fn plain_group(command: &str) -> Value {
    json!({ "hooks": [{ "type": "command", "command": command }] })
}

fn plain_hash(command: &str) -> String {
    let group = plain_group(command);

    handler_hash(Event::PreToolUse, &group, &group["hooks"][0]).expect("a plain hook hashes")
}

/// tack's two tables as a build appends them, its `PreToolUse` group at `pre_group`.
fn tack_tables(source: &str, pre_group: usize) -> String {
    let [pre, start] = handlers("/out/codex");

    format!(
        "[hooks.state.\"{source}:pre_tool_use:{pre_group}:0\"]\nenabled = true\n\
         trusted_hash = \"{}\"\n\n\
         [hooks.state.\"{source}:session_start:0:0\"]\nenabled = true\n\
         trusted_hash = \"{}\"\n",
        pre.trusted_hash(),
        start.trusted_hash()
    )
}

/// A state table of `source` at `PreToolUse` group `group`, handler 0.
fn state_table(source: &str, group: usize, enabled: bool, hash: &str) -> String {
    format!(
        "[hooks.state.\"{source}:pre_tool_use:{group}:0\"]\nenabled = {enabled}\n\
         trusted_hash = \"{hash}\"\n"
    )
}

#[test]
fn a_first_build_without_a_hash_record_drops_an_orphan_stale_table() {
    let scratch = Scratch::new();
    let source = scratch.root.join(HOOKS_FILE).display().to_string();

    // An older tack left this table, and nothing recorded its hash: hooks.json
    // has no PreToolUse group 1, and there is no tack-hashes yet.
    let orphan = state_table(&source, 1, true, &hash(1));
    fs::write(scratch.root.join(HOOKS_FILE), "{}\n").expect("hooks");
    fs::write(
        scratch.root.join(CONFIG_FILE),
        format!("model = \"o3\"\n\n{orphan}"),
    )
    .expect("config");

    let installed = install(&scratch.root, &handlers("/out/codex")).expect("install");

    assert_eq!(
        fs::read_to_string(&installed.config).expect("config"),
        format!("model = \"o3\"\n\n{}", tack_tables(&source, 0))
    );
}

#[test]
fn an_orphan_table_stays_once_a_hash_record_exists() {
    let scratch = Scratch::new();
    let source = scratch.root.join(HOOKS_FILE).display().to_string();

    // tack-hashes exists, so this is not a first build, and the table's hash
    // is not one tack recorded: it is not tack's to drop.
    let orphan = state_table(&source, 1, true, &hash(1));
    fs::write(scratch.root.join(HOOKS_FILE), "{}\n").expect("hooks");
    fs::write(scratch.root.join(CONFIG_FILE), &orphan).expect("config");
    fs::write(scratch.root.join(HASHES_FILE), HASHES_HEADER).expect("hashes");

    let installed = install(&scratch.root, &handlers("/out/codex")).expect("install");

    assert_eq!(
        fs::read_to_string(&installed.config).expect("config"),
        format!("{orphan}\n{}", tack_tables(&source, 0))
    );
}

#[test]
fn a_table_of_a_hook_that_still_exists_stays_whatever_its_hash() {
    let scratch = Scratch::new();
    let source = scratch.root.join(HOOKS_FILE).display().to_string();
    let unhashable = json!({ "hooks": [
        { "type": "command", "command": "./x.sh", "statusMessage": "x" }
    ] });
    let hooks = json!({ "hooks": { "PreToolUse": [
        plain_group("./lint.sh"),
        plain_group("./fmt.sh"),
        unhashable
    ] } });

    // Group 0's table holds its hook's hash, group 1's a hash its hook does
    // not have, as after the user moved or edited a hook, and group 2's hook
    // is a shape tack cannot hash. Each hook still exists, so each table stays.
    let matching = state_table(&source, 0, false, &plain_hash("./lint.sh"));
    let mismatched = state_table(&source, 1, true, &hash(2));
    let unverified = state_table(&source, 2, true, &hash(3));
    let existing = format!("{matching}\n{mismatched}\n{unverified}");
    fs::write(scratch.root.join(HOOKS_FILE), hooks.to_string()).expect("hooks");
    fs::write(scratch.root.join(CONFIG_FILE), &existing).expect("config");

    let installed = install(&scratch.root, &handlers("/out/codex")).expect("install");

    // No tack-hashes existed, so this is a first build, and still none drops.
    assert_eq!(
        fs::read_to_string(&installed.config).expect("config"),
        format!("{existing}\n{}", tack_tables(&source, 3))
    );
}

#[test]
fn hook_keys_tell_a_hook_from_an_unknown_and_a_missing_one() {
    let hooks = json!({ "hooks": {
        "PreToolUse": [
            plain_group("./lint.sh"),
            { "hooks": "not a list" },
            { "hooks": [{ "type": "prompt", "prompt": "x" }] }
        ],
        "SessionStart": []
    } });
    let keys = HookKeys::read(&hooks);

    assert_eq!(keys.at("pre_tool_use", 0, 0), KeyHook::Present);
    assert_eq!(keys.at("pre_tool_use", 0, 1), KeyHook::Missing);
    assert_eq!(keys.at("pre_tool_use", 1, 0), KeyHook::Unknown);
    assert_eq!(keys.at("pre_tool_use", 2, 0), KeyHook::Present);
    assert_eq!(keys.at("pre_tool_use", 3, 0), KeyHook::Missing);
    assert_eq!(keys.at("session_start", 0, 0), KeyHook::Missing);
    assert_eq!(keys.at("stop", 0, 0), KeyHook::Unknown);
    assert_eq!(
        HookKeys::read(&json!({})).at("pre_tool_use", 0, 0),
        KeyHook::Unknown
    );
}

#[test]
fn only_a_recorded_hash_or_a_first_upgrade_orphan_drops_a_table() {
    let stale = HashSet::from(["sha256:old".to_owned()]);
    let line = |hash: &str| format!("trusted_hash = \"{hash}\"\n");
    let present = HashRecord::Present;
    let missing = HashRecord::Missing;

    // A recorded tack hash is proof, whatever hook the key holds.
    for hook in [KeyHook::Present, KeyHook::Unknown, KeyHook::Missing] {
        assert!(
            drops(hook, &line("sha256:old"), &stale, present),
            "{hook:?}"
        );
    }

    // Without it, only a key with no hook drops, and only on a first build.
    assert!(!drops(KeyHook::Present, &line("sha256:x"), &stale, missing));
    assert!(!drops(KeyHook::Unknown, &line("sha256:x"), &stale, missing));
    assert!(drops(KeyHook::Missing, &line("sha256:x"), &stale, missing));
    assert!(!drops(KeyHook::Missing, &line("sha256:x"), &stale, present));

    // A hash spelled otherwise than a plain string, or none, never drops.
    let literal = "trusted_hash = 'sha256:old'\n";
    assert!(!drops(KeyHook::Missing, literal, &stale, missing));
    assert!(!drops(
        KeyHook::Missing,
        "enabled = true\n",
        &stale,
        missing
    ));
}

#[test]
fn a_hash_record_longer_than_its_bound_is_refused() {
    let scratch = Scratch::new();
    let hashes = scratch.root.join(HASHES_FILE);
    let limit = usize::try_from(MAX_HASHES_BYTES).expect("the bound fits");

    // One comment line of exactly the bound is read.
    fs::write(
        &hashes,
        format!("{}\n", "#".repeat(limit.saturating_sub(1))),
    )
    .expect("hashes");
    install(&scratch.root, &handlers("/out/codex")).expect("a file at the bound is read");

    // One byte more is refused, and the file is left as it is.
    let over = format!("{}\n", "#".repeat(limit));
    fs::write(&hashes, &over).expect("hashes");
    let error = install(&scratch.root, &handlers("/out/codex")).expect_err("refused");

    assert_eq!(
        error,
        CodexError::Config("a malformed tack-hashes line".into())
    );
    assert_eq!(fs::read_to_string(&hashes).expect("hashes"), over);
}

#[test]
fn a_hash_record_that_cannot_be_opened_is_an_io_error_and_only_a_missing_one_is_none() {
    let scratch = Scratch::new();
    let blocker = scratch.root.join("blocker");
    fs::write(&blocker, "").expect("blocker");

    // A path under a regular file fails to open, and not as missing.
    let unreadable = blocker.join(HASHES_FILE);
    let expected = fs::File::open(&unreadable).expect_err("a file is not a folder");

    assert_eq!(
        read_hashes_file(&unreadable),
        Err(CodexError::Io(expected.to_string()))
    );
    assert_eq!(read_hashes_file(&scratch.root.join(HASHES_FILE)), Ok(None));
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
            merge_state(
                text,
                &trust,
                "/h/hooks.json",
                &HashSet::new(),
                &HookKeys::default(),
                HashRecord::Present
            ),
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

    let merged = merge_state(
        existing,
        &trust,
        "/h/hooks.json",
        &HashSet::new(),
        &HookKeys::default(),
        HashRecord::Present,
    )
    .expect("both lines are kept");

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
