//! In-process proofs of the SDK declarations: emitted for a plugin that lists
//! the `sdk` module, removed for one that stops listing it, and refused by
//! name when a module, plugin name or path is not acceptable. No daemon, VM run
//! or child process starts; only the library API and a temporary folder are
//! used.

#![cfg(test)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tack_cli::{BuildOptions, build, build_sdk};
use tack_sdk::CONTRACT_VERSION;

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A temporary folder removed when the test ends.
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
            "tack-build-sdk-{}-{}-{}",
            std::process::id(),
            unique,
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("scratch folder");
        Self { root }
    }

    fn path(&self) -> &Path {
        &self.root
    }

    fn out(&self) -> PathBuf {
        self.root.join("dist")
    }

    fn write_plugin(&self, source: &str) {
        std::fs::write(self.root.join("plugin.luau"), source).expect("fixture file");
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A plugin named `name` whose `modules` table is the Luau literal `modules`.
fn plugin(name: &str, modules: &str) -> String {
    format!("return {{ name = \"{name}\", modules = {modules}, tools = {{}} }}")
}

#[test]
fn a_listing_plugin_gets_the_declarations_in_its_own_folder() {
    let scratch = Scratch::new();
    scratch.write_plugin(&plugin("guard", "{ sdk = {} }"));
    let out = scratch.out();

    let path = build_sdk(scratch.path(), &out)
        .expect("listing plugin builds")
        .expect("declarations are emitted");

    assert_eq!(path, out.join("sdk").join("guard.d.luau"));
    assert_eq!(std::fs::read_dir(&out).expect("output folder").count(), 1);
    let emitted = std::fs::read_to_string(&path).expect("declarations are readable");
    assert_eq!(CONTRACT_VERSION, 1);
    assert!(emitted.ends_with("}\nexport type ContractVersion = 1\n"));
}

#[test]
fn the_declarations_open_in_strict_mode() {
    let scratch = Scratch::new();
    scratch.write_plugin(&plugin("guard", "{ sdk = {} }"));

    let path = build_sdk(scratch.path(), &scratch.out())
        .expect("listing plugin builds")
        .expect("declarations are emitted");

    let emitted = std::fs::read_to_string(&path).expect("declarations are readable");
    assert_eq!(emitted.lines().next(), Some("--!strict"));
}

#[test]
fn a_rebuild_overwrites_its_own_declarations() {
    let scratch = Scratch::new();
    scratch.write_plugin(&plugin("guard", "{ sdk = {} }"));
    let out = scratch.out();

    let first = build_sdk(scratch.path(), &out)
        .expect("first build")
        .expect("declarations are emitted");
    let second = build_sdk(scratch.path(), &out)
        .expect("second build")
        .expect("declarations are emitted");

    assert_eq!(first, second);
    assert!(second.is_file());
}

#[test]
fn a_plugin_that_does_not_list_the_module_emits_nothing() {
    let scratch = Scratch::new();
    let out = scratch.out();

    scratch.write_plugin(r#"return { name = "guard", tools = {} }"#);
    let unlisted = build_sdk(scratch.path(), &out).expect("unlisted plugin builds");
    assert_eq!(unlisted, None);
    assert!(!out.exists());

    scratch.write_plugin(&plugin("guard", "{}"));
    let empty = build_sdk(scratch.path(), &out).expect("plugin with no modules builds");
    assert_eq!(empty, None);
    assert!(!out.exists());
}

#[test]
fn a_plugin_that_stops_listing_the_module_loses_its_declarations() {
    let scratch = Scratch::new();
    let out = scratch.out();
    scratch.write_plugin(&plugin("guard", "{ sdk = {} }"));
    let path = build_sdk(scratch.path(), &out)
        .expect("listing plugin builds")
        .expect("declarations are emitted");

    scratch.write_plugin(r#"return { name = "guard", tools = {} }"#);
    let unlisted = build_sdk(scratch.path(), &out).expect("unlisted plugin builds");

    assert_eq!(unlisted, None);
    assert!(!path.exists());
    assert!(!out.join("sdk").exists());
}

#[test]
fn a_folder_that_still_holds_other_declarations_is_kept() {
    let scratch = Scratch::new();
    let out = scratch.out();
    scratch.write_plugin(&plugin("guard", "{ sdk = {} }"));
    let path = build_sdk(scratch.path(), &out)
        .expect("listing plugin builds")
        .expect("declarations are emitted");
    let sibling = out.join("sdk").join("other.d.luau");
    std::fs::write(&sibling, "keep").expect("sibling declaration");

    scratch.write_plugin(r#"return { name = "guard", tools = {} }"#);
    let unlisted = build_sdk(scratch.path(), &out).expect("unlisted plugin builds");

    assert_eq!(unlisted, None);
    assert!(!path.exists());
    assert_eq!(
        std::fs::read_to_string(&sibling).expect("sibling is kept"),
        "keep"
    );
}

#[test]
fn an_unknown_module_is_refused_by_name_and_writes_nothing() {
    let scratch = Scratch::new();
    scratch.write_plugin(&plugin("guard", "{ bogus = {} }"));
    let out = scratch.out();

    let Err(error) = build_sdk(scratch.path(), &out) else {
        panic!("an unknown module is refused");
    };
    assert_eq!(error.to_string(), "module_missing:bogus");

    let Err(error) = build(scratch.path(), &out, BuildOptions::default()) else {
        panic!("an unknown module is refused for every target");
    };
    assert_eq!(error.to_string(), "module_missing:bogus");
    assert!(!out.exists());
}

#[test]
fn the_first_unknown_module_in_name_order_is_the_one_named() {
    let scratch = Scratch::new();
    scratch.write_plugin(&plugin("guard", "{ zeta = {}, sdk = {}, alpha = {} }"));
    let out = scratch.out();

    let Err(error) = build_sdk(scratch.path(), &out) else {
        panic!("an unknown module is refused");
    };
    assert_eq!(error.to_string(), "module_missing:alpha");
    assert!(!out.exists());
}

#[test]
fn a_modules_value_that_is_not_a_table_is_refused() {
    let scratch = Scratch::new();
    scratch.write_plugin(&plugin("guard", "\"sdk\""));
    let out = scratch.out();

    let Err(error) = build_sdk(scratch.path(), &out) else {
        panic!("a modules string is refused");
    };
    assert_eq!(error.to_string(), "sandbox:tack: modules must be a table");
    assert!(!out.exists());
}

#[test]
fn a_plugin_name_that_is_not_a_plain_file_name_is_refused() {
    let long = "a".repeat(65);

    for name in [
        "../escape",
        "a/b",
        ".hidden",
        "-lead",
        "sp ace",
        long.as_str(),
    ] {
        let scratch = Scratch::new();
        scratch.write_plugin(&plugin(name, "{ sdk = {} }"));
        let out = scratch.out();

        let Err(error) = build_sdk(scratch.path(), &out) else {
            panic!("the name {name} is refused");
        };
        assert_eq!(error.to_string(), format!("plugin_name:{name}"));
        assert!(!out.exists());
    }
}

#[test]
fn a_plain_plugin_name_names_its_declaration_file() {
    let long = "a".repeat(64);

    for name in ["safe-push", "guard_2", "A", "9lives", long.as_str()] {
        let scratch = Scratch::new();
        scratch.write_plugin(&plugin(name, "{ sdk = {} }"));
        let out = scratch.out();

        let path = build_sdk(scratch.path(), &out)
            .expect("a plain name builds")
            .expect("declarations are emitted");
        assert_eq!(path, out.join("sdk").join(format!("{name}.d.luau")));
    }
}

#[test]
fn a_symlink_where_a_declaration_goes_is_refused_and_not_followed() {
    let scratch = Scratch::new();
    let out = scratch.out();
    let elsewhere = scratch.path().join("elsewhere.d.luau");
    std::fs::create_dir_all(out.join("sdk")).expect("sdk folder");
    std::fs::write(&elsewhere, "keep").expect("elsewhere file");
    std::os::unix::fs::symlink(&elsewhere, out.join("sdk").join("guard.d.luau")).expect("symlink");
    scratch.write_plugin(&plugin("guard", "{ sdk = {} }"));

    let Err(error) = build_sdk(scratch.path(), &out) else {
        panic!("a symlinked declaration is refused");
    };

    assert_eq!(
        error.to_string(),
        format!(
            "declaration_path:{}",
            out.join("sdk").join("guard.d.luau").display()
        )
    );
    assert_eq!(
        std::fs::read_to_string(&elsewhere).expect("elsewhere is readable"),
        "keep"
    );
}

#[test]
fn a_symlinked_sdk_folder_is_refused_and_not_followed() {
    let scratch = Scratch::new();
    let out = scratch.out();
    let elsewhere = scratch.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).expect("elsewhere folder");
    std::fs::create_dir_all(&out).expect("output folder");
    std::os::unix::fs::symlink(&elsewhere, out.join("sdk")).expect("symlink");
    scratch.write_plugin(&plugin("guard", "{ sdk = {} }"));

    let Err(error) = build_sdk(scratch.path(), &out) else {
        panic!("a symlinked sdk folder is refused");
    };

    assert_eq!(
        error.to_string(),
        format!("declaration_path:{}", out.join("sdk").display())
    );
    assert_eq!(
        std::fs::read_dir(&elsewhere)
            .expect("elsewhere is readable")
            .count(),
        0
    );
}

#[test]
fn a_directory_where_a_declaration_goes_is_refused() {
    let scratch = Scratch::new();
    let out = scratch.out();
    let occupied = out.join("sdk").join("guard.d.luau");
    std::fs::create_dir_all(&occupied).expect("occupying folder");
    scratch.write_plugin(&plugin("guard", "{ sdk = {} }"));

    let Err(error) = build_sdk(scratch.path(), &out) else {
        panic!("a directory at the declaration path is refused");
    };

    assert_eq!(
        error.to_string(),
        format!("declaration_path:{}", occupied.display())
    );
    assert!(occupied.is_dir());
}

#[test]
fn a_stale_symlinked_sdk_folder_is_left_alone_when_the_module_is_unlisted() {
    let scratch = Scratch::new();
    let out = scratch.out();
    let elsewhere = scratch.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).expect("elsewhere folder");
    std::fs::create_dir_all(&out).expect("output folder");
    std::fs::write(elsewhere.join("guard.d.luau"), "keep").expect("elsewhere declaration");
    std::os::unix::fs::symlink(&elsewhere, out.join("sdk")).expect("symlink");
    scratch.write_plugin(r#"return { name = "guard", tools = {} }"#);

    let unlisted = build_sdk(scratch.path(), &out).expect("unlisted plugin builds");

    assert_eq!(unlisted, None);
    assert_eq!(
        std::fs::read_to_string(elsewhere.join("guard.d.luau")).expect("elsewhere is readable"),
        "keep"
    );
}
