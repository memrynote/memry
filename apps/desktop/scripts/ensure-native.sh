#!/bin/bash
# Rebuilds better-sqlite3 for the target runtime (node or electron) only when needed.
# Uses a stamp file to track which runtime the binary was last compiled for,
# avoiding the 5-10s rebuild penalty on every pnpm dev / pnpm test.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="${1:-node}"
MODULE="better-sqlite3"
STAMP_FILE="$APP_ROOT/node_modules/.native-build-target"
MODULE_DIR="$(node -e "const path = require('path'); process.stdout.write(path.dirname(require.resolve(process.argv[1] + '/package.json')))" "$MODULE")"

mkdir -p "$(dirname "$STAMP_FILE")"
cd "$APP_ROOT"

CURRENT_STAMP=""
if [ -f "$STAMP_FILE" ]; then
  CURRENT_STAMP=$(cat "$STAMP_FILE")
fi

has_native_binary() {
  find "$MODULE_DIR" -type f -name '*.node' | grep -q .
}

if [ "$CURRENT_STAMP" = "$TARGET" ] && has_native_binary; then
  echo "[$MODULE] already built for $TARGET — skipping"
  exit 0
fi

if [ "$CURRENT_STAMP" = "$TARGET" ]; then
  echo "[$MODULE] stamp says $TARGET, but no native binary was found — rebuilding..."
fi

if [ "$TARGET" = "electron" ]; then
  echo "[$MODULE] rebuilding for Electron..."
  npx @electron/rebuild -f -o "$MODULE"
else
  echo "[$MODULE] rebuilding for Node $(node -v)..."
  pnpm rebuild "$MODULE" 2>/dev/null || npm rebuild "$MODULE"
fi

echo "$TARGET" > "$STAMP_FILE"
