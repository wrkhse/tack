#!/usr/bin/env bash
set -euo pipefail

script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/mutants-outcome.sh"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

run_script() {
  MUTANTS_STATUS="$2" MUTANTS_LOG="$3" MUTANTS_LIST="$4" \
    OUTCOMES="$5" GITHUB_OUTPUT="$6" \
    "$script" > "$1" 2>&1
}

# Exit 0, the exact line, and an empty list write a valid zero outcome.
printf 'building mutants\nNo mutants to filter\ndone\n' > "$tmp/a.log"
: > "$tmp/a.list"
run_script "$tmp/a.out" 0 "$tmp/a.log" "$tmp/a.list" \
  "$tmp/a/outcomes.json" "$tmp/a.github-output"

[ -f "$tmp/a/outcomes.json" ]
[ "$(jq -c -S . "$tmp/a/outcomes.json")" = \
  '{"caught":0,"missed":0,"timeout":0,"total_mutants":0,"unviable":0}' ]
grep -Fxq 'zero=true' "$tmp/a.github-output"
printf 'ok: exact line and empty list write a zero outcome\n'

# The colored INFO prefix that cargo-mutants logs still matches.
printf '\033[32m INFO\033[0m No mutants to filter\n' > "$tmp/e.log"
: > "$tmp/e.list"
run_script "$tmp/e.out" 0 "$tmp/e.log" "$tmp/e.list" \
  "$tmp/e/outcomes.json" "$tmp/e.github-output"

[ -f "$tmp/e/outcomes.json" ]
[ "$(jq -c -S . "$tmp/e/outcomes.json")" = \
  '{"caught":0,"missed":0,"timeout":0,"total_mutants":0,"unviable":0}' ]
grep -Fxq 'zero=true' "$tmp/e.github-output"
printf 'ok: colored INFO line and empty list write a zero outcome\n'

# A nonempty list with no outcomes fails with a named reason.
printf 'No mutants to filter\n' > "$tmp/b.log"
printf 'src/lib.rs:3:5: replace > with <\n' > "$tmp/b.list"

set +e
run_script "$tmp/b.out" 0 "$tmp/b.log" "$tmp/b.list" \
  "$tmp/b/outcomes.json" "$tmp/b.github-output"
b_status=$?
set -e

[ "$b_status" -ne 0 ]
[ ! -e "$tmp/b/outcomes.json" ]
grep -Fq 'cargo mutants --list found mutants but wrote no' "$tmp/b.out"
printf 'ok: nonempty list fails with a named reason\n'

# A nonzero exit with no outcomes fails with a named reason.
printf 'No mutants to filter\n' > "$tmp/c.log"
: > "$tmp/c.list"
set +e
run_script "$tmp/c.out" 7 "$tmp/c.log" "$tmp/c.list" \
  "$tmp/c/outcomes.json" "$tmp/c.github-output"
c_status=$?
set -e

[ "$c_status" -ne 0 ]
[ ! -e "$tmp/c/outcomes.json" ]
grep -Fq 'cargo mutants exited 7; its outcome cannot be used' "$tmp/c.out"
printf 'ok: nonzero exit fails with a named reason\n'

# A missing exact line with no outcomes fails with a named reason.
printf 'No mutants selected\n' > "$tmp/d.log"
: > "$tmp/d.list"
set +e
run_script "$tmp/d.out" 0 "$tmp/d.log" "$tmp/d.list" \
  "$tmp/d/outcomes.json" "$tmp/d.github-output"
d_status=$?
set -e

[ "$d_status" -ne 0 ]
[ ! -e "$tmp/d/outcomes.json" ]
grep -Fq "did not report 'No mutants to filter'" "$tmp/d.out"
printf 'ok: missing exact line fails with a named reason\n'

# A nonzero exit fails even when an outcomes file is already present.
printf 'No mutants to filter\n' > "$tmp/f.log"
: > "$tmp/f.list"
mkdir -p -- "$tmp/f"
printf '%s\n' '{"total_mutants":1,"caught":1,"missed":0,"timeout":0,"unviable":0}' \
  > "$tmp/f/outcomes.json"

set +e
run_script "$tmp/f.out" 9 "$tmp/f.log" "$tmp/f.list" \
  "$tmp/f/outcomes.json" "$tmp/f.github-output"
f_status=$?
set -e

[ "$f_status" -ne 0 ]
[ -f "$tmp/f/outcomes.json" ]
grep -Fq 'cargo mutants exited 9' "$tmp/f.out"
grep -Fq 'its outcome cannot be used' "$tmp/f.out"
printf 'ok: nonzero exit with an existing outcome fails with a named reason\n'

# An empty shard reports "Found 0 mutants to test" plus a WARN line and exits 0.
printf 'Found 0 mutants to test\n\033[33m WARN\033[0m No mutants found under the active filters\n' > "$tmp/g.log"
: > "$tmp/g.list"
run_script "$tmp/g.out" 0 "$tmp/g.log" "$tmp/g.list" \
  "$tmp/g/outcomes.json" "$tmp/g.github-output"

[ -f "$tmp/g/outcomes.json" ]
[ "$(jq -c -S . "$tmp/g/outcomes.json")" = \
  '{"caught":0,"missed":0,"timeout":0,"total_mutants":0,"unviable":0}' ]
grep -Fxq 'zero=true' "$tmp/g.github-output"
printf 'ok: empty-shard zero line and empty list write a zero outcome\n'

# Two-sided proof for an empty shard that coexists with mutants elsewhere.
# The gate reads MUTANTS_LIST, which the workflow supplies with the same
# --shard k/n as the run. The shard-scoped empty list is accepted as a zero
# outcome, while the same shard's empty-shard log paired with a nonempty
# whole-diff list is rejected, so the gate is driven by the shard-scoped list.
printf 'Found 0 mutants to test\n\033[33m WARN\033[0m No mutants found under the active filters\n' > "$tmp/h.log"
: > "$tmp/h.list"
printf 'src/lib.rs:3:5: replace > with <\n' > "$tmp/h.whole-diff.list"
[ -s "$tmp/h.whole-diff.list" ]
run_script "$tmp/h.out" 0 "$tmp/h.log" "$tmp/h.list" \
  "$tmp/h/outcomes.json" "$tmp/h.github-output"

[ -f "$tmp/h/outcomes.json" ]
[ "$(jq -c -S . "$tmp/h/outcomes.json")" = \
  '{"caught":0,"missed":0,"timeout":0,"total_mutants":0,"unviable":0}' ]
grep -Fxq 'zero=true' "$tmp/h.github-output"
printf 'ok: empty shard with mutants elsewhere writes a zero outcome from its shard-scoped list\n'

# The same empty-shard log paired with the nonempty whole-diff list is rejected.
set +e
run_script "$tmp/h2.out" 0 "$tmp/h.log" "$tmp/h.whole-diff.list" \
  "$tmp/h2/outcomes.json" "$tmp/h2.github-output"
h_status=$?
set -e

[ "$h_status" -ne 0 ]
[ ! -e "$tmp/h2/outcomes.json" ]
grep -Fq 'cargo mutants --list found mutants but wrote no' "$tmp/h2.out"
printf 'ok: whole-diff list is not accepted as an empty shard\n'
