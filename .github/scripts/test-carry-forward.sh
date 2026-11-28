#!/usr/bin/env bash
set -euo pipefail

# Offline integration test for .github/scripts/carry-forward.sh. A stub gh
# serves canned marker comments, so no network is touched. Each case drives
# the real script and checks the carried= value it writes to GITHUB_OUTPUT.

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
script="$root/.github/scripts/carry-forward.sh"
workflow="$root/.github/workflows/opencode-review.yml"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

head=aaa111
other_head=ccc333
base=bbb222
other_base=ddd444
marker='<!-- opencode-review -->'

comments="$work/comments.json"
output="$work/output"

# The stub emits one comment object per JSON value, which is what the
# script's jq -rs slurp consumes. No network or real gh call is made.
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
cat "$COMMENTS"
STUB
chmod +x "$work/bin/gh"

comment() {
  # id, author id, head, base, verdict
  jq -nc --argjson id "$1" --argjson author "$2" \
    --arg head "$3" --arg base "$4" --arg verdict "$5" --arg marker "$marker" '
    { id: $id,
      user: { id: $author },
      body: ($marker + "\n**Verdict: " + $verdict + "**\n" +
             "<!-- opencode-review-meta " +
             ({ head: $head, base: $base, verdict: $verdict } | tojson) +
             " -->") }
  '
}

page() { jq -c . > "$comments"; }

run_case() {
  local name="$1" expected="$2" got
  : > "$output"
  COMMENTS="$comments" GITHUB_OUTPUT="$output" PATH="$work/bin:$PATH" \
    REPO=owner/repo PR=42 HEAD_SHA="$head" BASE_SHA="$base" \
    bash "$script" > "$work/log" 2>&1
  got=$(sed -n 's/^carried=//p' "$output")
  if [ "$got" != "$expected" ]; then
    printf 'FAIL %s: expected carried=%s, got %s\n' \
      "$name" "$expected" "${got:-<missing>}" >&2
    cat "$work/log" >&2
    exit 1
  fi
  printf 'ok: %s -> carried=%s\n' "$name" "$expected"
}

# 1. Newest matching marker from the bot on this head/base with MERGE AS IS.
# The older matching marker has the wrong head, so newest must be selected.
{
  comment 1 41898282 "$other_head" "$base" "MERGE AS IS"
  comment 2 41898282 "$head" "$base" "MERGE AS IS"
} | page
run_case "newest matching marker" true

# 2. Newest matching marker is on a different head (shared-head leak).
{
  comment 1 41898282 "$head" "$base" "MERGE AS IS"
  comment 2 41898282 "$other_head" "$base" "MERGE AS IS"
} | page
run_case "different head" false

# 3. FIX FIRST verdict is never carried.
comment 1 41898282 "$head" "$base" "FIX FIRST" | page
run_case "FIX FIRST verdict" false

# 4. Base mismatch is never carried.
comment 1 41898282 "$head" "$other_base" "MERGE AS IS" | page
run_case "base mismatch" false

# 5. A marker comment from a different author is never carried.
comment 1 12345 "$head" "$base" "MERGE AS IS" | page
run_case "non-bot author" false

# A body-only edit must not be carried: guard that path statically.
if ! grep -Fq '!github.event.changes.body' "$workflow"; then
  printf 'FAIL: workflow does not guard body edits out of carry-forward\n' >&2
  exit 1
fi
printf 'ok: workflow excludes body edits from carry-forward\n'
