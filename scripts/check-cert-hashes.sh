#!/usr/bin/env bash
set -euo pipefail

# Build-time check: ensure certificate pinning hashes are not placeholders
# Prevents shipping a production build with fake SPKI hashes

FILE="src/main/sync/certificate-pinning.ts"

if grep -q 'PLACEHOLDER' "$FILE"; then
  echo "ERROR: Placeholder certificate hashes found in $FILE"
  echo "Run 'pnpm cert:extract' to get real SPKI hashes, then update PINNED_CERTIFICATE_HASHES."
  exit 1
else
  echo "Certificate hashes OK — no placeholders found"
fi
