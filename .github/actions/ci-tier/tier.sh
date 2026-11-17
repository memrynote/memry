#!/usr/bin/env bash
# Decides the CI tier (see action.yml for what each output means). Reads the changed files, one per
# line, on stdin, and prints `key=value` lines for $GITHUB_OUTPUT on stdout.
#
# Env: EVENT, REF, BASE_REF, LABELS (comma-joined), LISTED (true when stdin holds the real file
# list; false when there is no list or it could not be read, which fails open), PATCHES (a pull
# request's files as JSON lines `{"filename", "previous_filename", "patch", "changes"}`, as the
# GitHub API returns them; unset or missing when they could not be read, which fails the OS legs
# open), SOURCE_ROOT (a checkout holding the PR's Rust sources, read by os-modules.sh; unset fails
# the OS legs open), QUEUE_TESTED (true when this push's SHA passed the calling workflow's merge_group
# run; anything else runs every leg), POST_MERGE (true when the caller opts in to the post-merge
# schedule), SCHEDULE_TESTED (true when a scheduled run of the calling workflow already finished on
# this SHA).
# scripts/ci-tier.test.mjs runs this file with the diffs it protects.
set -euo pipefail

files=$(cat)

# Every match below reads its whole input: `grep -q` exits at the first hit, the writer then dies of
# SIGPIPE once the list outgrows the pipe buffer (~1000 files), and pipefail turned that hit into
# "no match", so a large PR skipped the jobs its own changes needed.

emit() {
  { echo "full=$1"; echo "tauri=$2"; echo "swift=$3"; echo "electron=$4"; echo "intel=$5"; echo "macos=$6"
    echo "rust_windows=$7"; echo "rust_macos=$8"; echo "tauri_windows=$9"; echo "tauri_macos=${10}"; echo "rust_linux_arm64=${11}"
    echo "post_merge=${12}"; }
  echo "tier: full=$1 tauri=$2 swift=$3 electron=$4 intel=$5 macos=$6 rust_windows=$7 rust_macos=$8 tauri_windows=$9 tauri_macos=${10} rust_linux_arm64=${11} post_merge=${12}" >&2
}

# A tiered PR is any PR whose base is not main: one into feat/tauri-v2, or one stacked on another PR's
# branch, which reaches feat/tauri-v2 through the merge queue like the rest.
tiered=false
if [ "$EVENT" = "pull_request" ] && [ "$BASE_REF" != "main" ]; then tiered=true; fi

# Intel Macs run on main and on workflow_dispatch only. A tiered PR, the merge queue, and a push or
# scheduled run of feat/tauri-v2 skip them (Nightly proptest runs the Intel leg).
intel=true
if [ "$EVENT" = "merge_group" ] || [ "$tiered" = true ] \
  || { { [ "$EVENT" = "push" ] || [ "$EVENT" = "schedule" ]; } && [ "$REF" = "refs/heads/feat/tauri-v2" ]; }; then
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

# The pull request files API stops at 3000 files, so a list that long may be cut short.
if [ "$EVENT" = "pull_request" ] && [ "$(printf '%s\n' "$files" | grep -c .)" -ge 3000 ]; then LISTED=false; fi

# Post-merge (#5035). A push to feat/tauri-v2 re-tests the SHA the merge queue passed, and the legs the
# queue skips (Apple Silicon, the windows-arm64 e2e specs; rust-legs.jq, tauri-builds.jq) run on the
# 6-hourly schedule of feat/tauri-v2 (`post_merge=true`). So a push that passed the queue runs nothing
# (`covered`, which also turns off the macOS-only jobs: macos=false). It runs every leg when the SHA did
# not pass the queue (a bypass push) or the file list is unreadable, and when the range changes a
# cache-key input: pushes save the caches PRs and the queue restore, and rust-cache, setup-node and
# tesseract-sources save only under a new key. For a push the range starts at the last push run that
# was not cancelled (post-merge.sh), so a superseded run's cache-key change counts too. The ml-worker's
# build.rs is in the Tesseract sources key (tesseract-sources/action.yml). A scheduled run of a SHA a
# scheduled run already finished is `covered` too.
if [ "$EVENT" = "push" ] && [ "$REF" = "refs/heads/feat/tauri-v2" ] && [ "${QUEUE_TESTED:-false}" = true ] && [ "$LISTED" = true ] \
  && ! printf '%s\n' "$files" | grep -E '(^|/)Cargo\.(toml|lock)$|(^|/)rust-toolchain(\.toml)?$|(^|/)\.cargo/|^pnpm-lock\.yaml$|^scripts/fetch-(pdfium|tesseract-sources)\.mjs$|^crates/memry-ml-worker/build\.rs$|^\.github/(actions/|workflows/(rust-ci|desktop-tauri-ci)\.yml$)' >/dev/null; then
  emit true true false "$electron" "$intel" false none none none none false covered; exit 0
fi
if [ "${POST_MERGE:-false}" = true ] && [ "$EVENT" = "schedule" ] && [ "$REF" = "refs/heads/feat/tauri-v2" ]; then
  if [ "${SCHEDULE_TESTED:-false}" = true ]; then
    emit true true false "$electron" "$intel" false none none none none false covered; exit 0
  fi
  emit true true true "$electron" "$intel" "$macos" tests tests tests tests false true; exit 0
fi

# Untiered runs, `full-ci` and an unreadable file list run every leg.
if [ "$tiered" != true ] || [[ ",$LABELS," == *",full-ci,"* ]] || [ "$LISTED" != true ]; then
  emit true true true "$electron" "$intel" "$macos" tests tests tests tests true false; exit 0
fi

# A fast-tier PR adds the Linux arm64 worker leg when it changes the worker or the crates it links
# (memry-ml, memry-media), their native inputs (the build scripts, the ONNX Runtime pins in
# crates/.cargo/, pdfium and the Tesseract sources), the toolchain or lock, the golden vectors and
# tessdata its tests read (arm64 float kernels can miss a tolerance x64 meets), or the CI that builds them.
# Every full run, the merge queue included, runs the leg.
linux_arm64=false
if printf '%s\n' "$files" | grep -E '^(crates/(memry-ml-worker|memry-ml|memry-media)/|crates/(Cargo\.(toml|lock)|rust-toolchain\.toml)$|crates/\.cargo/|scripts/fetch-(pdfium|tesseract-sources)\.mjs$|packages/contracts/test-vectors/(embeddings-text|pixel-tensors|audio-features)\.json$|apps/desktop-tauri/src-tauri/resources/tessdata/|\.github/(actions/(ci-tier|free-disk|ort-static|tesseract-sources)/|workflows/rust-ci\.yml$))' >/dev/null; then
  linux_arm64=true
fi

# App behavior: the Tauri app and its Rust shells, everything the renderer bundles
# (packages/, minus the two packages only Swift and the extraction oracle consume),
# dependency locks and toolchain, and the CI definitions. The pure article-extraction library
# under crates/memry-desktop/src/web/extract/ has its own unit tests and its own oracle gate.
tauri_exclude='^crates/memry-desktop/src/web/extract/'
tauri=false
if printf '%s\n' "$files" | grep -Ev "$tauri_exclude" \
  | grep -E '^(apps/desktop-tauri/|crates/memry-tauri/|crates/memry-desktop/|crates/(Cargo\.(toml|lock)|rust-toolchain\.toml)$|crates/\.cargo/|pnpm-lock\.yaml$|packages/(app-core|contracts|db-schema|domain-[a-z]+|editor-schema|i18n|importers|rpc|shared|storage-[a-z]+|sync-[a-z]+|typescript-config)/|\.github/(workflows|actions|scripts)/)' >/dev/null; then
  tauri=true
fi

# The Swift bindings are generated from memry-core's UniFFI surface and consumed by iOS.
swift=false
if printf '%s\n' "$files" | grep -Ei '^(crates/memry-core/|apps/ios/|packages/swift/|\.github/workflows/rust-ci\.yml$)|uniffi' >/dev/null; then
  swift=true
fi

# Extra OS legs (rules in os-legs.jq). Without the patches or the Rust sources they fail open.
patches=${PATCHES:-}
if [ -z "$patches" ] || [ ! -f "$patches" ]; then
  patches=$(mktemp)
  trap 'rm -f "$patches"' EXIT
  printf '%s\n' "$files" | jq -Rc 'select(length > 0) | {filename: ., patch: null}' > "$patches"
fi
if [ -n "${SOURCE_ROOT:-}" ] && modules=$(bash "$(dirname "$0")/os-modules.sh" "$SOURCE_ROOT"); then
  gated=$(printf '%s\n' "$modules" | jq -Rn '[inputs | select(length > 0) | split("\t") | {prefix: .[0], os: .[1]}]')
  legs=$(jq -sr --arg tauri_exclude "$tauri_exclude" --argjson gated "$gated" -f "$(dirname "$0")/os-legs.jq" "$patches")
else
  # stdout is $GITHUB_OUTPUT. Desktop CI passes no sources: it reads no OS leg.
  if [ -n "${SOURCE_ROOT:-}" ]; then echo "::warning::no Rust sources under $SOURCE_ROOT; adding every OS leg" >&2; fi
  legs="tests tests tests tests"
fi
read -r rust_windows rust_macos tauri_windows tauri_macos <<< "$legs"
emit false "$tauri" "$swift" "$electron" "$intel" "$macos" "$rust_windows" "$rust_macos" "$tauri_windows" "$tauri_macos" "$linux_arm64" false
