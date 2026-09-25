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
  PINNED_NODE_MAJOR="$(tr -d '[:space:]v' <"$REPO_ROOT/.nvmrc")"
fi

LOCK_DIR="$APP_ROOT/node_modules/.native-build.lock"
LOCK_HELD=0

mkdir -p "$(dirname "$STAMP_FILE")"
cd "$APP_ROOT"

read_stamp() {
  if [ -f "$STAMP_FILE" ]; then
    cat "$STAMP_FILE"
  fi
}

CURRENT_STAMP="$(read_stamp)"

release_lock() {
  if [ "$LOCK_HELD" = 1 ]; then
    rm -rf "$LOCK_DIR"
    LOCK_HELD=0
  fi
}

# Serialize rebuilds across processes. postinstall warms the native build in a
# detached background process (scripts/warm-native.mjs); without this lock a
# `pnpm dev` started while that warm-up is still running would launch a second
# concurrent electron-rebuild over the same node_modules.
acquire_lock() {
  local waited=0 owner_pid announced=0

  while true; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo $$ >"$LOCK_DIR/pid"
      LOCK_HELD=1
      trap release_lock EXIT
      return 0
    fi

    owner_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -z "$owner_pid" ] || ! kill -0 "$owner_pid" 2>/dev/null; then
      echo "[native] clearing stale build lock (pid ${owner_pid:-unknown})"
      rm -rf "$LOCK_DIR"
      continue
    fi

    if [ "$announced" = 0 ]; then
      echo "[native] another native build is running (pid $owner_pid) — waiting..."
      announced=1
    fi

    sleep 2
    waited=$((waited + 2))
    if [ "$waited" -ge 900 ]; then
      echo "[native] timed out waiting for $LOCK_DIR; remove it if no build is running." >&2
      exit 1
    fi
  done
}

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

native_ready() {
  [ "$CURRENT_STAMP" = "$TARGET" ] || return 1
  has_native_binary || return 1
  [ "$TARGET" != "electron" ] || has_electron_binary
}

# Per-runtime binary cache.
#
# Node (vitest) and Electron (dev/e2e) need different ABIs, and both builds write
# the same <module>/build/Release/*.node files. Without a cache every switch
# between `pnpm test` and `pnpm dev` recompiles everything, classic-level's
# LevelDB from source included. After each successful build we snapshot the
# .node files under a key that pins the runtime ABI, and on a later switch we
# restore that snapshot instead of rebuilding.
#
# The key includes platform/arch and the Node ABI or Electron version; module
# versions are covered by the .pnpm path (e.g. classic-level@1.4.1), so a
# dependency or runtime bump misses the cache and falls through to a rebuild.
CACHE_ROOT="$APP_ROOT/node_modules/.native-cache"

cache_key() {
  local target="$1" platform runtime
  platform="$(node -p 'process.platform + "-" + process.arch')"
  if [ "$target" = "electron" ]; then
    runtime="electron-$(node -p "require('$ELECTRON_DIR/package.json').version")"
  else
    runtime="node-abi$(node -p 'process.versions.modules')"
  fi
  echo "$platform-$runtime"
}

native_module_dirs() {
  local dir
  for dir in \
    "$REPO_ROOT"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 \
    "$REPO_ROOT"/node_modules/.pnpm/keytar@*/node_modules/keytar \
    "$REPO_ROOT"/node_modules/.pnpm/classic-level@*/node_modules/classic-level; do
    [ -d "$dir" ] && echo "$dir"
  done
}

save_cache() {
  local target="$1" cache_dir dir rel file
  cache_dir="$CACHE_ROOT/$(cache_key "$target")"
  rm -rf "$cache_dir"
  while IFS= read -r dir; do
    rel="${dir#"$REPO_ROOT/"}"
    for file in "$dir"/build/Release/*.node; do
      [ -f "$file" ] || continue
      mkdir -p "$cache_dir/$rel"
      cp "$file" "$cache_dir/$rel/"
    done
    # Every module must have a binary, or the snapshot is incomplete and useless.
    if [ ! -d "$cache_dir/$rel" ]; then
      rm -rf "$cache_dir"
      return 0
    fi
  done < <(native_module_dirs)
  touch "$cache_dir/.complete"
  echo "[native] cached $target binaries ($(basename "$cache_dir"))"
}

# @electron/rebuild writes build/Release/.forge-meta ("<arch>--<abi>") and skips
# any module whose marker matches, even with -f. The node build and a cache
# restore replace the .node files but not the marker, so a stale "electron ABI"
# marker would make the next Electron rebuild skip better-sqlite3 and keytar and
# leave Node-ABI binaries behind. Drop the markers whenever the binaries change.
clear_forge_meta() {
  local dir
  while IFS= read -r dir; do
    rm -f "$dir/build/Release/.forge-meta"
  done < <(native_module_dirs)
}

restore_cache() {
  local target="$1" cache_dir dir rel file dest
  cache_dir="$CACHE_ROOT/$(cache_key "$target")"
  [ -f "$cache_dir/.complete" ] || return 1

  while IFS= read -r dir; do
    rel="${dir#"$REPO_ROOT/"}"
    compgen -G "$cache_dir/$rel/*.node" >/dev/null || return 1
  done < <(native_module_dirs)

  while IFS= read -r dir; do
    rel="${dir#"$REPO_ROOT/"}"
    mkdir -p "$dir/build/Release"
    for file in "$cache_dir/$rel"/*.node; do
      dest="$dir/build/Release/$(basename "$file")"
      # Copy then rename: a new inode, so a still-running process that has the
      # old binary mapped is not handed a file rewritten underneath it.
      cp "$file" "$dest.tmp.$$"
      mv -f "$dest.tmp.$$" "$dest"
    done
  done < <(native_module_dirs)
  clear_forge_meta
  echo "[native] restored cached $target binaries ($(basename "$cache_dir"))"
}

if native_ready; then
  echo "[native] already built for $TARGET — skipping"
  exit 0
fi

# Slow path: take the lock, then re-read the stamp. A background warm-up may
# have finished the exact build we were about to start while we were queued.
acquire_lock
CURRENT_STAMP="$(read_stamp)"

if native_ready; then
  echo "[native] already built for $TARGET — skipping"
  exit 0
fi

# Before overwriting the other runtime's build, snapshot it if it is not cached
# yet, so switching back later is a copy instead of a recompile. This also seeds
# the cache on installs that predate it.
if [ -n "$CURRENT_STAMP" ] && [ "$CURRENT_STAMP" != "$TARGET" ] && has_native_binary &&
  [ ! -f "$CACHE_ROOT/$(cache_key "$CURRENT_STAMP")/.complete" ]; then
  save_cache "$CURRENT_STAMP"
fi

if [ "$TARGET" = "electron" ] && ! has_electron_binary; then
  echo "[electron] binary missing — installing..."
  install_electron_binary
fi

if restore_cache "$TARGET"; then
  echo "$TARGET" >"$STAMP_FILE"
  exit 0
fi

if [ "$CURRENT_STAMP" = "$TARGET" ] && has_native_binary; then
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
  clear_forge_meta
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

  # Every module is driven by --module-dir; a dependency walk from $APP_ROOT is
  # not used because under pnpm it misses them. Its scan of apps/desktop/node_modules
  # does not follow the pnpm symlinks, so `-o better-sqlite3,keytar,classic-level`
  # only ever built the dev-only classic-level 3.x and left better-sqlite3 and
  # keytar on whatever ABI they last had (Node, after `pnpm test`).
  #
  # classic-level additionally needs --build-from-source, for two
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
  while IFS= read -r module_dir; do
    module_name="$(basename "$module_dir")"
    echo "[native] force-building ${module_dir#"$REPO_ROOT/"} for Electron"
    if [ "$module_name" = "classic-level" ]; then
      node "$ELECTRON_REBUILD_CLI" -f --build-from-source --only classic-level --module-dir "$module_dir"
    else
      node "$ELECTRON_REBUILD_CLI" -f --only "$module_name" --module-dir "$module_dir"
    fi
  done < <(native_module_dirs)
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
        (cd "$classic_dir" && pnpm exec node-gyp rebuild) && classic_built=1
      done
      [ "$classic_built" = 1 ] || pnpm rebuild "$mod" || npm rebuild "$mod"
    else
      pnpm rebuild "$mod" 2>/dev/null || npm rebuild "$mod"
    fi
  done
fi

save_cache "$TARGET"
echo "$TARGET" >"$STAMP_FILE"
