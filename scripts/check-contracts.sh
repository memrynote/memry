#!/usr/bin/env bash
set -euo pipefail

# CI check: verify shared contracts match sync-server copies
# Only checks files the server needs (must match SHARED_FILES in sync-contracts.sh)

SOURCE_DIR="src/shared/contracts"
TARGET_DIR="sync-server/src/contracts"
DRIFT=0

SHARED_FILES=(
  "crypto.ts"
  "cbor-ordering.ts"
  "ipc-crdt.ts"
  "ipc-sync.ts"
  "ipc-auth.ts"
  "ipc-crypto.ts"
  "ipc-sync-ops.ts"
  "ipc-devices.ts"
  "ipc-attachments.ts"
  "ipc-events.ts"
  "auth-api.ts"
  "sync-api.ts"
  "sync-payloads.ts"
  "settings-sync.ts"
)

for filename in "${SHARED_FILES[@]}"; do
  file="$SOURCE_DIR/$filename"
  target="$TARGET_DIR/$filename"

  if [ ! -f "$file" ]; then
    continue
  fi

  if [ ! -f "$target" ]; then
    echo "MISSING: $filename not found in $TARGET_DIR"
    DRIFT=1
    continue
  fi

  if ! diff -q "$file" "$target" > /dev/null 2>&1; then
    echo "DRIFT: $filename differs between source and sync-server"
    diff --color=auto "$file" "$target" || true
    DRIFT=1
  fi
done

if [ "$DRIFT" -eq 1 ]; then
  echo ""
  echo "Contract drift detected! Run 'pnpm sync:contracts' to fix."
  exit 1
else
  echo "All contracts in sync"
fi
