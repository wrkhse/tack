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

# The real cargo-mutants output from an empty shard writes a zero outcome.
fixture="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/fixtures/mutants-empty-shard.log"
cp -- "$fixture" "$tmp/g.log"
: > "$tmp/g.list"
run_script "$tmp/g.out" 0 "$tmp/g.log" "$tmp/g.list" \
  "$tmp/g/outcomes.json" "$tmp/g.github-output"

[ -f "$tmp/g/outcomes.json" ]
[ "$(jq -c -S . "$tmp/g/outcomes.json")" = \
  '{"caught":0,"missed":0,"timeout":0,"total_mutants":0,"unviable":0}' ]
grep -Fxq 'zero=true' "$tmp/g.github-output"
printf 'ok: empty-shard fixture writes a zero outcome\n'

# The colored WARN prefix from an empty shard still matches.
printf '\033[33m WARN\033[0m No mutants found under the active filters\n' > "$tmp/h.log"
: > "$tmp/h.list"
run_script "$tmp/h.out" 0 "$tmp/h.log" "$tmp/h.list" \
  "$tmp/h/outcomes.json" "$tmp/h.github-output"

[ -f "$tmp/h/outcomes.json" ]
[ "$(jq -c -S . "$tmp/h/outcomes.json")" = \
  '{"caught":0,"missed":0,"timeout":0,"total_mutants":0,"unviable":0}' ]
grep -Fxq 'zero=true' "$tmp/h.github-output"
printf 'ok: colored empty-shard WARN line writes a zero outcome\n'

# A no-mutants diagnostic in the list still counts as zero.
cp -- "$fixture" "$tmp/i.log"
printf '\nNo mutants found under the active filters\n' > "$tmp/i.list"
run_script "$tmp/i.out" 0 "$tmp/i.log" "$tmp/i.list" \
  "$tmp/i/outcomes.json" "$tmp/i.github-output"

[ -f "$tmp/i/outcomes.json" ]
[ "$(jq -c -S . "$tmp/i/outcomes.json")" = \
  '{"caught":0,"missed":0,"timeout":0,"total_mutants":0,"unviable":0}' ]
grep -Fxq 'zero=true' "$tmp/i.github-output"
printf 'ok: no-mutants diagnostic in the list still counts as zero\n'

# An empty-shard log with mutants in the list fails with a named reason.
cp -- "$fixture" "$tmp/j.log"
printf 'src/lib.rs:3:5: replace > with <\n' > "$tmp/j.list"
set +e
run_script "$tmp/j.out" 0 "$tmp/j.log" "$tmp/j.list" \
  "$tmp/j/outcomes.json" "$tmp/j.github-output"
j_status=$?
set -e

[ "$j_status" -ne 0 ]
[ ! -e "$tmp/j/outcomes.json" ]
grep -Fq 'cargo mutants --list found mutants but wrote no' "$tmp/j.out"
printf 'ok: empty-shard log with mutants in the list fails with a named reason\n'

# A zero-mutants diagnostic cannot mask a real mutant in the list.
cp -- "$fixture" "$tmp/k.log"
printf 'No mutants found under the active filters\nsrc/lib.rs:3:5: replace > with <\n' > "$tmp/k.list"
set +e
run_script "$tmp/k.out" 0 "$tmp/k.log" "$tmp/k.list" \
  "$tmp/k/outcomes.json" "$tmp/k.github-output"
k_status=$?
set -e

[ "$k_status" -ne 0 ]
[ ! -e "$tmp/k/outcomes.json" ]
grep -Fq 'cargo mutants --list found mutants but wrote no' "$tmp/k.out"
printf 'ok: mixed zero diagnostic and mutant line in the list fails\n'

# The zero-count line alone writes a zero outcome.
printf 'Found 0 mutants to test\n' > "$tmp/l.log"
: > "$tmp/l.list"
run_script "$tmp/l.out" 0 "$tmp/l.log" "$tmp/l.list" \
  "$tmp/l/outcomes.json" "$tmp/l.github-output"

[ -f "$tmp/l/outcomes.json" ]
[ "$(jq -c -S . "$tmp/l/outcomes.json")" = \
  '{"caught":0,"missed":0,"timeout":0,"total_mutants":0,"unviable":0}' ]
grep -Fxq 'zero=true' "$tmp/l.github-output"
printf 'ok: zero-count line alone writes a zero outcome\n'

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
