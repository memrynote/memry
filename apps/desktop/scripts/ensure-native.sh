#!/bin/bash
# Rebuilds better-sqlite3 for the target runtime (node or electron) only when needed.
# Uses a stamp file to track which runtime the binary was last compiled for,
# avoiding the 5-10s rebuild penalty on every pnpm dev / pnpm test.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_ROOT/../.." && pwd)"
TARGET="${1:-node}"
MODULES="better-sqlite3,keytar"
STAMP_FILE="$APP_ROOT/node_modules/.native-build-target"
MODULE_DIR="$(node -e "const path = require('path'); process.stdout.write(path.dirname(require.resolve('better-sqlite3/package.json')))")"
ELECTRON_INSTALL_SCRIPT="$(node -e "process.stdout.write(require.resolve('electron/install.js'))")"
ELECTRON_DIR="$(dirname "$ELECTRON_INSTALL_SCRIPT")"
PINNED_NODE_MAJOR=""

if [ -f "$REPO_ROOT/.nvmrc" ]; then
  PINNED_NODE_MAJOR="$(tr -d '[:space:]v' < "$REPO_ROOT/.nvmrc")"
fi

mkdir -p "$(dirname "$STAMP_FILE")"
cd "$APP_ROOT"

CURRENT_STAMP=""
if [ -f "$STAMP_FILE" ]; then
  CURRENT_STAMP=$(cat "$STAMP_FILE")
fi

has_native_binary() {
  find "$MODULE_DIR" -type f -name '*.node' | grep -q .
}

has_electron_binary() {
  local electron_path=""

  if [ ! -f "$ELECTRON_DIR/path.txt" ]; then
    return 1
  fi

  electron_path="$(cat "$ELECTRON_DIR/path.txt")"

  if [ -z "$electron_path" ]; then
    return 1
  fi

  [ -f "$ELECTRON_DIR/dist/$electron_path" ]
}

if [ "$CURRENT_STAMP" = "$TARGET" ] && has_native_binary; then
  if [ "$TARGET" != "electron" ] || has_electron_binary; then
    echo "[native] already built for $TARGET — skipping"
    exit 0
  fi

  echo "[electron] bundle missing for $TARGET runtime — reinstalling..."
fi

if [ "$CURRENT_STAMP" = "$TARGET" ] && ! has_native_binary; then
  echo "[native] stamp says $TARGET, but no native binary was found — rebuilding..."
fi

if [ "$TARGET" = "electron" ]; then
  if [ -n "$PINNED_NODE_MAJOR" ]; then
    CURRENT_NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
    if [ "$CURRENT_NODE_MAJOR" != "$PINNED_NODE_MAJOR" ]; then
      echo "[native] Electron rebuild requires Node $PINNED_NODE_MAJOR from $REPO_ROOT/.nvmrc; current runtime is $(node -v)." >&2
      echo "[native] Switch to Node $PINNED_NODE_MAJOR and rerun 'pnpm dev'." >&2
      exit 1
    fi
  fi

  if ! has_electron_binary; then
    echo "[electron] binary missing — installing..."
    node "$ELECTRON_INSTALL_SCRIPT"
  fi

  echo "[native] rebuilding $MODULES for Electron..."
  pnpm exec electron-rebuild -f -o "$MODULES"
else
  echo "[native] rebuilding $MODULES for Node $(node -v)..."
  for mod in ${MODULES//,/ }; do
    pnpm rebuild "$mod" 2>/dev/null || npm rebuild "$mod"
  done
fi

echo "$TARGET" > "$STAMP_FILE"
