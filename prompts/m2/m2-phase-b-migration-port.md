# M2 Phase B — Migration Port (29 SQL files, mechanical + smoke tests)

Temiz session prompt. Bu phase ağırlıklı mekanik SQL porting — Electron'un Drizzle-generated + hand-written migration'larını Tauri'ye taşıyor. Her port sonrası migration runner'ı çalıştır.

---

## PROMPT START

You are implementing **Phase B of Milestone M2** for Memry's Electron→Tauri migration. Phase A landed the migration runner with 29 placeholder `.sql` files. Phase B replaces those placeholders with real ported SQL from Electron's data DB, plus a full-apply integration test.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2`
**Branch:** `m2/db-schemas-migrations`
**Plan:** `docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Prompts README:** `prompts/m2/README.md`

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Phase A complete
test -f apps/desktop-tauri/src-tauri/src/db/migrations.rs
test -f apps/desktop-tauri/src-tauri/tests/migrations_test.rs
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test --features test-helpers 2>&1 | tail -5
# Expect: 3 passed

# Electron source migrations available (read-only reference)
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
ls apps/desktop/src/main/database/drizzle-data/*.sql | wc -l
# Expect: 29

# Tauri migration dir has 29 placeholder files
ls apps/desktop-tauri/src-tauri/migrations/*.sql | wc -l
# Expect: 29
```

If any fails, STOP.

### Your scope

Execute **Tasks 4, 5, 6, 7** from the plan:

- **Task 4:** Port Electron `drizzle-data/0000_thankful_luke_cage.sql` → Tauri `0000_thankful_luke_cage.sql` (or the existing source-numbered `0000_*` placeholder). Add `migration_0000_creates_core_tables` test.
- **Task 5:** Port Drizzle-output migrations — Electron `0001_*` through `0019_*` → Tauri source-numbered `0001_*` through `0019_*`. Read each Electron file, strip `--> statement-breakpoint` markers, normalize boolean literals, commit in batches of 4-5.
- **Task 6:** Port later migrations — Electron `0020_*` through `0028_*` → Tauri source-numbered `0020_*` through `0028_*` (verbatim with header comment where hand-written). Do not author a net-new `0029`; field clocks must come from the ported Electron migrations.
- **Task 7:** Add `full_migration_produces_expected_table_set` and `tasks_and_projects_have_field_clocks_column` integration tests to `tests/migrations_test.rs`.

### Methodology — verification-before-completion (not TDD)

This phase is porting, not feature development. Discipline:

1. **Invoke `superpowers:using-superpowers` and `superpowers:verification-before-completion`** first.
2. **Per-migration workflow:**
   - `cat apps/desktop/src/main/database/drizzle-data/<electron-file>.sql` — read source.
   - Read the corresponding `packages/db-schema/src/schema/*.ts` if it exists — column semantics clarified.
   - Overwrite the Tauri placeholder file:
     - Header comment: `-- Port of <electron path>`
     - Strip `--> statement-breakpoint` lines (replace with blank line).
     - Normalize `DEFAULT false` → `DEFAULT 0`, `DEFAULT true` → `DEFAULT 1`.
     - Remove backticks around identifiers; use bare identifiers.
   - Run `cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test --features test-helpers` → must stay PASS after every port.
   - If FAIL: diagnose (dependency order? missing column? typo? invalid ALTER on nonexistent table?). Fix before next migration.
3. **Filename decisions in Task 5:**
   - The plan's old Tauri filename guesses that shifted Electron `0000` to Tauri `0001` are stale. **Preserve the Electron source number.** You may normalize the stem if Phase A placeholders already used clearer names, but `0007_*` stays `0007_*`, `0018_*` stays `0018_*`, etc.
   - Update `migration_manifest::MIGRATIONS` array to match the actual filenames. Array length must stay exactly 29 for the whole phase.
4. **No 0029 shim:**
   - After porting Electron `0000`-`0028`, run `tasks_and_projects_have_field_clocks_column`.
   - If it fails, first re-cat Electron `0017_spotty_mongu.sql` and `0018_greedy_stepford_cuckoos.sql` and inspect the ported files. Fix the port, do not add a synthetic `0029`.
   - A net-new `0029` is allowed only if a schema diff proves Electron's final data schema has columns absent from all 29 source migrations and the user approves the extra migration.

### Critical gotchas

1. **Dependency ordering:** If a migration does `ALTER TABLE X ADD COLUMN ...` and `X` doesn't exist yet, migration fails. Drizzle's historical numbering may not match Tauri's. If Electron 0012 adds a column to a table created in Electron 0014 (unlikely but possible given Drizzle's reshuffling), reorder your Tauri migrations to create-then-alter. Update `EMBEDDED` array indices accordingly.
2. **`ON UPDATE NO ACTION`:** Drizzle emits this; it's SQLite-valid but redundant. Keep as-is — don't silently reformat.
3. **`datetime('now')` vs `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`:** Electron uses both in different migrations. Port as-written; do not normalize.
4. **Foreign key enforcement:** `PRAGMA foreign_keys = ON` is on in `Db::open_memory` from Phase A. Any migration that creates a FK referencing a nonexistent table will fail immediately. Good — exposes ordering bugs fast.
5. **Drizzle `DROP TABLE IF EXISTS` in rollback-style migrations:** Some Drizzle files have pre-drop statements for dev mode. Keep them — they're harmless in a fresh DB, useful if migration gets re-run under `db:reset`.
6. **0017/0018 field_clocks source:** Kaan's memory notes that field_clocks was added to tasks+projects around Drizzle 0017/0018. **Cat both files and confirm.** The correct fix is a faithful port of those source migrations, not a Tauri-only shim.
7. **Required table set in Task 7:** Plan lists the expected table names. If your table set diverges, **do not soften the assertion** — investigate whether you misnamed a file, skipped a migration, or the ported SQL creates differently-named tables. The test is truth.

### Constraints

- **Do not alter migration semantics.** Ports preserve behavior exactly. Renaming a table, changing a default, dropping a column "because it's unused" — all forbidden. If you see something that looks wrong, flag to user, don't fix silently.
- **Do not merge migrations.** Keep one Tauri file per Electron file. One consolidated migration is a future refactor, not M2 scope.
- **Commit granularity:** Task 4 = one commit. Task 5 = four batches of ~4-5 migrations each = 4 commits. Task 6 = one commit for later/hand-written source migrations and field-clock verification. Task 7 = one commit for tests. Total: ~7 commits in Phase B.
- **No new features.** No schema additions beyond what's in Electron's 29 data migrations unless a required schema diff proves a missing final-schema column and the user approves the extra migration.

### Acceptance criteria (Phase B done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Migration files present and non-placeholder
for f in apps/desktop-tauri/src-tauri/migrations/*.sql; do
  wc -l "$f"
done | sort | head
# Expect every file >= 2 lines; no single-comment placeholders remain

# Migration manifest matches file count
RUST_MANIFEST_COUNT=$(grep -c 'include_str!' apps/desktop-tauri/src-tauri/src/db/migrations.rs)
SQL_FILE_COUNT=$(ls apps/desktop-tauri/src-tauri/migrations/*.sql | wc -l | tr -d ' ')
test "$RUST_MANIFEST_COUNT" -eq "$SQL_FILE_COUNT"

# Full migration applies clean
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test --features test-helpers 2>&1 | tail -10
# Expect all tests pass, including full_migration_produces_expected_table_set and tasks_and_projects_have_field_clocks_column

# Clippy clean
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
pnpm --filter @memry/desktop-tauri cargo:clippy

# Commits
git log --oneline | grep -c "m2(migrations)"   # expect ≥ 6

# Electron untouched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ | wc -l
# expect 0
```

### When done

Report:

```
Phase B complete.
Tasks covered: 4, 5, 6, 7
Commits: <N> (<first_hash>..<last_hash>)
Migration files ported: 29
Field_clocks source: <Electron 0017/0018 or exact ported source file>
Rust tests: <passed count> (migrations_test)
Required tables verified: <count> (from full_migration_produces_expected_table_set)

Next: Phase C — prompts/m2/m2-phase-c-core-domain-structs.md
Blockers: <none | list>
```

If a migration port fails and you can't resolve it:
1. Cat the Electron source again, look for SQL SQLite rejects (generated columns? WITHOUT ROWID? CHECK constraints with parentheses errors?).
2. Invoke `superpowers:systematic-debugging`.
3. Report with the exact rusqlite error + offending SQL snippet + proposed fix. Wait for approval.

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:verification-before-completion`.
2. Read plan Tasks 4, 5, 6, 7 fully. Treat any shifted-number or `0029` guidance as stale unless a schema diff proves otherwise.
3. Run prerequisite verification.
4. Start Task 4 (port Electron 0000 → Tauri 0000, verify, commit).
5. Work Task 5 migrations in 4 batches with per-batch commits.
6. Task 6: port later migrations, verify field_clocks came from source migrations, commit.
7. Task 7: add integration tests, commit.

## PROMPT END
