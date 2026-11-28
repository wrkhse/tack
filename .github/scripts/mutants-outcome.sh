#!/usr/bin/env bash
set -euo pipefail

# A missing outcomes.json is a valid zero only when cargo mutants succeeded,
# reported the exact no-mutants line, and an independent --list found none.
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
trap 'rm -f -- "$normalized"' EXIT
sed -E $'s/\x1b\\[[0-9;]*[[:alpha:]]//g' "$MUTANTS_LOG" |
  sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^(INFO|WARN|ERROR|DEBUG|TRACE)[[:space:]]+//; s/^[[:space:]]+//; s/[[:space:]]+$//' \
  > "$normalized"

# cargo-mutants prints its own zero-mutants summary ("Found 0 mutants to test",
# with a WARN that nothing matched the active filters) when a shard has no
# mutants assigned. Keep the long-standing filter line as the other zero. Each
# is matched as a whole line after normalisation, never as a substring.
reports_no_mutants() {
  grep -Fxq 'No mutants to filter' "$1" \
    || grep -Fxq 'Found 0 mutants to test' "$1" \
    || grep -Fxq 'No mutants found under the active filters' "$1"
}

# cargo-mutants --list prints one line per mutant. Blank lines and its own
# no-mutants diagnostic carry no mutant.
list_has_mutants() {
  awk '
    /^[[:space:]]*$/ { next }
    $0 == "No mutants to filter" { next }
    $0 == "Found 0 mutants to test" { next }
    $0 == "No mutants found under the active filters" { next }
    { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$MUTANTS_LIST"
}

if [ "$MUTANTS_STATUS" -eq 0 ] \
    && reports_no_mutants "$normalized" \
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
  if ! reports_no_mutants "$normalized"; then
    echo "::error::cargo mutants did not report 'No mutants to filter' and wrote no $OUTCOMES" >&2
  else
    echo "::error::cargo mutants --list found mutants but wrote no $OUTCOMES" >&2
  fi
  exit 1
fi

echo "cargo mutants wrote $OUTCOMES; keeping its outcome."
