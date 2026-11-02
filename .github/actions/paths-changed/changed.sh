#!/usr/bin/env bash
# Prints `true` when a changed file (stdin, one per line) matches INCLUDE and not EXCLUDE (extended
# regexes), else `false`. scripts/ci-tier.test.mjs runs this file.
set -euo pipefail
files=$(cat)
# The match reads its whole input: with `grep -q` the writer died of SIGPIPE on a list larger than
# the pipe buffer, and pipefail turned the hit into "unchanged".
if printf '%s\n' "$files" | grep -Ev "$EXCLUDE" | grep -E "$INCLUDE" >/dev/null; then
  echo true
else
  echo false
fi
