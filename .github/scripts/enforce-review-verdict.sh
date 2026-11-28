#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}" \
  "${REPO:?REPO is required}" "${PR:?PR is required}"

# The pinned jq program decides the verdict; this step only feeds it the bot's
# comments from the API. Nothing here softens its checks.
gh api --paginate \
  --jq '.[] | {id, user: {id: .user.id}, body}' \
  "repos/$REPO/issues/$PR/comments" |
  jq -rs --arg marker '<!-- opencode-review -->' --argjson author 41898282 \
    "$(cat .github/scripts/enforce-review-verdict.jq)"
