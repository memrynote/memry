#!/usr/bin/env bash
set -euo pipefail

# Sync shared contracts from Electron app to sync-server
# Only syncs files the server actually needs (not client-only IPC contracts)

SOURCE_DIR="src/shared/contracts"
TARGET_DIR="sync-server/src/contracts"

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
)

if [ ! -d "$SOURCE_DIR" ]; then
  echo "ERROR: Source directory $SOURCE_DIR not found"
  exit 1
fi

if [ ! -d "$TARGET_DIR" ]; then
  mkdir -p "$TARGET_DIR"
fi

SYNCED=0
CHANGED=0

for filename in "${SHARED_FILES[@]}"; do
  file="$SOURCE_DIR/$filename"
  target="$TARGET_DIR/$filename"

  if [ ! -f "$file" ]; then
    echo "  WARNING: $filename not found in $SOURCE_DIR"
    continue
  fi

  if [ ! -f "$target" ] || ! diff -q "$file" "$target" > /dev/null 2>&1; then
    cp "$file" "$target"
    CHANGED=$((CHANGED + 1))
    echo "  Updated: $filename"
  fi
  SYNCED=$((SYNCED + 1))
done

if [ "$CHANGED" -eq 0 ]; then
  echo "Contracts in sync ($SYNCED files checked)"
else
  echo "Synced $CHANGED/$SYNCED contract files"
fi
