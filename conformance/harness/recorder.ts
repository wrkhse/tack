import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";

/** The name of the git shim inside the sandbox bin directory. */
const SHIM = "git";

/**
 * The shim records every push and every tool handler's own `tack-tool` call,
 * and delegates every other git command to the real git, so a scenario proves
 * what the agent would have run.
 */
const shimScript = (): string =>
  [
    "#!/bin/sh",
    "# tack-conformance: a git that records pushes and tool calls and delegates the rest.",
    'if [ "$1" = "push" ] || [ "$1" = "tack-tool" ]; then',
    '  echo "$*" >> "$TACK_RECORDER"',
    '  echo "recorded"',
    "  exit 0",
    "fi",
    'if [ -z "$TACK_REAL_GIT" ]; then',
    '  echo "tack-conformance: real git not found" >&2',
    "  exit 127",
    "fi",
    'exec "$TACK_REAL_GIT" "$@"',
    "",
  ].join("\n");

/** Returns whether a path is an executable file for this process. */
const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
};

/** Finds an executable on a PATH value, or null when it is not installed. */
export const findExecutable = (name: string, pathValue: string): string | null => {
  for (const directory of pathValue.split(":")) {
    if (directory.length === 0) continue;

    const candidate = join(directory, name);

    if (isExecutable(candidate)) return candidate;
  }

  return null;
};

/** Writes the git shim into the bin directory that comes first on PATH. */
export const installRecorder = (binDirectory: string): Effect.Effect<void> =>
  Effect.sync(() => {
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(join(binDirectory, SHIM), shimScript(), { mode: 0o755 });
  });

/** Reads the recorded git arguments, one per push, or none when the file is absent. */
export const recorded = (file: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.sync(() => {
    if (!existsSync(file)) return [];

    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  });
