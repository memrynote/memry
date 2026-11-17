#!/usr/bin/env bash
# The post-merge lookups (#5035) for a push to feat/tauri-v2 in a workflow that opts in (POST_MERGE=true).
# A merge-queue merge fast-forwards feat/tauri-v2 to the commit the queue tested, so the push re-tests a
# SHA this workflow already passed. Prints `queue_tested=true` when a merge_group run of the calling
# workflow on SHA has a successful `<WORKFLOW_NAME> gate` job (the run itself finishes later, after
# its flaky-test report), and `from=<sha>`, the SHA of the newest earlier push run that was not
# cancelled: a superseded run may not have saved its caches, so the push's range starts there for the
# cache-key check in tier.sh. A failed lookup, or no such run, prints `queue_tested=false`, and every
# leg runs. Env: EVENT, REF, REPO, POST_MERGE, WORKFLOW_REF, WORKFLOW_NAME, SHA, RUN_ID.
# scripts/ci-tier.test.mjs runs this file with a stub `gh`.
set -euo pipefail

queue_tested=false
from=""
if [ "${POST_MERGE:-false}" = true ] && [ "$EVENT" = push ] && [ "$REF" = "refs/heads/feat/tauri-v2" ]; then
  workflow_path=${WORKFLOW_REF#"$REPO/"}
  workflow_path=${workflow_path%%@*}
  gate="$WORKFLOW_NAME gate"
  passed=0
  saved=""
  if ids=$(gh api "repos/$REPO/actions/runs?head_sha=$SHA&event=merge_group&per_page=100" \
    --jq ".workflow_runs[] | select(.path == \"$workflow_path\") | .id"); then
    for id in $ids; do
      if n=$(gh api "repos/$REPO/actions/runs/$id/jobs?filter=latest&per_page=100" \
        --jq "[.jobs[] | select(.name == \"$gate\" and .conclusion == \"success\")] | length"); then
        passed=$((passed + n))
      fi
    done
  fi
  if [ "$passed" -gt 0 ] && saved=$(gh api "repos/$REPO/actions/workflows/${workflow_path##*/}/runs?branch=feat/tauri-v2&event=push&per_page=50" \
    --jq "first(.workflow_runs[] | select(.id < $RUN_ID and (.conclusion == \"success\" or .conclusion == \"failure\")) | .head_sha) // empty") \
    && [ -n "$saved" ]; then
    queue_tested=true
    from="$saved"
  fi
  echo "post-merge: '$gate' passed in the merge queue at $SHA: $passed; last push run not cancelled: ${saved:-none}" >&2
fi

echo "queue_tested=$queue_tested"
echo "from=$from"
