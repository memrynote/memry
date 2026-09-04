#!/bin/bash
# Rebuilds the native modules for the target runtime (node or electron) only when needed.
# Uses a stamp file to track which runtime the binary was last compiled for,
# avoiding the 5-10s rebuild penalty on every pnpm dev / pnpm test.
# classic-level ships per-platform prebuilds; without a from-source rebuild the Linux CI
# runner can load the bundled darwin prebuild (invalid ELF header → ERR_DLOPEN), so it
# must be rebuilt for the runner like better-sqlite3.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_ROOT/../.." && pwd)"
TARGET="${1:-node}"
MODULES="better-sqlite3,keytar,classic-level"
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

install_electron_binary() {
  node "$SCRIPT_DIR/install-electron-binary.cjs" "$ELECTRON_DIR"
  echo "[electron] installer helper completed"
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
    install_electron_binary
  fi

  echo "[native] rebuilding $MODULES for Electron..."
  # Run @electron/rebuild's CLI directly with node instead of `pnpm exec`:
  # pnpm's pre-exec deps-status check can decide to `pnpm install --production`,
  # which prunes devDependencies — and the build toolchain (electron, vite,
  # @electron/rebuild itself) lives there. Same technique as build-packaged-app.js.
  ELECTRON_REBUILD_CLI="$(node -e "
    const path = require('path')
    const { createRequire } = require('module')
    const marker = path.join('@electron', 'rebuild')
    const main = createRequire(path.join('$APP_ROOT', 'package.json')).resolve('@electron/rebuild')
    const i = main.lastIndexOf(marker)
    process.stdout.write(path.join(main.slice(0, i + marker.length), 'lib', 'cli.js'))
  ")"
  node "$ELECTRON_REBUILD_CLI" -f -o "$MODULES"

  # That call leaves classic-level as the upstream Node prebuild, for two
  # independent reasons. v2026.903.2 shipped to Windows that way: better-sqlite3
  # and keytar had build/Release binaries in the package, classic-level had none,
  # so the CRDT store ran on prebuilds/win32-x64/node.napi.node.
  #
  # 1. @electron/rebuild's module walker only descends into `<module>/node_modules`.
  #    Under pnpm, y-leveldb's level -> classic-level@1.4.x sits in a sibling
  #    directory inside .pnpm, so the copy the CRDT store actually loads is never
  #    visited. The only walkable classic-level is the dev-only 3.x, which
  #    electron-builder then prunes out of the package.
  # 2. Even when visited, Prebuildify.findPrebuiltModule accepts an existing
  #    node.napi.node and short-circuits the compile. `-f` does not override that;
  #    only --build-from-source does.
  #
  # So drive each copy in the store directly: --module-dir is always a rebuild
  # candidate regardless of the walk, and --build-from-source skips the prebuild
  # short-circuit. Same reasoning as the node branch below.
  for classic_dir in "$REPO_ROOT"/node_modules/.pnpm/classic-level@*/node_modules/classic-level; do
    [ -d "$classic_dir" ] || continue
    echo "[native] force-building ${classic_dir#"$REPO_ROOT/"} for Electron"
    node "$ELECTRON_REBUILD_CLI" -f --build-from-source --only classic-level --module-dir "$classic_dir"
  done
else
  echo "[native] rebuilding $MODULES for Node $(node -v)..."
  for mod in ${MODULES//,/ }; do
    if [ "$mod" = "classic-level" ]; then
      # classic-level resolves a bundled prebuild via node-gyp-build, which can pick the
      # wrong platform binary on CI (darwin prebuild on Linux → invalid ELF header →
      # ERR_DLOPEN). `pnpm rebuild` keeps using that prebuild, so force a from-source
      # compile; node-gyp-build then loads the local build/Release binary instead.
      # Multiple versions coexist (direct 3.x + y-leveldb's transitive 1.4.x), so build
      # every instance in the store, not just the one resolved from this workspace.
      classic_built=0
      for classic_dir in "$REPO_ROOT"/node_modules/.pnpm/classic-level@*/node_modules/classic-level; do
        [ -d "$classic_dir" ] || continue
        echo "[native] force-building ${classic_dir#"$REPO_ROOT/"}"
        ( cd "$classic_dir" && pnpm exec node-gyp rebuild ) && classic_built=1
      done
      [ "$classic_built" = 1 ] || pnpm rebuild "$mod" || npm rebuild "$mod"
    else
      pnpm rebuild "$mod" 2>/dev/null || npm rebuild "$mod"
    fi
  done
fi

echo "$TARGET" > "$STAMP_FILE"
