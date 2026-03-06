#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Build-time check: ensure certificate pinning hashes are not placeholders
# Prevents shipping a production build with fake SPKI hashes

FILE="$APP_ROOT/src/main/sync/certificate-pinning.ts"

if grep -q 'PLACEHOLDER' "$FILE"; then
  echo "ERROR: Placeholder certificate hashes found in $FILE"
  echo "Run 'pnpm cert:extract' to get real SPKI hashes, then update PINNED_CERTIFICATE_HASHES."
  exit 1
else
  echo "Certificate hashes OK — no placeholders found"
fi
