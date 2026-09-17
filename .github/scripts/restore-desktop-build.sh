#!/bin/bash
# Restores the desktop-build artifact packed by pack-desktop-build.sh and proves
# the restore actually satisfies ensure-native.sh — a half-restored tree would
# just make the job rebuild from source and quietly give back the time this
# artifact saves.

set -euo pipefail

ARCHIVE="${1:-desktop-build-linux.tar.gz}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f "$ARCHIVE" ]; then
  echo "::error::restore-desktop-build: $ARCHIVE not found (download-artifact step missing?)" >&2
  exit 1
fi

tar -xzf "$ARCHIVE"
rm -f "$ARCHIVE"

if [ ! -f apps/desktop/out/main/index.js ]; then
  echo "::error::restore-desktop-build: apps/desktop/out/main/index.js missing after extract" >&2
  exit 1
fi

stamp="$(cat apps/desktop/node_modules/.native-build-target 2>/dev/null || echo '<none>')"
if [ "$stamp" != "electron" ]; then
  echo "::error::restore-desktop-build: native stamp is \"$stamp\", expected \"electron\"" >&2
  exit 1
fi

# `pnpm install` ran before this and may have relinked the store; confirm the
# Electron-ABI binaries survived the extract.
for module in better-sqlite3 keytar classic-level; do
  if ! find "node_modules/.pnpm" -maxdepth 7 -path "*/$module/build/Release/*.node" | grep -q .; then
    echo "::error::restore-desktop-build: no built .node for $module after extract" >&2
    exit 1
  fi
done

echo "Desktop build restored from $ARCHIVE"
