#!/bin/bash
# Prepares a fresh worktree so `pnpm test` and `pnpm dev` start without waiting.
#
# `pi-worktree new` runs this detached right after creating the worktree, so the
# agent can start editing while dependencies and native binaries build behind it.
# Safe to run by hand and to re-run: every step is idempotent.
#
# Steps:
#   1. pnpm install (postinstall warm-up skipped; step 2 does the full build)
#   2. native modules for Node, then Electron. Both land in
#      apps/desktop/node_modules/.native-cache, and Electron runs last so the
#      stamp ends on "electron" and `pnpm dev` skips the rebuild.
#   3. the macOS Calendar helper `predev` would otherwise build
#
# Progress: .worktree-setup.log in the worktree root. The last line is
# "READY" on success or "FAILED (step)" on failure.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

step() {
  local name="$1"
  shift
  echo "==> $name ($(date +%T))"
  if ! "$@"; then
    echo "FAILED ($name)"
    exit 1
  fi
}

step "pnpm install" env SKIP_ELECTRON_REBUILD=1 pnpm install --frozen-lockfile
step "native: node" bash apps/desktop/scripts/ensure-native.sh node
step "native: electron" bash apps/desktop/scripts/ensure-native.sh electron
step "eventkit helper" node apps/desktop/scripts/build-eventkit-helper.mjs --optional

echo "READY ($(date +%T))"
