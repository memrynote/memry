# M2 Phase F — Settings IPC Slice (TDD, first real end-to-end command)

Temiz session prompt. **Bu phase yoğun TDD gerektirir.** Plus specta bindings + renderer hook swap. İlk gerçek Rust→TS IPC round-trip.

---

## PROMPT START

You are implementing **Phase F of Milestone M2** for Memry's Electron→Tauri migration. This is the **first real IPC slice**: `settings_get` / `settings_set` / `settings_list` commands backed by SQLite, with specta-generated TypeScript bindings, and the renderer's `useSettings` hook swapped from M1 mock to real Tauri invoke.

Every other feature domain stays on M1 mocks in Phase F. Settings is the only
feature-domain slice that crosses the real Rust IPC boundary here. Phase G may
add shell-neutral native wrappers and updater mock-name alignment required by
the updated migration spec, but it must not add new feature-domain logic.

M1 left some renderer settings code importing `@memry/*` package contracts/defaults. M2 must rehome or explicitly account for the settings-domain imports touched by this slice so the Tauri app continues moving toward package independence.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2`
**Branch:** `m2/db-schemas-migrations`
**Plan:** `docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` (§4 M2, §5.1 IPC conventions, §5.2 error handling, §5.4 type generation)
**Prompts README:** `prompts/m2/README.md`

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Phase E complete — all 20 structs present
grep -c '^pub mod' apps/desktop-tauri/src-tauri/src/db/mod.rs
# Expect >= 21

# Bindings generator skeleton (from M1 Phase I)
test -f apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs

# Mock invoke wrapper (from M1 Phase D)
test -f apps/desktop-tauri/src/lib/ipc/invoke.ts
grep -q 'realCommands' apps/desktop-tauri/src/lib/ipc/invoke.ts
# Expect realCommands set defined (initially empty)

# Settings mock (from M1 Phase D) — stays in place, M2 doesn't touch it
test -f apps/desktop-tauri/src/lib/ipc/mocks/settings.ts

# useSettings hook exists (from M1 port)
test -f apps/desktop-tauri/src/hooks/useSettings.ts

# Tests green so far
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -5
# Expect all passing
```

If any fails, STOP.

### Your scope

Execute **Tasks 13, 14, 15** from the plan:

- **Task 13 (TDD):** `db/settings.rs` (`Setting` struct + `get/set/list` helpers) + `db/saved_filters.rs` (`SavedFilter` struct) + `commands/settings.rs` (3 Tauri commands) + register in `lib.rs` + Rust integration tests (`tests/settings_test.rs` with 4 tests).
- **Task 14:** Update `src/bin/generate_bindings.rs` to include all 22 domain types + 3 settings commands. Run `pnpm bindings:generate`, verify `src/generated/bindings.ts` contains ≥ 22 exports + 3 commands. Commit.
- **Task 15:** Modify `src/lib/ipc/invoke.ts` to add `settings_get/set/list` to `realCommands`. Modify `src/hooks/useSettings.ts` to use Tanstack Query with the typed invoke. Rehome any settings-domain `@memry/*` contracts/defaults touched by this slice into `apps/desktop-tauri/src/` or document the remaining import in the carry-forward ledger. Add Vitest `tests/useSettings.test.tsx` with roundtrip mock. Manual dev smoke. Commit.

### Methodology — TDD mandatory for Task 13 + Task 15

1. **Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`** first.

2. **Task 13 — Rust TDD:**
   - Write `tests/settings_test.rs` FIRST with 4 tests from plan Step 13.3:
     - `get_missing_key_returns_none`
     - `set_then_get_roundtrip`
     - `set_upserts_existing_key`
     - `list_returns_sorted_entries`
   - Gate test binary on `test-helpers` feature via `[[test]]` table.
   - `cargo test --test settings_test --features test-helpers` → **must FAIL** (compile error, `db::settings` doesn't exist).
   - GREEN: write `db/settings.rs` with `Setting` struct + `get`/`set`/`list` functions per plan Step 13.1. Write `db/saved_filters.rs` per plan Step 13.2. Export both from `db/mod.rs`.
   - Re-run test → **must PASS** (4 tests).
   - Now wire commands: create `commands/settings.rs` per plan Step 13.5 with `settings_get` / `settings_set` / `settings_list` Tauri commands. Create `commands/mod.rs` (or update existing M1 skeleton). Register commands in `lib.rs`'s `invoke_handler!` per plan Step 13.6.
   - `cargo check && cargo clippy -- -D warnings` → clean.
   - `cargo test --features test-helpers` → all still pass.
   - Commit: `m2(settings): settings_get/set/list commands + 4 Rust tests`.

3. **Task 14 — Specta regeneration:**
   - Overwrite `src/bin/generate_bindings.rs` per plan Step 14.1. Reference all 22 types from `db/` modules (must match canonical names from Phases C-E).
   - Run `pnpm --filter @memry/desktop-tauri bindings:generate`.
   - Inspect `src/generated/bindings.ts`: ≥ 22 `export type` lines, 3 `export const` commands, no field names in snake_case (verify `rename_all = "camelCase"` was honored).
   - Run `pnpm --filter @memry/desktop-tauri typecheck` → clean.
   - Run `pnpm --filter @memry/desktop-tauri bindings:check` → exits 0 (no drift).
   - Commit: `m2(bindings): regenerate with 22 domain types + settings commands`.

4. **Task 15 — Renderer TDD:**
   - Edit `src/lib/ipc/invoke.ts`: add `'settings_get'`, `'settings_set'`, `'settings_list'` to `realCommands` Set. Keep dynamic import `@tauri-apps/api/core`.
   - Before swapping the hook, inspect touched settings files for imports from `@memry/contracts/settings-schemas`, `@memry/contracts/settings-sync`, and `@memry/rpc/settings`. Rehome only the settings types/defaults required by the real `settings_*` path; do not broaden this into an all-packages cleanup.
   - RED: Write `tests/useSettings.test.tsx` per plan Step 15.3 — mocks `@tauri-apps/api/core` with in-memory store, exercises `useSetSetting` + `useSetting` via renderHook. Run `pnpm test` → **must FAIL** if `useSettings.ts` isn't Tanstack-Query-based yet.
   - GREEN: Replace `src/hooks/useSettings.ts` body per plan Step 15.2 — `useSetting(key)` returns `useQuery`, `useSettings()` returns list, `useSetSetting()` returns mutation with invalidation.
   - Re-run `pnpm test` → **must PASS**.
   - `pnpm typecheck` → clean.
   - **Manual dev smoke** per plan Step 15.5: `pnpm --filter @memry/desktop-tauri dev` → open settings page → toggle a setting → `sqlite3 <db> "SELECT * FROM settings"` → row present. Report before committing.
   - Commit: `m2(renderer): swap settings_* mock for real invoke; useSettings hook wired`.

### Critical gotchas

1. **`tauri::command` + `#[specta::specta]` order:** Per spec §5.1, both attributes are required. Order doesn't matter to the compiler but by convention `#[tauri::command]` above `#[specta::specta]`.
2. **`tauri::State<'_, AppState>`:** Commands take `state: tauri::State<'_, AppState>` as the first arg. `AppState` was registered via `.manage(app_state)` in Phase A's `lib.rs` changes. Verify `lib.rs` still has that.
3. **`Result<T, AppError>` serialization:** `AppError` derives `serde::Serialize` and `specta::Type`, so it flows through to the renderer. The `#[serde(tag = "kind", content = "message")]` layout from Phase A means the TS type will be a discriminated union. If specta generates something else, check the derive is intact.
4. **`settings_list` no-args invoke:** Command signature `pub async fn settings_list(state: tauri::State<'_, AppState>) -> AppResult<Vec<Setting>>` takes no input struct. Renderer calls `invoke('settings_list', undefined)`. The typed wrapper handles `undefined` input — test it works.
5. **Specta `collect_commands!` order:** If you reorder command names in the macro, `bindings.ts` changes. For stable PR diffs, alphabetize within the macro.
6. **`bindings.ts` re-generation failure modes:**
   - Rust compile error in generator bin → fix Rust first.
   - Missing derive on a struct → add `specta::Type` to that struct.
   - Tauri version mismatch (tauri-specta pinned vs tauri) → cargo lock has the truth; specta 2.x + tauri-specta 2.x + tauri 2.x is the right trio.
7. **`realCommands` in TS:** The Set is of type `Set<string>`. Adding settings commands keeps the Set narrow but typechecker still needs the commands to exist in `Commands` type from `bindings.ts`. Run bindings:generate (Task 14) BEFORE Task 15 — otherwise `Commands[K]` lookups fail.
8. **Turkish character UTF-8 integrity:** One of your 4 settings tests should set/get a value like `'çalışma modu'` — confirms SQLite TEXT + rusqlite + JSON.stringify roundtrip preserves multi-byte characters. Not required in plan but a cheap defense-in-depth.
9. **Manual dev smoke path:** DB lives at `~/Library/Application Support/com.memry.memry/memry-default/data.db`. If `MEMRY_DEVICE` was set during dev, swap `memry-default` for `memry-<device>`.
10. **Existing settings mock:** `src/lib/ipc/mocks/settings.ts` STAYS in place. The `invoke.ts` router falls back to the mock if the command isn't in `realCommands`. After Task 15, only `settings_get/set/list` hit real Tauri; every other `settings_*` mock route (if any) still serves the mock. Do not delete the mock file.
11. **Settings-domain package extraction:** Do not leave newly touched settings files depending on `@memry/contracts` or `@memry/rpc`. If a settings page still needs package code outside this slice, record it in the M2 carry-forward ledger with the exact file and reason.

### Constraints

- **No new feature-domain commands beyond the 3 settings ones.** Saved filters
  and all other feature domains stay on mocks until their respective later
  milestones. The spec-review addenda for shell-neutral native wrappers and
  updater mock alignment belong to Phase G, not Phase F.
- **No domain logic in `commands/settings.rs`.** Commands are thin: parse input → call `db::settings::func` → return. Validation (if any) happens in input struct's domain via future `validate()` methods; M2 has no validation needs for settings (free-form KV).
- **No event emission in M2.** `sync-progress`, `vault-changed`, etc. are M6/M3. Settings commands do not emit events.
- **Commit granularity:** Task 13 = 1 commit, Task 14 = 1 commit, Task 15 = 1 commit. Total: 3 commits in Phase F.

### Acceptance criteria (Phase F done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Files exist
test -f apps/desktop-tauri/src-tauri/src/db/settings.rs
test -f apps/desktop-tauri/src-tauri/src/db/saved_filters.rs
test -f apps/desktop-tauri/src-tauri/src/commands/settings.rs
test -f apps/desktop-tauri/src-tauri/tests/settings_test.rs

# Settings commands registered
grep -q 'settings::settings_get' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'settings::settings_set' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'settings::settings_list' apps/desktop-tauri/src-tauri/src/lib.rs

# Bindings contain settings + domain types
grep -c '^export' apps/desktop-tauri/src/generated/bindings.ts
# Expect >= 22

grep -E 'settings_(get|set|list)' apps/desktop-tauri/src/generated/bindings.ts | wc -l
# Expect >= 3

# No snake_case field leakage (specta rename_all should enforce camelCase)
grep -E 'created_at|modified_at|project_id' apps/desktop-tauri/src/generated/bindings.ts && echo "FAIL: snake_case leaked"

# realCommands updated
grep -A5 "realCommands = new Set" apps/desktop-tauri/src/lib/ipc/invoke.ts | grep -E "settings_(get|set|list)"
# Expect 3 matches

# Touched settings path no longer depends on package settings contracts
! rg -n '@memry/(contracts|rpc).*settings|@memry/contracts/(settings-schemas|settings-sync)' \
  apps/desktop-tauri/src/hooks/useSettings.ts \
  apps/desktop-tauri/src/lib/ipc \
  apps/desktop-tauri/src/pages/settings 2>/dev/null

# Rust tests pass
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -5
# Expect passed count += 4 from settings_test + same prior

# TS tests pass
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
pnpm --filter @memry/desktop-tauri test

# Typecheck + lint clean
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri lint

# Bindings check clean (no drift)
pnpm --filter @memry/desktop-tauri bindings:check

# Manual smoke: settings row in DB after dev session (requires user confirmation)
# User will run: pnpm --filter @memry/desktop-tauri dev, toggle a setting, then
# sqlite3 ~/Library/Application\ Support/com.memry.memry/memry-default/data.db "SELECT * FROM settings;"

# Commits
git log --oneline | grep -cE "m2\((settings|bindings|renderer)\)"
# expect ≥ 3
```

### When done

Report:

```
Phase F complete.
Tasks covered: 13, 14, 15
Commits: <N> (<first_hash>..<last_hash>)
Rust tests: <total passed> (settings_test: 4 new)
TS tests: <total passed> (useSettings.test.tsx: 1+)
Bindings: <count> exports, 3 settings commands
Settings package residue: <0 in touched paths | remaining files documented>
Manual smoke: <PENDING / CONFIRMED-row-present>

Settings is the first feature-domain command crossing the real IPC boundary.
All other feature domains (notes, tasks, calendar, etc.) still serve from M1
mocks. Phase G handles command-parity tooling, updater mock-name alignment, and
minimal shell-neutral wrappers; later milestones swap each domain as its Rust
implementation lands.

Next: Phase G — prompts/m2/m2-phase-g-tooling-acceptance.md
Blockers: <none | list>
```

If manual smoke failed (renderer settings toggle doesn't persist to DB), do not
proceed to Phase G. Investigate:
1. Is `invoke.ts` actually hitting Tauri? Temporarily route a scoped debug line through the local logger in the `if
   (realCommands.has(cmd))` branch, then remove it after diagnosis.
2. Is the command registered? `grep 'settings_get' apps/desktop-tauri/src-tauri/src/lib.rs`.
3. Is the DB path correct? Check Tauri's log output for `resolve_db_path`.
4. Is the settings table created? `sqlite3 <db> ".tables"`.
Report findings + fix plan, wait for approval.

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 13, 14, 15 fully.
3. Run prerequisite verification.
4. Task 13: RED `tests/settings_test.rs` → GREEN `db/settings.rs` + `db/saved_filters.rs` → Tauri commands → register → commit.
5. Task 14: update `generate_bindings.rs` → run bindings:generate → verify → commit.
6. Task 15: edit `invoke.ts` realCommands → RED `useSettings.test.tsx` → GREEN `useSettings.ts` → manual dev smoke → commit.

## PROMPT END
