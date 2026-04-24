# M2 Phase A — DB Foundation (Rust scaffold + migration runner, TDD)

Temiz session prompt. **Bu phase TDD gerektirir** — migration runner baştan sona RED-GREEN.

---

## PROMPT START

You are implementing **Phase A of Milestone M2** for Memry's Electron→Tauri migration. This phase lands the DB foundation: rusqlite deps, `AppState`/`Db`/`AppError` types, and a tested migration runner. No real migrations yet — placeholder SQL files only; Phase B ports them.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2`
**Branch:** `m2/db-schemas-migrations` (must already exist — see README worktree setup)
**Parent spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` (M2 section §4, cross-cutting §5)
**Implementation plan:** `docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md`
**Prompts README:** `prompts/m2/README.md`

Memry: desktop notes app, Electron→Tauri migration, pre-production, no backward compat. M1 landed a Tauri skeleton with 19 mock IPC domains; M2 puts real SQLite state behind Rust commands. This phase wires the plumbing.

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
git rev-parse --abbrev-ref HEAD           # expect: m2/db-schemas-migrations
git log --oneline main | head -3           # expect M1 commits (scaffold + renderer port)
test -d apps/desktop-tauri/src-tauri/src
test -f apps/desktop-tauri/src-tauri/Cargo.toml
pnpm --filter @memry/desktop-tauri cargo:check   # must exit 0 on current state
```

If any fails, STOP and report. Do not improvise the worktree or branch.

### Your scope

Execute **Tasks 1, 2, 3** from the plan:

- **Task 1:** Ensure `rusqlite`, `thiserror`, and `directories` are available in `src-tauri/Cargo.toml` + add `tempfile` as dev-dep. Amend existing `rusqlite` features only if needed. Do **not** add `r2d2`, `r2d2_sqlite`, `once_cell`, or any pool crate.
- **Task 2:** Create `src/error.rs` (`AppError` enum), `src/app_state.rs` (`AppState` struct), `src/db/mod.rs` (`Db` wrapper around `Arc<Mutex<rusqlite::Connection>>` with `open` + `open_memory` + `with_conn`/guard access). Wire `AppState` into `src/lib.rs` with `MEMRY_DEVICE`-aware `resolve_db_path`.
- **Task 3:** Create `src/db/migrations.rs` with `bootstrap` + `apply_pending` + static `EMBEDDED` manifest (29 entries, source-numbered `0000_*` through `0028_*`). Migration `.sql` files are placeholders (one-line comment) at this phase. Write `tests/migrations_test.rs` with 3 tests **RED-first**, then implement until all pass.

### Methodology — TDD mandatory for Task 3

1. **Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`** first.
2. **Task 1 (deps):** Not TDD — `cargo check` is the verification. Commit after deps resolve.
3. **Task 2 (types):** Not TDD in the RED-GREEN sense, but verify with `cargo check && cargo clippy -- -D warnings` after each file. Any warning = fix before commit.
4. **Task 3 (migration runner):**
   - Create 29 placeholder `.sql` files first (Task 3.5's loop) — these must exist so `include_str!` macro in `migrations.rs` doesn't fail to compile.
   - RED: Write `tests/migrations_test.rs` with the three tests from plan Step 3.2 (`bootstraps_schema_migrations_table`, `bootstrap_is_idempotent`, `applies_embedded_migrations_in_order_and_records_them`).
   - Verify the existing `[lib]` section remains intact. M1 already names the library crate `memry_desktop_tauri_lib`; integration tests import `memry_desktop_tauri_lib::db::migrations`.
   - Add `[features] test-helpers = []` + `[[test]] name = "migrations_test" required-features = ["test-helpers"]`.
   - Run `cargo test --test migrations_test --features test-helpers` → **must FAIL** with "unresolved import" (module doesn't exist yet).
   - GREEN: Implement `src/db/migrations.rs` per plan Step 3.4. Export `pub mod migrations;` from `src/db/mod.rs`.
   - Re-run test → **must PASS** (all 3).
   - Commit per Task 3.7.

### Critical gotchas

1. **Library crate name:** M1's `[lib] name` is `memry_desktop_tauri_lib`. Integration tests import `memry_desktop_tauri_lib::...`, not the package-name-derived `memry_desktop_tauri`.
2. **`Db::open_memory` feature gate:** The method exists behind `#[cfg(any(test, feature = "test-helpers"))]` so integration tests (a separate crate from `lib`) need the feature flag at `cargo test` time. Plan Step 8.5 details this; surface it here too in the `[features]` and `[[test]]` table.
3. **`directories` crate on macOS:** `ProjectDirs::from("com", "memry", "memry")` resolves to `~/Library/Application Support/com.memry.memry/`. Verify during Task 2's compile-time sanity.
4. **Single SQLite connection:** Use `Arc<Mutex<rusqlite::Connection>>` for M2. Keep lock scopes short. Do not introduce `r2d2`, `r2d2_sqlite`, `deadpool`, or any pool abstraction.
5. **WAL + `PRAGMA foreign_keys = ON`:** Applied in `with_init` closure. Verify after Phase A with `sqlite3 <db> 'PRAGMA journal_mode; PRAGMA foreign_keys;'` (though that waits for Phase B migrations to create a non-empty DB).
6. **Panic-free command paths:** `Db::open` uses `?` and returns `AppResult<Self>`. The only `expect()` in `lib.rs` is in `run()` at app-init fatal-bug path, which is the spec's permitted exception.

### Constraints

- **No scope creep:** Do not create CRUD helpers for any table in Phase A. Do not port migration SQL in Phase A. Do not define domain structs in Phase A.
- **No additional crates:** Only the required DB/error/path deps + `tempfile` dev-dep. No `r2d2`, `r2d2_sqlite`, `deadpool`, `tracing`, `anyhow` (outside tests), `uuid` — spec defers these to later milestones that actually need them.
- **`AppError` match spec §5.2 exactly:** 9 variants `Database/Crypto/VaultLocked/InvalidPassword/NotFound/Network/Conflict/Validation/Internal`. No adding variants in Phase A.
- **Rust style:** `rustfmt` before commit. `cargo clippy -- -D warnings` must be clean at Task 1, 2, 3 boundaries.

### Acceptance criteria (Phase A done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Files exist
test -f apps/desktop-tauri/src-tauri/src/error.rs
test -f apps/desktop-tauri/src-tauri/src/app_state.rs
test -f apps/desktop-tauri/src-tauri/src/db/mod.rs
test -f apps/desktop-tauri/src-tauri/src/db/migrations.rs
test -f apps/desktop-tauri/src-tauri/tests/migrations_test.rs
test -d apps/desktop-tauri/src-tauri/migrations
test $(ls apps/desktop-tauri/src-tauri/migrations/*.sql | wc -l) -eq 29
! ls apps/desktop-tauri/src-tauri/migrations/0029_*.sql 2>/dev/null
! grep -qE '^(r2d2|r2d2_sqlite|deadpool)' apps/desktop-tauri/src-tauri/Cargo.toml

# Rust compiles + clippy clean
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy

# Tests pass
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test --features test-helpers 2>&1 | tail -5
# Expect: test result: ok. 3 passed

# Feature gate works
cd apps/desktop-tauri/src-tauri && cargo check --features test-helpers

# Commits
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
git log --oneline | grep -cE "m2\((deps|db|migrations)\)"   # expect ≥ 3

# No Electron or packages touched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ | wc -l
# expect 0
```

### When done

Report to user:

```
Phase A complete.
Tasks covered: 1, 2, 3
Commits: <N> (<first_hash>..<last_hash>)
Rust tests: 3 passed (migrations_test)
Migration files: 29 placeholders created
Verification:
  - cargo check: clean
  - cargo clippy -- -D warnings: clean
  - cargo test --features test-helpers: 3 passed
  - Electron/packages untouched: 0 files

Next: Phase B — prompts/m2/m2-phase-b-migration-port.md
Blockers: <none | list>
```

If blocker: do not guess. Invoke `superpowers:systematic-debugging`. Check spec §6.4 trip-wires. Report + wait for approval.

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 1, 2, 3 fully.
3. Run prerequisite verification. Report results.
4. Start Task 1 (add deps → `cargo check` → commit).
5. Continue with Task 2.
6. Task 3 = full RED-GREEN: placeholders → failing test → implementation → passing test → commit.

## PROMPT END
