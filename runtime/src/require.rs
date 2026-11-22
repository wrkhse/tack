//! A scoped replacement for Luau's require, confined to one plugin folder.
//!
//! The stock loader reaches arbitrary files and participates in its own cache.
//! This one resolves every specifier against the canonical plugin folder,
//! refuses escapes and cycles, and evaluates each module into the same VM.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use mlua::{Function, Lua, Result as LuaResult, Value as LuaValue};

pub(crate) struct RequireState {
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
    pub(crate) fn new(folder: &Path) -> Result<Self, String> {
        let root = std::fs::canonicalize(folder)
            .map_err(|error| format!("tack: plugin folder unavailable: {error}"))?;
        Ok(Self {
            root,
            cache: HashMap::new(),
            loading: Vec::new(),
        })
    }

    fn resolve(&mut self, spec: &str) -> Result<Resolved, String> {
        let relative = Path::new(spec);
        if relative.is_absolute() {
            return Err(format!("tack: require rejects absolute path: {spec}"));
        }
        if relative
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        {
            return Err(format!("tack: require rejects parent path: {spec}"));
        }

        let candidate = self.root.join(relative);
        let canonical = self.locate(&candidate, spec)?;
        if let Some(value) = self.cache.get(&canonical) {
            return Ok(Resolved::Cached(value.clone()));
        }
        if self.loading.contains(&canonical) {
            return Err(format!("tack: require cycle detected: {spec}"));
        }

        let name = canonical.to_string_lossy().into_owned();
        let source = std::fs::read_to_string(&canonical)
            .map_err(|error| format!("tack: require cannot read {spec}: {error}"))?;
        self.loading.push(canonical.clone());
        Ok(Resolved::Load {
            canonical,
            source,
            name,
        })
    }

    /// Resolve a specifier through a small, fixed list of Luau module paths.
    fn locate(&self, candidate: &Path, spec: &str) -> Result<PathBuf, String> {
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
            let canonical = std::fs::canonicalize(&path)
                .map_err(|error| format!("tack: require cannot read {spec}: {error}"))?;
            if !canonical.starts_with(&self.root) {
                return Err(format!("tack: require escapes plugin folder: {spec}"));
            }
            return Ok(canonical);
        }
        Err(format!("tack: require module not found: {spec}"))
    }

    fn finish(&mut self, canonical: PathBuf, outcome: LuaResult<LuaValue>) -> LuaResult<LuaValue> {
        self.loading.pop();
        let value = outcome?;
        self.cache.insert(canonical, value.clone());
        Ok(value)
    }
}

/// Install the scoped loader as the global require, returning the function so
/// the host can load the entry module through the same path and cache.
pub(crate) fn install(lua: &Lua, state: RequireState) -> LuaResult<Function> {
    let state = Arc::new(Mutex::new(state));
    lua.create_function(move |lua, requested: LuaValue| {
        let spec = match requested {
            LuaValue::String(value) => value.to_str()?.to_string(),
            _ => return Err(mlua::Error::runtime("tack: require expects a string path")),
        };

        let resolved = {
            let mut state = state.lock().expect("require state poisoned");
            state.resolve(&spec).map_err(mlua::Error::runtime)?
        };
        match resolved {
            Resolved::Cached(value) => Ok(value),
            Resolved::Load {
                canonical,
                source,
                name,
            } => {
                // The mutex guard is dropped before entering Lua: a module
                // may call require again for its own siblings.
                let outcome = lua.load(source).set_name(name).eval::<LuaValue>();
                state
                    .lock()
                    .expect("require state poisoned")
                    .finish(canonical, outcome)
            }
        }
    })
}
