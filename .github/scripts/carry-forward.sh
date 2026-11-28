#!/usr/bin/env bash
set -euo pipefail

# Carry a verdict forward only for a title-only edit whose newest marker
# comment came from github-actions[bot] on this exact head and base with
# MERGE AS IS. A miss reviews fresh; it never fails the job.
: "${REPO:?REPO is required}" \
  "${PR:?PR is required}" \
  "${HEAD_SHA:?HEAD_SHA is required}" \
  "${BASE_SHA:?BASE_SHA is required}"

marker='<!-- opencode-review -->'
author_id=41898282
carried=false

comments=$(gh api --paginate "repos/$REPO/issues/$PR/comments" 2>/dev/null || printf '[]\n')

body=$(printf '%s' "$comments" | jq -rs --arg marker "$marker" --argjson author "$author_id" '
  [ .[] | select(.id | numbers)
    | select(.user.id == $author)
    | select(.body // "" | startswith($marker)) ]
  | if length == 0 then "" else (sort_by(.id) | last | .body) end
' 2>/dev/null || printf '')

if [ -n "$body" ]; then
  meta=$(printf '%s\n' "$body" | sed -n 's/^<!-- opencode-review-meta \({.*}\) -->$/\1/p' | tail -n 1)
  if [ -n "$meta" ] && printf '%s' "$meta" | jq -e \
      --arg head "$HEAD_SHA" --arg base "$BASE_SHA" '
        .head == $head and .base == $base and .verdict == "MERGE AS IS"
      ' > /dev/null 2>&1; then
    carried=true
  fi
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'carried=%s\n' "$carried" >> "$GITHUB_OUTPUT"
fi
printf 'Carry-forward: carried=%s\n' "$carried"
