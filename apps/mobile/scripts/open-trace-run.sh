#!/usr/bin/env bash
# Drive the on-device open-trace harness and print the report it writes.
# Usage: open-trace-run.sh [n] [size] [label]
set -euo pipefail

n="${1:-20}"
size="${2:-long}"
label="${3:-run}"
app=com.memry.mobile

container="$(xcrun simctl get_app_container booted "$app" data)"
report="$container/Documents/open-trace-report.txt"

before=0
[ -f "$report" ] && before="$(stat -f %m "$report")"

xcrun simctl terminate booted "$app" >/dev/null 2>&1 || true
xcrun simctl launch booted "$app" >/dev/null
sleep 4
xcrun simctl openurl booted "memry://open-trace?autorun=1&n=$n&size=$size"

deadline=$((SECONDS + 600))
while [ $SECONDS -lt $deadline ]; do
  if [ -f "$report" ] && [ "$(stat -f %m "$report")" -gt "$before" ]; then
    sleep 2
    echo "### $label  n=$n size=$size  $(date -u +%FT%TZ)"
    cat "$report"
    exit 0
  fi
  sleep 3
done

echo "open-trace: no new report after 600s at $report" >&2
exit 1
