import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Config, Effect, Schema, type Scope } from "effect";

import { findExecutable, installRecorder } from "./recorder.ts";

/** The repository the suite runs from: it holds the CLIs and their pinned versions. */
export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** One agent CLI, its binary, and the only environment it may see. */
export interface AgentEnvironment {
  readonly bin: string;
  readonly env: Readonly<Record<string, string>>;
}

/** A throwaway directory tree that holds one scenario. */
export interface Sandbox {
  readonly dir: string;
  readonly projectDir: string;
  readonly recorderFile: string;
  readonly opencode: AgentEnvironment;
  readonly pi: AgentEnvironment;
}

const ManifestSchema = Schema.Struct({
  devDependencies: Schema.Record(Schema.String, Schema.String),
});

const DIRECTORIES = [
  "bin",
  "home",
  "tmp",
  "xdg/config",
  "xdg/data",
  "xdg/state",
  "xdg/cache",
  "plugins",
  "project",
  "pi-agent",
];

/**
 * Everything an agent may see: one home, one temp directory, one XDG tree, and
 * a PATH that starts with the recorder. Nothing else of the parent survives.
 */
const isolationEnv = (dir: string, parentPath: string, realGit: string | null) => ({
  PATH: join(dir, "bin") + ":" + parentPath,
  HOME: join(dir, "home"),
  TMPDIR: join(dir, "tmp"),
  XDG_CONFIG_HOME: join(dir, "xdg", "config"),
  XDG_DATA_HOME: join(dir, "xdg", "data"),
  XDG_STATE_HOME: join(dir, "xdg", "state"),
  XDG_CACHE_HOME: join(dir, "xdg", "cache"),
  TACK_RECORDER: join(dir, "recorder.log"),
  TACK_REAL_GIT: realGit ?? "",
});

const openCodeEnv = (dir: string, parentPath: string, realGit: string | null) => ({
  ...isolationEnv(dir, parentPath, realGit),
  OPENCODE_DB: join(dir, "opencode.sqlite"),
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_FILEWATCHER: "1",
});

const piEnv = (dir: string, parentPath: string, realGit: string | null) => ({
  ...isolationEnv(dir, parentPath, realGit),
  PI_CODING_AGENT_DIR: join(dir, "pi-agent"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
});

/** Creates a directory and its parents. */
export const ensureDirectory = (path: string): Effect.Effect<void> =>
  Effect.sync(() => {
    mkdirSync(path, { recursive: true });
  });

/** Writes a file inside the sandbox, creating its parent directory. */
export const writeText = (path: string, text: string): Effect.Effect<void> =>
  Effect.sync(() => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  });

/** Reads a file if the run left one, otherwise null. */
export const readOptionalText = (path: string): Effect.Effect<string | null> =>
  Effect.sync(() => (existsSync(path) ? readFileSync(path, "utf8") : null));

/**
 * Reads the version a dependency is pinned to. The sandbox resolves the agent
 * binaries from the same manifest, so a drifting pin fails the suite.
 */
export const pinnedVersion = (name: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const text = yield* Effect.sync(() => readFileSync(join(repoRoot, "package.json"), "utf8"));

    const manifest = yield* Schema.decodeUnknownEffect(ManifestSchema)(JSON.parse(text)).pipe(
      Effect.orDie,
    );

    const version = manifest.devDependencies[name];

    if (version === undefined) {
      return yield* Effect.die(new Error("tack-conformance: " + name + " is not a devDependency"));
    }

    return version;
  });

const binPath = (name: string): string => join(repoRoot, "node_modules", ".bin", name);

/**
 * Creates a fresh sandbox and deletes it when the scope closes. The parent PATH
 * comes from Effect Config so the suite never reads the process environment.
 */
export const sandbox: Effect.Effect<Sandbox, never, Scope.Scope> = Effect.gen(function* () {
  const parentPath = yield* Config.String("PATH").pipe(Effect.orDie);

  const dir = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "tack-conformance-"))),
    (created) =>
      Effect.sync(() => {
        rmSync(created, { recursive: true, force: true });
      }),
  );

  yield* Effect.sync(() => {
    for (const directory of DIRECTORIES) mkdirSync(join(dir, directory), { recursive: true });
  });

  const realGit = yield* Effect.sync(() => findExecutable("git", parentPath));

  yield* installRecorder(join(dir, "bin"));

  return {
    dir,
    projectDir: join(dir, "project"),
    recorderFile: join(dir, "recorder.log"),
    opencode: { bin: binPath("opencode"), env: openCodeEnv(dir, parentPath, realGit) },
    pi: { bin: binPath("pi"), env: piEnv(dir, parentPath, realGit) },
  };
});
