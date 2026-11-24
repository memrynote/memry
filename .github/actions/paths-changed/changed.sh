#!/usr/bin/env bash
# Reads a pull request's files as the files API lists them, one JSON object per entry
# (`{"filename", "previous_filename"}`), on stdin. Prints `true` when a changed path matches INCLUDE
# and not EXCLUDE (extended regexes), else `false`. scripts/ci-tier.test.mjs runs this file.
set -euo pipefail
entries=$(cat)
# The API lists at most 3000 files, so a list that long may be cut short: count it as a change.
if [ "$(printf '%s\n' "$entries" | jq -s length)" -ge 3000 ]; then
  echo true; exit 0
fi
# A rename changes both its paths: moving a file out of crates/ changes crates/.
files=$(printf '%s\n' "$entries" | jq -r '.filename, (.previous_filename // empty)')
# The match reads its whole input: with `grep -q` the writer died of SIGPIPE on a list larger than
# the pipe buffer, and pipefail turned the hit into "unchanged".
if printf '%s\n' "$files" | grep -Ev "$EXCLUDE" | grep -E "$INCLUDE" >/dev/null; then
  echo true
else
  echo false
fi
