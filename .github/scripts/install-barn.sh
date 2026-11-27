#!/usr/bin/env bash
set -euo pipefail

# crates/daemon/Cargo.toml is the single source of truth for the barn pin.
# Read it here rather than keep a second copy of the rev in CI.

: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

manifest="$GITHUB_WORKSPACE/crates/daemon/Cargo.toml"
rev=$(sed -n 's/^barn-stall = .*rev = "\([0-9a-f]\{40\}\)".*/\1/p' "$manifest")
if [[ ! "$rev" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::cannot read the 40-character barn-stall rev from $manifest" >&2
  exit 1
fi
echo "barn rev: $rev"

profile=debug
build_args=()
case "${1:-}" in
  "" | debug) ;;
  release)
    profile=release
    build_args+=(--release)
    ;;
  *)
    echo "::error::usage: install-barn.sh [debug|release]" >&2
    exit 1
    ;;
esac

src="$RUNNER_TEMP/barn-src"
if [ -d "$src/.git" ]; then
  git -C "$src" fetch --force origin
else
  rm -rf -- "$src"
  git clone https://github.com/wrkhse/barn.git "$src"
fi
git -C "$src" checkout --force "$rev"

# Same target dir as tack, so barn and the daemon share the Cargo.lock-keyed
# rust-cache entry; a pin bump changes that key and rebuilds both.
CARGO_TARGET_DIR="$GITHUB_WORKSPACE/target" \
  cargo build --manifest-path "$src/Cargo.toml" --workspace --bins --locked \
    "${build_args[@]}"

bin_dir="$GITHUB_WORKSPACE/target/$profile"
missing=0
for name in barn barn-exec barn-luau-stall; do
  path="$bin_dir/$name"
  if [ ! -f "$path" ]; then
    missing=1
    if [ "$name" = "barn-luau-stall" ]; then
      echo "::error::barn-luau-stall-missing: barn rev $rev does not build barn-luau-stall; the pinned rev predates the serve-loop binaries" >&2
    else
      echo "::error::barn-binary-missing: barn rev $rev did not build $name at $path" >&2
    fi
  else
    echo "$path"
  fi
done

if [ "$missing" -ne 0 ]; then
  exit 1
fi
