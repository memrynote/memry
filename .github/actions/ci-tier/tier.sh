#!/usr/bin/env bash
# Decides the CI tier (see action.yml for what each output means). Reads the changed files, one per
# line, on stdin, and prints `key=value` lines for $GITHUB_OUTPUT on stdout.
#
# Env: EVENT, REF, BASE_REF, LABELS (comma-joined), LISTED (true when stdin holds the real file
# list; false when there is no list or it could not be read, which fails the path outputs open).
# scripts/ci-tier.test.mjs runs this file with the diffs it protects.
set -euo pipefail

files=$(cat)

# Every match below reads its whole input: `grep -q` exits at the first hit, the writer then dies of
# SIGPIPE once the list outgrows the pipe buffer (~1000 files), and pipefail turned that hit into
# "no match", so a large PR skipped the jobs its own changes needed.

emit() {
  { echo "full=$1"; echo "tauri=$2"; echo "swift=$3"; echo "electron=$4"; echo "intel=$5"; echo "macos=$6"; }
  echo "tier: full=$1 tauri=$2 swift=$3 electron=$4 intel=$5 macos=$6" >&2
}

# Intel Macs run on main and on workflow_dispatch only. A PR into feat/tauri-v2, the merge
# queue and a push to feat/tauri-v2 skip them (a scheduled run cannot target feat/tauri-v2:
# schedules fire from the default branch's workflow files).
intel=true
if [ "$EVENT" = "merge_group" ] \
  || { [ "$EVENT" = "pull_request" ] && [ "$BASE_REF" = "feat/tauri-v2" ]; } \
  || { [ "$EVENT" = "push" ] && [ "$REF" = "refs/heads/feat/tauri-v2" ]; }; then
  intel=false
fi

# Apple Silicon Macs skip only the merge queue: the push that follows a merge runs them.
macos=true
if [ "$EVENT" = "merge_group" ]; then macos=false; fi

# Electron desktop: the app, what it bundles or typechecks, root configs and locks, and this
# workflow's own definitions.
electron=true
if [ "$LISTED" = true ]; then
  electron=false
  if printf '%s\n' "$files" | grep -E '^(apps/(desktop|extension|cli)/|packages/|scripts/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig[^/]*\.json$|oxlint\.config\.mts$|\.oxfmtrc\.jsonc$|turbo\.json$|\.nvmrc$|\.husky/|\.github/(workflows/desktop-ci\.yml|actions/))' >/dev/null; then
    electron=true
  fi
fi

if [ "$EVENT" != "pull_request" ] || [ "$BASE_REF" != "feat/tauri-v2" ]; then
  emit true true true "$electron" "$intel" "$macos"; exit 0
fi
if [[ ",$LABELS," == *",full-ci,"* ]]; then
  emit true true true "$electron" "$intel" "$macos"; exit 0
fi

if [ "$LISTED" != true ]; then
  emit false true true "$electron" "$intel" "$macos"; exit 0
fi

# App behavior: the Tauri app and its Rust shells, everything the renderer bundles
# (packages/, minus the two packages only Swift and the extraction oracle consume),
# dependency locks, and the CI definitions. The pure article-extraction library under
# crates/memry-desktop/src/web/extract/ has its own unit tests and its own oracle gate.
tauri=false
if printf '%s\n' "$files" | grep -Ev '^crates/memry-desktop/src/web/extract/' \
  | grep -E '^(apps/desktop-tauri/|crates/memry-tauri/|crates/memry-desktop/|crates/Cargo\.(toml|lock)$|pnpm-lock\.yaml$|packages/(app-core|contracts|db-schema|domain-[a-z]+|editor-schema|i18n|importers|rpc|shared|storage-[a-z]+|sync-[a-z]+|typescript-config)/|\.github/(workflows|actions|scripts)/)' >/dev/null; then
  tauri=true
fi

# The Swift bindings are generated from memry-core's UniFFI surface and consumed by iOS.
swift=false
if printf '%s\n' "$files" | grep -Ei '^(crates/memry-core/|apps/ios/|packages/swift/|\.github/workflows/rust-ci\.yml$)|uniffi' >/dev/null; then
  swift=true
fi
emit false "$tauri" "$swift" "$electron" "$intel" "$macos"
