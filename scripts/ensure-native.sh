#!/bin/bash
# Rebuilds better-sqlite3 for the target runtime (node or electron) only when needed.
# Uses a stamp file to track which runtime the binary was last compiled for,
# avoiding the 5-10s rebuild penalty on every pnpm dev / pnpm test.

set -euo pipefail

TARGET="${1:-node}"
MODULE="better-sqlite3"
STAMP_FILE="node_modules/.native-build-target"

CURRENT_STAMP=""
if [ -f "$STAMP_FILE" ]; then
  CURRENT_STAMP=$(cat "$STAMP_FILE")
fi

if [ "$CURRENT_STAMP" = "$TARGET" ]; then
  echo "[$MODULE] already built for $TARGET — skipping"
  exit 0
fi

if [ "$TARGET" = "electron" ]; then
  echo "[$MODULE] rebuilding for Electron..."
  npx @electron/rebuild -f -o "$MODULE"
else
  echo "[$MODULE] rebuilding for Node $(node -v)..."
  pnpm rebuild "$MODULE" 2>/dev/null || npm rebuild "$MODULE"
fi

echo "$TARGET" > "$STAMP_FILE"
