# M3 Phase C — Preferences + Registry (vault/preferences.rs + vault/registry.rs, TDD)

Temiz session prompt. **Bu phase TAM TDD** — `preferences.rs` (8 test) ve `registry.rs` (6 test) RED-GREEN.

---

## PROMPT START

You are implementing **Phase C of Milestone M3** for Memry's Electron→Tauri migration. This phase lands the two persistence modules: per-vault JSON config (`<vault>/.memry/config.json`) and the multi-vault registry (`<app-data>/memry-{device}/vaults.json`). Both are sync (not async) JSON IO — small files, low frequency, single-writer.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3`
**Branch:** `m3/vault-fs-and-watcher`
**Plan:** `docs/superpowers/plans/2026-04-26-m3-vault-fs-and-watcher.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Prompts README:** `prompts/m3/README.md`

Phase A landed deps + paths. Phase B landed `fs.rs` + `frontmatter.rs` + `notes_io.rs` (23 tests). Phase C now adds `preferences.rs` + `registry.rs`. Phase C also makes `frontmatter::unix_secs_to_iso` `pub(crate)` and adds a `frontmatter_iso` helper in `mod.rs` so `registry.rs` can format ISO timestamps without re-implementing the conversion.

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git rev-parse --abbrev-ref HEAD                         # expect: m3/vault-fs-and-watcher

# Phase B complete
test -f apps/desktop-tauri/src-tauri/src/vault/fs.rs
test -f apps/desktop-tauri/src-tauri/src/vault/frontmatter.rs
test -f apps/desktop-tauri/src-tauri/src/vault/notes_io.rs
test -f apps/desktop-tauri/src-tauri/tests/vault_fs_test.rs
test -f apps/desktop-tauri/src-tauri/tests/vault_frontmatter_test.rs
test -f apps/desktop-tauri/src-tauri/tests/vault_notes_io_test.rs

# Phase B tests still green
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -3
# expect: ~60 passed (28 M2 + 9 paths + 9 fs + 9 frontmatter + 5 notes_io)

# Phase B commits
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git log --oneline | grep -cE 'm3\(vault\)'
# expect ≥ 5

# Stubs still in place for the modules we'll fill
test -f apps/desktop-tauri/src-tauri/src/vault/preferences.rs
test -f apps/desktop-tauri/src-tauri/src/vault/registry.rs
```

If any fails, STOP. Phase B must complete before Phase C starts.

### Your scope

Execute **Tasks 7, 8** from the plan in this order. Each is a full RED-GREEN cycle.

- **Task 7 — `vault/preferences.rs`** (per-vault JSON config + UI prefs):
  - Write 8 failing tests in `tests/vault_preferences_test.rs`:
    - `init_creates_dot_memry_with_default_config`, `init_is_idempotent`, `read_config_returns_defaults_when_missing`, `write_config_round_trips`, `read_preferences_returns_defaults_when_missing`, `update_preferences_merges_partial`, `vault_name_falls_back_to_basename`, `count_markdown_files_excludes_patterns_and_hidden`.
  - Register `[[test]] name = "vault_preferences_test" required-features = ["test-helpers"]`.
  - Implement `preferences.rs` per plan Step 7.4: `VaultConfig` struct (excludePatterns/defaultNoteFolder/journalFolder/attachmentsFolder), `EditorPreferences` struct (width/spellCheck/autoSaveDelay/showWordCount/toolbarMode), `VaultPreferences` struct (theme/fontSize/fontFamily/accentColor/language/createInSelectedFolder/editor) — all `Default` impls + `#[serde(rename_all = "camelCase")]`. Public functions: `memry_dir`, `config_path`, `is_initialized`, `init_vault`, `read_config`, `update_config`, `read_preferences`, `update_preferences`, `vault_name`, `count_markdown_files`. Initial config blob writes the camelCase JSON shape Electron uses. Layout: `<vault>/.memry/`, `<vault>/notes/`, `<vault>/journal/`, `<vault>/attachments/{images,files}/`.

- **Task 8 — `vault/registry.rs`** (multi-vault list at OS data dir):
  - Write 6 failing tests in `tests/vault_registry_test.rs`:
    - `empty_registry_when_file_missing`, `upsert_then_persist_then_reload`, `upsert_replaces_by_path_not_duplicates`, `remove_drops_vault_and_clears_current_if_match`, `touch_updates_last_opened`, `corrupt_file_falls_back_to_empty_registry`.
  - Register `[[test]] name = "vault_registry_test" required-features = ["test-helpers"]`.
  - Implement `registry.rs` per plan Step 8.4: `VaultInfo` struct (path/name/noteCount/taskCount/lastOpened/isDefault), `VaultRegistry` struct (`vaults: Vec<VaultInfo>`, `current: Option<String>`), methods: `load(path) -> AppResult<Self>` (returns default on missing/corrupt), `save(path)`, `find`, `upsert`, `remove`, `set_current`, `touch`. Free function `registry_path()` returns `<app-data>/memry-{device}/vaults.json` reading `MEMRY_DEVICE` env (matches M2 DB path scheme).
  - Step 8.5: make `frontmatter::unix_secs_to_iso` `pub(crate)` and add `frontmatter_iso` re-export in `vault/mod.rs` so `registry.rs::current_iso()` can call `crate::vault::frontmatter_iso(secs)`.

### Methodology — TDD mandatory for both tasks

1. **Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`** first.
2. **Two full RED-GREEN cycles. One commit per task.**
3. For Task 7:
   - Step 7.1: copy plan's test verbatim (lines ~1706–1810). 8 tests.
   - Step 7.2: register `[[test]]` block.
   - Step 7.3: RED → unresolved `init_vault`, `read_config`, `update_config`, `read_preferences`, `update_preferences`, `vault_name`, `count_markdown_files`.
   - Step 7.4: implement per plan (lines ~1830–2150).
   - Step 7.5: GREEN → 8 passed.
   - Step 7.6: commit `m3(vault): preferences.rs vault config + UI prefs + count_markdown_files`.
4. For Task 8:
   - Step 8.1: copy plan's test verbatim (lines ~2160–2255). 6 tests.
   - Step 8.2: register `[[test]]` block.
   - Step 8.3: RED → unresolved imports.
   - Step 8.4: implement per plan (lines ~2275–2377).
   - Step 8.5: make `frontmatter::unix_secs_to_iso` `pub(crate)` + add `frontmatter_iso` helper in `mod.rs`. `cargo check` to confirm cross-module path works.
   - Step 8.6: GREEN → 6 passed.
   - Step 8.7: commit `m3(vault): registry.rs multi-vault list at <app-data>/memry-{device}/vaults.json`.

### Critical gotchas

1. **Sync IO, not async:** Both modules use `std::fs::*`, NOT `tokio::fs::*`. The files are tiny and writes are user-driven (open/switch/save), not high-frequency. Plan Step 7.4 + 8.4 use `std::fs` deliberately — don't "modernize" to tokio.
2. **`init_vault` is idempotent:** `fs::create_dir_all` is idempotent on existing dirs. The config write uses `if !cfg_path.exists()` to avoid clobbering user edits. Test `init_is_idempotent` calls `init_vault` twice and expects no error. The `VAULT_FOLDERS` const lists `notes`, `journal`, `attachments`, `attachments/images`, `attachments/files` — all five must exist after init.
3. **`read_config` returns defaults on missing OR corrupt:** Plan Step 7.4's `read_config_blob` returns the default JSON if the file doesn't exist. The test `corrupt_file_falls_back_to_empty_registry` verifies this for the registry; the same defensive pattern applies to config (`unwrap_or_default()` after `from_str`). NEVER error on a fresh vault — that would brick onboarding.
4. **`update_preferences_merges_partial`:** The function takes a `serde_json::Map<String, serde_json::Value>` (NOT a typed struct) and merges into the existing `preferences` object. Test passes `{"theme": "dark"}` and asserts `theme == "dark"` AND `fontSize == "medium"` (default unchanged). The merge happens at the JSON `Value::Object` level, not the typed `VaultPreferences` level — round-trip through `serde_json::to_value` and back, then merge keys, then deserialize.
5. **`count_markdown_files` excludes hidden + excludePatterns:** It walks the vault tree, counts only `*.md` and `*.markdown` files, skips dotfiles + dirs in the `excludePatterns` list. The function is sync — Phase E's `vault_open` command calls it during the open flow. Use `walkdir = "2"` if needed; check `cargo tree` first — if not present, write a manual recursive walker (10 lines).
6. **`registry.rs` path scheme matches M2:** `MEMRY_DEVICE` env var defaults to `"default"`. Path: `<projectDirs.data_dir()>/memry-{device}/vaults.json`. M2's DB lives at `<data_dir>/memry-{device}/data.db` — same parent directory. `registry_path()` MUST produce a sibling of M2's `data.db`.
7. **`registry::touch` requires unique `last_opened`:** Test `touch_updates_last_opened` sleeps 10ms then calls `touch`. The `last_opened` ISO string must change. If your `current_iso()` truncates to seconds, the 10ms sleep won't move the second-counter. Plan's `unix_secs_to_iso` formats with sub-second precision OR the helper falls back to nanos. Verify by reading the `frontmatter::unix_secs_to_iso` you wrote in Phase B — if seconds-only, bump `current_iso()` in `registry.rs` to use `as_millis()` or `as_nanos()` and format accordingly. (Plan's exact `current_iso` impl in `registry.rs` uses `as_secs()` then calls `frontmatter_iso` — the `unix_secs_to_iso` from Phase B may already include ms. If the test flakes, revisit Phase B impl.)
8. **`frontmatter::unix_secs_to_iso` visibility:** Phase B made this private. Phase C Step 8.5 elevates it to `pub(crate)`. Without this, `registry.rs::current_iso` won't compile. The `frontmatter_iso` re-export in `mod.rs` is a stable name for the rest of the crate (so `registry.rs` doesn't need to know `frontmatter` is the source).
9. **`VaultInfo` field order:** Match plan Step 8.4 exactly: `path`, `name`, `note_count: i64`, `task_count: i64`, `last_opened: String`, `is_default: bool`. Specta-generated TS preserves field order; Phase G's `bindings:check` will diff against renderer expectations.
10. **`VaultRegistry::load` is fault-tolerant:** Returns `Self::default()` (empty) on missing OR malformed JSON. The `unwrap_or_default()` after `serde_json::from_str` handles the corrupt case. Test `corrupt_file_falls_back_to_empty_registry` writes `"{not valid json}"` and expects `Ok(empty)` — never propagate the parse error.
11. **`registry::save` creates parent dir:** First call after a fresh device install: `<data_dir>/memry-{device}/` doesn't exist yet. `save` MUST `fs::create_dir_all(parent)` before writing. Plan Step 8.4 handles this; do not skip.
12. **`Cargo.toml` `[[test]]` ordering:** Append after Phase B's blocks. Order matters for predictable parallel test runs but is mostly cosmetic.

### Constraints

- **No scope creep:** Do not implement `state.rs`, `watcher.rs`, or any command in Phase C. Stubs untouched. Phase D handles state + watcher.
- **No new crates:** `walkdir` is the only candidate addition (for `count_markdown_files`). If you can avoid it with a manual `read_dir` recursion, do so. The plan's exact impl uses manual recursion to keep deps tight.
- **No Phase D wiring:** Do not touch `app_state.rs` or `lib.rs::run` to wire `VaultRuntime` — that is Phase D's job. The `mod.rs` re-exports are still commented at end of Phase C; Phase D enables them.
- **No `unwrap()` in production paths:** All `init_vault`, `read_config`, `update_config`, `update_preferences`, `VaultRegistry::load`, `VaultRegistry::save`, `registry_path` return `AppResult`. Test code may use `unwrap()` freely.
- **Rust style:** `cargo clippy -- -D warnings` clean at each task boundary. Format with `cargo fmt`.

### Acceptance criteria (Phase C done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3

# Files implemented
test -f apps/desktop-tauri/src-tauri/src/vault/preferences.rs
test -f apps/desktop-tauri/src-tauri/src/vault/registry.rs
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/vault/preferences.rs)" -gt 100 ]
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/vault/registry.rs)" -gt 80 ]

# `frontmatter::unix_secs_to_iso` elevated to pub(crate)
grep -q 'pub(crate) fn unix_secs_to_iso' apps/desktop-tauri/src-tauri/src/vault/frontmatter.rs

# `frontmatter_iso` helper in mod.rs
grep -q 'frontmatter_iso' apps/desktop-tauri/src-tauri/src/vault/mod.rs

# Tests registered
grep -q 'name = "vault_preferences_test"' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q 'name = "vault_registry_test"' apps/desktop-tauri/src-tauri/Cargo.toml

# Each test file passes
cd apps/desktop-tauri/src-tauri
cargo test --features test-helpers --test vault_preferences_test 2>&1 | tail -3   # 8 passed
cargo test --features test-helpers --test vault_registry_test 2>&1 | tail -3      # 6 passed

# Full carry-over
cargo test --features test-helpers 2>&1 | tail -3
# expect: ~74 passed (28 M2 + 9 paths + 9 fs + 9 frontmatter + 5 notes_io + 8 prefs + 6 registry)

# Rust hygiene
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy

# Commits
git log --oneline | grep -cE 'm3\(vault\)'   # expect ≥ 7

# Electron / packages / specs / plans untouched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ docs/superpowers/specs/ docs/superpowers/plans/ | wc -l
# expect 0
```

### When done

Report to user:

```
Phase C complete.
Tasks covered: 7, 8
Commits: 2 (<first_hash>..<last_hash>)
Rust tests: 14 new (8 prefs + 6 registry) + 32 prior = ~74 passed
Verification:
  - cargo check: clean
  - cargo clippy -- -D warnings: clean
  - cargo test --features test-helpers: ~74 passed, 0 failed
  - frontmatter::unix_secs_to_iso elevated to pub(crate)
  - mod.rs frontmatter_iso re-export added
  - Electron/packages/specs/plans untouched: 0 files

Next: Phase D — prompts/m3/m3-phase-d-watcher-runtime-state.md
Blockers: <none | list>
```

If blocker:
- `update_preferences_merges_partial` fails → check the merge happens at `Value::Object` level (`Map<String, Value>`) not at `VaultPreferences` typed level. Pure JSON merge then deserialize.
- `touch_updates_last_opened` fails (`assert_ne!(before, after)`) → `current_iso()` returns same value across 10ms sleep. Bump precision to ms in `frontmatter::unix_secs_to_iso` or use `as_nanos()` in `registry::current_iso` directly.
- `corrupt_file_falls_back_to_empty_registry` fails → `unwrap_or_default()` after `serde_json::from_str` was replaced with `?`. Restore the swallow pattern; corrupt files MUST not panic the registry.
- `count_markdown_files` over-counts → didn't apply `excludePatterns` to dirs OR didn't skip dotfiles. Test the walker independently with `dbg!`.

If still blocked: invoke `superpowers:systematic-debugging`. Report + wait for approval.

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 7, 8 fully (lines ~1697–2422 of the plan file).
3. Run prerequisite verification. Report results.
4. Task 7 RED-GREEN: failing prefs_test → impl preferences.rs → 8 passed → commit `m3(vault): preferences.rs vault config + UI prefs + count_markdown_files`.
5. Task 8 RED-GREEN: failing registry_test → impl registry.rs + elevate `unix_secs_to_iso` + add `frontmatter_iso` helper → 6 passed → commit `m3(vault): registry.rs multi-vault list at <app-data>/memry-{device}/vaults.json`.

## PROMPT END
