#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "${CI:-}" = "true" ]; then
  echo "CI detected — skipping certificate hash check (not a production build)"
  exit 0
fi

FILE="$APP_ROOT/src/main/sync/certificate-pinning.ts"

if grep -q 'PLACEHOLDER' "$FILE"; then
  echo "ERROR: Placeholder certificate hashes found in $FILE"
  echo "Run 'pnpm cert:extract' to get real SPKI hashes, then update PINNED_CERTIFICATE_HASHES."
  exit 1
else
  echo "Certificate hashes OK — no placeholders found"
fi
