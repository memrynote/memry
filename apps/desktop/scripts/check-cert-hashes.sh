#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "${CI:-}" = "true" ]; then
  echo "CI detected — skipping certificate hash check (not a production build)"
  exit 0
fi

node --experimental-strip-types --experimental-transform-types \
  "$APP_ROOT/scripts/check-cert-hashes.ts"
