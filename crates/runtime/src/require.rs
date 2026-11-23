//! A scoped replacement for Luau's require, confined to one plugin folder.
//!
//! The stock loader reaches arbitrary files and participates in its own cache.
//! This one resolves every specifier against the requiring module's folder,
//! confines every load to the plugin folder, refuses escapes and cycles, and
//! evaluates each module into the same VM. Each module's chunk gets an
//! environment whose require closes over that module's folder, so a deferred
//! call still resolves against the file that defined it.
//!
//! Luau's stock global require (`FsRequirer`) is replaced with a refuser before
//! the VM is sandboxed. A module's scoped require shadows it in its own
//! environment; code that reaches globals through getfenv or setfenv finds the
//! refuser instead of a loader for arbitrary files.

use std::collections::HashMap;
use std::fmt;
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use mlua::chunk::ChunkMode;
use mlua::{Function, Lua, Result as LuaResult, Table, Value as LuaValue};

/// The largest module source the loader will read, in bytes.
const MAX_MODULE_BYTES: u64 = 1024 * 1024;

/// Error raised by the global require refuser. Scoped requires shadow it.
pub const REQUIRE_CONFINED: &str = "tack: require is confined to the plugin folder";

/// A refused module load, carrying the specifier that caused it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequireCause {
    Absolute(String),
    Parent(String),
    Escape(String),
    Cycle(String),
    Missing(String),
    TooLarge(String),
    Unreadable { spec: String, detail: String },
}

impl fmt::Display for RequireCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Absolute(spec) => {
                write!(f, "tack: require rejects absolute path: {spec}")
            }
            Self::Parent(spec) => write!(f, "tack: require rejects parent path: {spec}"),
            Self::Escape(spec) => write!(f, "tack: require escapes plugin folder: {spec}"),
            Self::Cycle(spec) => write!(f, "tack: require cycle detected: {spec}"),
            Self::Missing(spec) => write!(f, "tack: require module not found: {spec}"),
            Self::TooLarge(spec) => write!(f, "tack: require module too large: {spec}"),
            Self::Unreadable { spec, detail } => {
                write!(f, "tack: require cannot read {spec}: {detail}")
            }
        }
    }
}

impl std::error::Error for RequireCause {}

pub struct RequireState {
    root: PathBuf,
    cache: HashMap<PathBuf, LuaValue>,
    loading: Vec<PathBuf>,
}

enum Resolved {
    Cached(LuaValue),
    Load {
        canonical: PathBuf,
        source: String,
        name: String,
    },
}

impl RequireState {
    pub fn new(folder: &Path) -> Result<Self, String> {
        let root = std::fs::canonicalize(folder)
            .map_err(|error| format!("tack: plugin folder unavailable: {error}"))?;
        Ok(Self {
            root,
            cache: HashMap::new(),
            loading: Vec::new(),
        })
    }

    fn resolve(&mut self, spec: &str, base: &Path) -> Result<Resolved, RequireCause> {
        let relative = Path::new(spec);
        if relative.is_absolute() {
            return Err(RequireCause::Absolute(spec.to_owned()));
        }
        if relative
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        {
            return Err(RequireCause::Parent(spec.to_owned()));
        }

        let candidate = base.join(relative);
        let canonical = self.locate(&candidate, spec)?;
        if let Some(value) = self.cache.get(&canonical) {
            return Ok(Resolved::Cached(value.clone()));
        }
        if self.loading.contains(&canonical) {
            return Err(RequireCause::Cycle(spec.to_owned()));
        }

        let name = canonical.to_string_lossy().into_owned();
        let source = read_source(&canonical, spec)?;
        self.loading.push(canonical.clone());
        Ok(Resolved::Load {
            canonical,
            source,
            name,
        })
    }

    /// Resolve a specifier through a small, fixed list of Luau module paths.
    fn locate(&self, candidate: &Path, spec: &str) -> Result<PathBuf, RequireCause> {
        let mut paths = Vec::with_capacity(4);
        if matches!(
            candidate.extension().and_then(|ext| ext.to_str()),
            Some("luau" | "lua")
        ) {
            paths.push(candidate.to_path_buf());
        }
        paths.push(candidate.with_extension("luau"));
        paths.push(candidate.with_extension("lua"));
        paths.push(candidate.join("init.luau"));

        for path in paths {
            if !path.is_file() {
                continue;
            }
            let canonical =
                std::fs::canonicalize(&path).map_err(|error| RequireCause::Unreadable {
                    spec: spec.to_owned(),
                    detail: error.to_string(),
                })?;
            if !canonical.starts_with(&self.root) {
                return Err(RequireCause::Escape(spec.to_owned()));
            }
            return Ok(canonical);
        }
        Err(RequireCause::Missing(spec.to_owned()))
    }

    fn finish(&mut self, canonical: PathBuf, outcome: LuaResult<LuaValue>) -> LuaResult<LuaValue> {
        self.loading.pop();
        let value = outcome?;
        self.cache.insert(canonical, value.clone());
        Ok(value)
    }
}

/// Read a module source under a hard size cap, with one read and no growth.
fn read_source(path: &Path, spec: &str) -> Result<String, RequireCause> {
    let file = std::fs::File::open(path).map_err(|error| RequireCause::Unreadable {
        spec: spec.to_owned(),
        detail: error.to_string(),
    })?;
    let mut bytes = Vec::new();
    file.take(MAX_MODULE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| RequireCause::Unreadable {
            spec: spec.to_owned(),
            detail: error.to_string(),
        })?;
    if u64::try_from(bytes.len()).is_ok_and(|len| len > MAX_MODULE_BYTES) {
        return Err(RequireCause::TooLarge(spec.to_owned()));
    }
    String::from_utf8(bytes).map_err(|error| RequireCause::Unreadable {
        spec: spec.to_owned(),
        detail: error.to_string(),
    })
}

/// Build the scoped loader rooted at the plugin folder, returning the function
/// so the host can load the entry module through the same path and cache.
pub fn install(lua: &Lua, state: RequireState) -> LuaResult<Function> {
    let root = state.root.clone();
    let state = Arc::new(Mutex::new(state));
    scoped_require(lua, state, root)
}

/// Replace Luau's stock global require with a function that always refuses.
/// Called before `Lua::sandbox(true)` makes the globals table read-only; each
/// module's scoped require shadows this global in its own environment.
pub fn confine_global_require(lua: &Lua) -> LuaResult<()> {
    let source = format!("return function() error('{REQUIRE_CONFINED}', 0) end");
    let refuser: Function = lua.load(&source).eval()?;
    lua.globals().set("require", refuser)
}

/// Build a require whose relative specs resolve against one fixed folder.
fn scoped_require(
    lua: &Lua,
    state: Arc<Mutex<RequireState>>,
    base: PathBuf,
) -> LuaResult<Function> {
    lua.create_function(move |lua, requested: LuaValue| {
        let spec = match requested {
            LuaValue::String(value) => value.to_str()?.to_string(),
            _ => return Err(mlua::Error::runtime("tack: require expects a string path")),
        };

        let resolved = {
            let mut guard = state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.resolve(&spec, &base).map_err(mlua::Error::external)?
        };
        match resolved {
            Resolved::Cached(value) => Ok(value),
            Resolved::Load {
                canonical,
                source,
                name,
            } => {
                let module_base = canonical
                    .parent()
                    .map_or_else(|| base.clone(), Path::to_path_buf);
                let require = scoped_require(lua, Arc::clone(&state), module_base)?;
                let env = module_env(lua, require)?;
                // The mutex guard is dropped before entering Lua: a module
                // may call require again for its own siblings.
                let outcome = lua
                    .load(source)
                    .set_mode(ChunkMode::Text)
                    .set_name(name)
                    .set_environment(env)
                    .eval::<LuaValue>();
                state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .finish(canonical, outcome)
            }
        }
    })
}

/// The chunk environment: sandbox globals with a require bound to its folder.
fn module_env(lua: &Lua, require: Function) -> LuaResult<Table> {
    let env = lua.create_table()?;
    env.set("require", require)?;
    let metatable = lua.create_table()?;
    metatable.set("__index", lua.globals())?;
    env.set_metatable(Some(metatable))?;
    Ok(env)
}
