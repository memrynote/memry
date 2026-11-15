#!/usr/bin/env bash
# Decides the CI tier (see action.yml for what each output means). Reads the changed files, one per
# line, on stdin, and prints `key=value` lines for $GITHUB_OUTPUT on stdout.
#
# Env: EVENT, REF, BASE_REF, LABELS (comma-joined), LISTED (true when stdin holds the real file
# list; false when there is no list or it could not be read, which fails open), PATCHES (a pull
# request's files as JSON lines `{"filename", "patch", "changes"}`, as the GitHub API returns them;
# unset or missing when they could not be read, which fails the OS legs open).
# scripts/ci-tier.test.mjs runs this file with the diffs it protects.
set -euo pipefail

files=$(cat)

# Every match below reads its whole input: `grep -q` exits at the first hit, the writer then dies of
# SIGPIPE once the list outgrows the pipe buffer (~1000 files), and pipefail turned that hit into
# "no match", so a large PR skipped the jobs its own changes needed.

emit() {
  { echo "full=$1"; echo "tauri=$2"; echo "swift=$3"; echo "electron=$4"; echo "intel=$5"; echo "macos=$6"
    echo "rust_windows=$7"; echo "rust_macos=$8"; echo "tauri_windows=$9"; echo "tauri_macos=${10}"; }
  echo "tier: full=$1 tauri=$2 swift=$3 electron=$4 intel=$5 macos=$6 rust_windows=$7 rust_macos=$8 tauri_windows=$9 tauri_macos=${10}" >&2
}

# A tiered PR is any PR whose base is not main: one into feat/tauri-v2, or one stacked on another PR's
# branch, which reaches feat/tauri-v2 through the merge queue like the rest.
tiered=false
if [ "$EVENT" = "pull_request" ] && [ "$BASE_REF" != "main" ]; then tiered=true; fi

# Intel Macs run on main and on workflow_dispatch only. A tiered PR, the merge queue and a push to
# feat/tauri-v2 skip them (a scheduled run cannot target feat/tauri-v2: schedules fire from the
# default branch's workflow files).
intel=true
if [ "$EVENT" = "merge_group" ] || [ "$tiered" = true ] \
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

# Untiered runs, `full-ci` and an unreadable file list run every leg.
if [ "$tiered" != true ] || [[ ",$LABELS," == *",full-ci,"* ]] || [ "$LISTED" != true ]; then
  emit true true true "$electron" "$intel" "$macos" tests tests tests tests; exit 0
fi

# App behavior: the Tauri app and its Rust shells, everything the renderer bundles
# (packages/, minus the two packages only Swift and the extraction oracle consume),
# dependency locks, and the CI definitions. The pure article-extraction library under
# crates/memry-desktop/src/web/extract/ has its own unit tests and its own oracle gate.
tauri_exclude='^crates/memry-desktop/src/web/extract/'
tauri=false
if printf '%s\n' "$files" | grep -Ev "$tauri_exclude" \
  | grep -E '^(apps/desktop-tauri/|crates/memry-tauri/|crates/memry-desktop/|crates/Cargo\.(toml|lock)$|pnpm-lock\.yaml$|packages/(app-core|contracts|db-schema|domain-[a-z]+|editor-schema|i18n|importers|rpc|shared|storage-[a-z]+|sync-[a-z]+|typescript-config)/|\.github/(workflows|actions|scripts)/)' >/dev/null; then
  tauri=true
fi

# The Swift bindings are generated from memry-core's UniFFI surface and consumed by iOS.
swift=false
if printf '%s\n' "$files" | grep -Ei '^(crates/memry-core/|apps/ios/|packages/swift/|\.github/workflows/rust-ci\.yml$)|uniffi' >/dev/null; then
  swift=true
fi

# Extra OS legs. The fast tier builds and tests on Linux only; a diff that can compile or behave
# differently on Windows or macOS adds that OS: `checks` (Rust fmt, clippy, doctests and the live OS
# seams; the Tauri debug build and its launch smoke), or `tests` (also the Rust test partitions; the
# Tauri e2e specs) when the change is in OS-specific tests or in how test binaries are built.
#   - a .rs file whose added or removed lines carry an OS `cfg` (`cfg`, `cfg_attr`, `cfg!` naming
#     windows, unix, target_os, target_family or target_env); `cfg(not(test))` alone is not one
#   - a path segment that names the OS (windows, win32, msvc; macos, darwin, apple, mac, .plist)
#   - Cargo manifests and the lock (checks); build.rs, .cargo/, the toolchain file, the composite
#     actions and the workflow itself (tests)
#   - a .rs file whose patch GitHub did not send (too large), or no patches at all: tests
# The Rust legs read every Rust-side file; the Tauri legs only the files the Tauri app builds from.
patches=${PATCHES:-}
if [ -z "$patches" ] || [ ! -f "$patches" ]; then
  patches=$(mktemp)
  trap 'rm -f "$patches"' EXIT
  printf '%s\n' "$files" | jq -Rc 'select(length > 0) | {filename: ., patch: null}' > "$patches"
fi
legs=$(jq -sr --arg tauri_exclude "$tauri_exclude" '
  def changed: (.patch // "") | split("\n")[] | select(test("^[+-]") and (test("^(\\+\\+\\+|---) ") | not)) | .[1:];
  def os_cfg: test("cfg(_attr)?!?\\s*\\(") and test("\\b(windows|unix|target_os|target_family|target_env)\\b");
  def win_line: os_cfg and test("\\b(windows|msvc|unix|not|target_family)\\b");
  def mac_line: os_cfg and test("\\b(macos|ios|apple|darwin|unix|not|target_family)\\b");
  def is_test: (.filename | test("(^|/)tests?/|(^|/)tests?\\.rs$|_tests?\\.rs$"))
    or any(changed; test("#\\[(tokio::)?test\\b|cfg\\((all\\()?test\\b"));
  def level(os_line; os_path):
    if (.filename | test("(^|/)build\\.rs$|(^|/)\\.cargo/|(^|/)rust-toolchain(\\.toml)?$|^\\.github/(actions/|workflows/(rust-ci|desktop-tauri-ci)\\.yml$)")) then 2
    elif (.filename | test("(^|/)Cargo\\.(toml|lock)$")) then 1
    elif (.filename | test(os_path; "i")) then (if is_test then 2 else 1 end)
    elif (.filename | endswith(".rs") | not) then 0
    elif .patch == null then (if (.changes // 1) > 0 then 2 else 0 end)
    elif any(changed; os_line) then (if is_test then 2 else 1 end)
    else 0 end;
  def win: level(win_line; "(^|[/._-])(windows|win32|win64|msvc)([/._-]|$)");
  def mac: level(mac_line; "(^|[/._-])(macos|darwin|apple|mac|osx)([/._-]|$)|\\.plist$");
  def name: ["none", "checks", "tests"][.];
  def most(f): (map(f) | max // 0) | name;
  (map(select(.filename | test("^(crates/|apps/desktop-tauri/src-tauri/|\\.github/(actions/|workflows/rust-ci\\.yml$))")))) as $rust
  | (map(select((.filename | test("^(apps/desktop-tauri/|crates/memry-tauri/|crates/memry-desktop/|crates/(Cargo\\.(toml|lock)|rust-toolchain\\.toml)$|crates/\\.cargo/|\\.github/(actions/|workflows/desktop-tauri-ci\\.yml$))"))
      and (.filename | test($tauri_exclude) | not)))) as $tauri
  | [($rust | most(win)), ($rust | most(mac)), ($tauri | most(win)), ($tauri | most(mac))] | join(" ")' "$patches")
read -r rust_windows rust_macos tauri_windows tauri_macos <<< "$legs"
emit false "$tauri" "$swift" "$electron" "$intel" "$macos" "$rust_windows" "$rust_macos" "$tauri_windows" "$tauri_macos"
