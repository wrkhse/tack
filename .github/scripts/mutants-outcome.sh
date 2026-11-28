#!/usr/bin/env bash
set -euo pipefail

# A missing outcomes.json is a valid zero only when cargo mutants succeeded,
# reported an exact zero-mutants line, and an independent --list found none.
: "${MUTANTS_STATUS:?MUTANTS_STATUS is required}"
: "${MUTANTS_LOG:?MUTANTS_LOG is required}"
: "${MUTANTS_LIST:?MUTANTS_LIST is required}"
: "${OUTCOMES:?OUTCOMES is required}"

if [[ ! "$MUTANTS_STATUS" =~ ^[0-9]+$ ]]; then
  echo "::error::MUTANTS_STATUS must be an integer, got: $MUTANTS_STATUS" >&2
  exit 1
fi

# A failed run is never usable, even if it left an outcomes file behind.
if [ "$MUTANTS_STATUS" -ne 0 ]; then
  echo "::error::cargo mutants exited $MUTANTS_STATUS; its outcome cannot be used" >&2
  exit 1
fi

for input in "$MUTANTS_LOG" "$MUTANTS_LIST"; do
  if [ ! -f "$input" ]; then
    echo "::error::mutants outcome input is missing: $input" >&2
    exit 1
  fi
done

# cargo-mutants logs through a colored tracing formatter. Strip ANSI codes,
# trim each line, then drop a leading log level so the message can be
# matched exactly as a whole line.
normalized=$(mktemp)
# Exact whole-line zero-mutants diagnostics: the filter case and cargo-mutants'
# own empty-shard case (its WARN prefix is stripped during normalization).
ZERO_MUTANTS_LINES=(
  'No mutants to filter'
  'Found 0 mutants to test'
  'No mutants found under the active filters'
)
zero_lines=$(mktemp)
trap 'rm -f -- "$normalized" "$zero_lines"' EXIT
printf '%s\n' "${ZERO_MUTANTS_LINES[@]}" > "$zero_lines"
sed -E $'s/\x1b\\[[0-9;]*[[:alpha:]]//g' "$MUTANTS_LOG" |
  sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^(INFO|WARN|ERROR|DEBUG|TRACE)[[:space:]]+//; s/^[[:space:]]+//; s/[[:space:]]+$//' \
  > "$normalized"

# Success iff the normalized log contains any exact zero-mutants diagnostic.
log_reports_zero_mutants() {
  grep -Fxf "$zero_lines" "$normalized" > /dev/null
}

# cargo-mutants --list prints one line per mutant. Blank lines and any exact
# zero-mutants diagnostic carry no mutant.
list_has_mutants() {
  awk '
    NR == FNR { zero[$0] = 1; next }
    /^[[:space:]]*$/ { next }
    $0 in zero { next }
    { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$zero_lines" "$MUTANTS_LIST"
}

if [ "$MUTANTS_STATUS" -eq 0 ] \
    && log_reports_zero_mutants \
    && ! list_has_mutants; then
  mkdir -p -- "$(dirname -- "$OUTCOMES")"
  jq -n '{total_mutants: 0, caught: 0, missed: 0, timeout: 0, unviable: 0}' > "$OUTCOMES"
  echo "No mutants in this shard; wrote a zero $OUTCOMES."
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'zero=true\n' >> "$GITHUB_OUTPUT"
  fi
  exit 0
fi

if [ ! -f "$OUTCOMES" ]; then
  if ! log_reports_zero_mutants; then
    echo "::error::cargo mutants did not report 'No mutants to filter' or an empty-shard zero-mutants line ('Found 0 mutants to test' / 'No mutants found under the active filters') and wrote no $OUTCOMES" >&2
  else
    echo "::error::cargo mutants --list found mutants but wrote no $OUTCOMES" >&2
  fi
  exit 1
fi

echo "cargo mutants wrote $OUTCOMES; keeping its outcome."
