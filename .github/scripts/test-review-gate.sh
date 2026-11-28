#!/usr/bin/env bash
set -euo pipefail

# Executed proof that the review job's three step-condition paths are
# complementary. The if: expressions are READ from the discovered workflow,
# never hardcoded here: a new or edited token survives translation and fails
# the proof instead of being silently accepted.
root=$(cd "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

# ---------------------------------------------------------------------------
# 1. Discover the workflow that owns the review job.
# ---------------------------------------------------------------------------

owners=()
for candidate in "$root"/.github/workflows/*.yml; do
  [ -f "$candidate" ] || continue
  if rg -q '^  review:' "$candidate"; then
    owners+=("$candidate")
  fi
done

if [ "${#owners[@]}" -ne 1 ]; then
  printf 'FAIL: expected exactly one workflow with a review job, found %s\n' "${#owners[@]}" >&2
  exit 1
fi

workflow="${owners[0]}"
printf 'ok: review job found in %s\n' "$(basename "$workflow")"

# ---------------------------------------------------------------------------
# 2. Extract a named step's if: condition (single line or folded block), or
#    its run: block. Both scans stop at the next step, at the next job, or at
#    the next key sharing the block opener's indentation.
# ---------------------------------------------------------------------------

extract_step_field() {
  awk -v want="$1" -v field="$2" '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }

    {
      if ($0 ~ /^  review:/) in_review = 1
      if (!in_review) next

      # A new job ends the review job we are allowed to read.
      if ($0 ~ /^  [^[:space:]#]/ && $0 !~ /^  review:/) {
        done = 1
        next
      }

      # Any new step ends the block we may be collecting.
      if ($0 ~ /^[[:space:]]*-[[:space:]]+(name|uses|run|id):/) {
        if (collecting) {
          done = 1
          next
        }

        found = 0
        if ($0 ~ /-[[:space:]]*name:/) {
          label = $0
          sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "", label)
          if (label == want) found = 1
        }

        next
      }

      if (done || !found) next

      if (!collecting) {
        marker = "^[[:space:]]+" field ":[[:space:]]*"
        if ($0 ~ marker) {
          value = $0
          sub("^[[:space:]]*" field ":[[:space:]]*", "", value)
          match($0, /^[[:space:]]*/)
          block_indent = RLENGTH

          if (value ~ /^[>|][-+]?[[:space:]]*$/) {
            collecting = 1
            text = ""
          } else {
            text = trim(value)
            done = 1
          }
        }

        next
      }

      match($0, /^[[:space:]]*/)
      if (RLENGTH <= block_indent && trim($0) != "") {
        done = 1
        next
      }

      part = trim($0)
      if (part == "" || part ~ /^#/) next
      text = text (text == "" ? "" : " ") part
    }

    END { if (found && text != "") print text }
  ' "$workflow"
}

require_condition() {
  local step="$1" cond="$2"

  if ! rg -q -F -- "- name: $step" "$workflow"; then
    printf 'FAIL: step "%s" is missing from the review workflow\n' "$step" >&2
    exit 1
  fi

  if [ -z "$cond" ]; then
    printf 'FAIL: step "%s" has no if: condition\n' "$step" >&2
    exit 1
  fi
}

post_cond=$(extract_step_field 'Post review' if)
enforce_cond=$(extract_step_field 'Enforce posted review verdict' if)
failclosed_cond=$(extract_step_field 'Require a fresh posted review' if)

require_condition 'Post review' "$post_cond"
require_condition 'Enforce posted review verdict' "$enforce_cond"
require_condition 'Require a fresh posted review' "$failclosed_cond"

printf 'ok: extracted if: condition from "Post review"\n'
printf 'ok: extracted if: condition from "Enforce posted review verdict"\n'
printf 'ok: extracted if: condition from "Require a fresh posted review"\n'

# ---------------------------------------------------------------------------
# 3. Translate one extracted GitHub expression into a shell boolean for the
#    current synthetic outcome set, then refuse anything left unmodelled.
# ---------------------------------------------------------------------------

translate() {
  local expr="$1"
  local tok val leftover

  expr=${expr#'${{'}
  expr=${expr%'}}'}
  expr=$(printf '%s' "$expr" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

  while IFS='|' read -r tok val; do
    expr=${expr//"$tok"/"$val"}
  done <<EOF
always()|$always
steps.carry_forward.outputs.carried == 'true'|$carried_eq_true
steps.carry_forward.outputs.carried != 'true'|$carried_ne_true
steps.post_review.outcome == 'success'|$post_eq_success
steps.post_review.outcome != 'success'|$post_ne_success
steps.core_checks.outcome == 'success'|$core_checks_eq_success
steps.review_primary.outcome == 'success'|$primary_eq_success
steps.review_primary.outputs.failed == 'false'|$primary_failed_eq_false
steps.review_fallback.outcome == 'success'|$fallback_eq_success
steps.review_fallback.outputs.failed == 'false'|$fallback_failed_eq_false
EOF

  leftover=$expr
  leftover=${leftover//true/}
  leftover=${leftover//false/}
  leftover=${leftover//&&/}
  leftover=${leftover//||/}
  leftover=${leftover//\(/}
  leftover=${leftover//\)/}
  leftover=$(printf '%s' "$leftover" | tr -d '[:space:]')

  if [ -n "$leftover" ]; then
    printf 'FAIL: unmodelled tokens in condition: %s\n' "$leftover" >&2
    exit 1
  fi

  # Spacing the parentheses keeps "((" from opening bash arithmetic mode.
  expr=${expr//\(/( }
  expr=${expr//\)/ )}

  if eval "$expr"; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

# ---------------------------------------------------------------------------
# 4. Synthetic step-outcome sets. always() is true throughout; at most one
#    review attempt yields a usable review in any one set.
# ---------------------------------------------------------------------------

set_scenario() {
  # $1 = carried (true|false), $2 = post outcome (success|failure|skipped),
  # $3 = primary produced a usable review (true|false)
  local carried="$1" post="$2" primary_ok="$3"

  always=true

  if [ "$carried" = true ]; then
    carried_eq_true=true
    carried_ne_true=false
  else
    carried_eq_true=false
    carried_ne_true=true
  fi

  if [ "$post" = success ]; then
    post_eq_success=true
    post_ne_success=false
  else
    post_eq_success=false
    post_ne_success=true
  fi

  if [ "$primary_ok" = true ]; then
    primary_eq_success=true
    primary_failed_eq_false=true
  else
    primary_eq_success=false
    primary_failed_eq_false=false
  fi

  fallback_eq_success=false
  fallback_failed_eq_false=false
  core_checks_eq_success=true
}

expect() {
  local label="$1" actual="$2" expected="$3"

  if [ "$actual" != "$expected" ]; then
    printf 'FAIL: %s expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi

  printf 'ok: %s=%s\n' "$label" "$actual"
}

check_paths() {
  local name="$1" want_post="$2" want_enforce="$3" want_failclosed="$4"
  local actual

  actual=$(translate "$post_cond")
  expect "$name - Post review" "$actual" "$want_post"

  actual=$(translate "$enforce_cond")
  expect "$name - Enforce posted review verdict" "$actual" "$want_enforce"

  actual=$(translate "$failclosed_cond")
  expect "$name - Require a fresh posted review" "$actual" "$want_failclosed"
}

set_scenario true skipped false
check_paths 'carried=true, post=skipped' false true false

set_scenario false success true
check_paths 'carried=false, post=success' true true false

set_scenario false failure false
check_paths 'carried=false, post=failure' false false true

set_scenario false skipped false
check_paths 'carried=false, post=skipped' false false true

# ---------------------------------------------------------------------------
# 5. Pin the fail-closed behavior itself, not just its step condition.
# ---------------------------------------------------------------------------

failclosed_run=$(extract_step_field 'Require a fresh posted review' run)
if [ -z "$failclosed_run" ]; then
  echo 'FAIL: could not read run block of step "Require a fresh posted review"' >&2
  exit 1
fi

printf '%s\n' "$failclosed_run" > "$tmp/failclosed-run.txt"

if ! rg -q -F 'No fresh review was posted at this head; the merge gate cannot pass.' "$tmp/failclosed-run.txt"; then
  echo 'FAIL: fail-closed step does not emit the named error' >&2
  exit 1
fi

if ! rg -q -F 'exit 1' "$tmp/failclosed-run.txt"; then
  echo 'FAIL: fail-closed step does not exit 1' >&2
  exit 1
fi

printf 'ok: fail-closed step emits named error and exits 1\n'
