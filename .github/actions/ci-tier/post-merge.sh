#!/usr/bin/env bash
# The post-merge lookups (#5035) for a push to, or a scheduled run of, feat/tauri-v2 in a workflow that
# opts in (POST_MERGE=true).
#
# A merge-queue merge fast-forwards feat/tauri-v2 to the commit the queue tested, so the push re-tests a
# SHA this workflow already passed. For a push this prints `queue_tested=true` when a merge_group run of
# the calling workflow on SHA has a successful `<WORKFLOW_NAME> gate` job (the run itself finishes later,
# after its flaky-test report), and `from=<sha>`, the SHA of the newest earlier push run that was not
# cancelled: a superseded run may not have saved its caches, so the push's range starts there for the
# cache-key check in tier.sh.
#
# For a scheduled run this prints `schedule_tested=true` when an earlier scheduled run of the calling
# workflow passed SHA. Only a pass covers it, and only on the first attempt: "Re-run all jobs" on a failed
# scheduled run asks for the legs again, and would otherwise find a later skipped run and pass untested.
#
# A failed lookup, or no such run, prints false, and the legs run. Env: EVENT, REF, REPO, POST_MERGE,
# WORKFLOW_REF, WORKFLOW_NAME, SHA, RUN_ID, RUN_ATTEMPT. scripts/ci-tier.test.mjs runs this file with a
# stub `gh`.
set -euo pipefail

queue_tested=false
from=""
schedule_tested=false
workflow_path=${WORKFLOW_REF#"$REPO/"}
workflow_path=${workflow_path%%@*}
if [ "${POST_MERGE:-false}" = true ] && [ "$EVENT" = push ] && [ "$REF" = "refs/heads/feat/tauri-v2" ]; then
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
if [ "${POST_MERGE:-false}" = true ] && [ "$EVENT" = schedule ] && [ "$REF" = "refs/heads/feat/tauri-v2" ]; then
  passed=unknown
  if [ "${RUN_ATTEMPT:-1}" = 1 ] && passed=$(gh api "repos/$REPO/actions/runs?head_sha=$SHA&event=schedule&status=completed&per_page=100" \
    --jq "[.workflow_runs[] | select(.path == \"$workflow_path\" and .id < $RUN_ID and .conclusion == \"success\")] | length") \
    && [ "$passed" -gt 0 ]; then
    schedule_tested=true
  fi
  echo "post-merge: attempt ${RUN_ATTEMPT:-1}; earlier scheduled runs that passed $SHA: $passed" >&2
fi

echo "queue_tested=$queue_tested"
echo "from=$from"
echo "schedule_tested=$schedule_tested"
