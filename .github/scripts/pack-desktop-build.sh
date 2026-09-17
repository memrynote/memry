#!/bin/bash
# Packs everything a Linux Electron E2E job needs from a completed desktop build,
# so downstream jobs can skip `ensure-native.sh electron` + `electron-vite build`.
#
# What must be inside, and why (see apps/desktop/scripts/ensure-native.sh):
#   - apps/desktop/out                          electron-vite output the tests launch
#   - apps/desktop/node_modules/.native-build-target
#                                               the stamp; ensure-native.sh rebuilds
#                                               unless it reads exactly "electron",
#                                               and tests/e2e/global-setup.ts fails
#                                               the run outright without it
#   - <store>/better-sqlite3/build              the Electron-ABI .node; ensure-native
#                                               also treats a missing one as "rebuild"
#   - <store>/keytar/build                      same, keyring path
#   - <store>/classic-level@*/…/build           EVERY copy in the pnpm store: the
#                                               direct 3.x plus y-leveldb's transitive
#                                               1.4.x, which is the one the CRDT store
#                                               actually loads
#
# Miss any of these and the downstream job silently rebuilds, which is exactly the
# cost this artifact exists to remove.
#
# tar (not a multi-path upload-artifact) because it preserves file modes and the
# dot-prefixed paths upload-artifact excludes by default.

set -euo pipefail
shopt -s nullglob

ARCHIVE="${1:-desktop-build-linux.tar.gz}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

paths=(
  apps/desktop/out
  apps/desktop/node_modules/.native-build-target
)

for module_build in \
  node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build \
  node_modules/.pnpm/keytar@*/node_modules/keytar/build \
  node_modules/.pnpm/classic-level@*/node_modules/classic-level/build; do
  paths+=("$module_build")
done

for required in "${paths[@]}"; do
  if [ ! -e "$required" ]; then
    echo "::error::pack-desktop-build: missing $required — the build step did not produce it" >&2
    exit 1
  fi
done

# One sanity check that the stamp says what the E2E precondition demands, rather
# than shipping an artifact that makes every consumer rebuild.
stamp="$(cat apps/desktop/node_modules/.native-build-target)"
if [ "$stamp" != "electron" ]; then
  echo "::error::pack-desktop-build: native stamp is \"$stamp\", expected \"electron\"" >&2
  exit 1
fi

echo "Packing ${#paths[@]} paths into $ARCHIVE"
printf '  %s\n' "${paths[@]}"

tar -czf "$ARCHIVE" "${paths[@]}"
ls -lh "$ARCHIVE"
