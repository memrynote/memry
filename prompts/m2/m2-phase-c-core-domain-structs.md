# M2 Phase C — Core Domain Structs (projects, statuses, tasks, notes metadata)

Temiz session prompt. Her struct için smoke roundtrip test zorunlu. Kod mekanik ama canonical isimler Phase F generator'ı tarafından beklenir — birebir uy.

---

## PROMPT START

You are implementing **Phase C of Milestone M2** for Memry's Electron→Tauri migration. Phase B landed all 29 migrations with integration tests. Phase C defines the first batch of Rust domain structs: `Project`, `Status`, `Task`, `PropertyDefinition`, `NoteMetadata`, `NotePosition`. Each struct has `specta::Type` derive + `from_row` helper + a roundtrip smoke test.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2`
**Branch:** `m2/db-schemas-migrations`
**Plan:** `docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Prompts README:** `prompts/m2/README.md`

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Phase B complete — migrations ported + tests pass
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test --features test-helpers 2>&1 | tail -5
# Expect: all tests pass, including full_migration_produces_expected_table_set

# Files that Phase C will modify exist
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
test -f apps/desktop-tauri/src-tauri/src/db/mod.rs
test -f apps/desktop-tauri/src-tauri/src/db/migrations.rs
```

If any fails, STOP.

### Your scope

Execute **Tasks 8, 9** from the plan:

- **Task 8:** `db/projects.rs` (`Project`), `db/statuses.rs` (`Status`), `db/tasks.rs` (`Task`). Export from `db/mod.rs`. Add `projects_and_tasks_roundtrip` smoke test.
- **Task 9:** `db/notes_cache.rs` (`PropertyDefinition`), `db/note_metadata.rs` (`NoteMetadata`), `db/note_positions.rs` (`NotePosition`). Export from `db/mod.rs`. One roundtrip smoke test per table.

### Canonical struct names (Phase F generator depends on these)

| Module | Struct | Source migration |
|--------|--------|------------------|
| `db/projects.rs` | `Project` | `0000_thankful_luke_cage.sql`, `0015_brief_hex.sql`, `0017_spotty_mongu.sql`, `0018_greedy_stepford_cuckoos.sql` |
| `db/statuses.rs` | `Status` | `0000_thankful_luke_cage.sql`, `0018_greedy_stepford_cuckoos.sql` |
| `db/tasks.rs` | `Task` | `0000_thankful_luke_cage.sql`, `0010_dizzy_natasha_romanoff.sql`, `0017_spotty_mongu.sql`, `0018_greedy_stepford_cuckoos.sql` |
| `db/notes_cache.rs` | `PropertyDefinition` | `0022_notes_journal_vault.sql` |
| `db/note_metadata.rs` | `NoteMetadata` | `0022_notes_journal_vault.sql` |
| `db/note_positions.rs` | `NotePosition` | `0006_late_infant_terrible.sql` |

**Do not deviate from these names.** Task 14 generator (Phase F) references them literally. If Phase B normalized filename stems, use the actual files with these source numbers. Do not depend on or create `0029`.

### Methodology — verification-before-completion per struct

1. **Invoke `superpowers:using-superpowers` and `superpowers:verification-before-completion`** first.
2. **Per-struct workflow:**
   - Cat the relevant migration SQL file(s) to enumerate the **final** column set (after all applicable ALTER TABLEs).
   - Optionally cross-reference `packages/db-schema/src/schema/<table>.ts` for column semantics (nullable, defaults, types) — but **authority is the SQL**, not the TS.
   - Write the struct following plan Task 8 / 9 patterns:
     - `#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]`
     - `#[serde(rename_all = "camelCase")]`
     - Fields ordered the same as columns in CREATE TABLE (readability).
     - Type mapping (from plan Step 9.2):
       - `TEXT NOT NULL` → `String`
       - `TEXT` nullable → `Option<String>`
       - `INTEGER NOT NULL` (counter/id) → `i64`
       - `INTEGER` nullable → `Option<i64>`
       - `INTEGER` boolean (0/1) → `bool`
     - `impl StructName { pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> { … } }` — one `row.get("col")?` per field. Boolean conversion explicit: `row.get::<_, i64>("col")? != 0`.
   - Add `pub mod <table>;` to `db/mod.rs`.
   - Add a roundtrip smoke test at the bottom of `tests/migrations_test.rs`:
     - Open `Db::open_memory`.
     - `conn.execute("INSERT INTO …", params![…])` with minimal required columns.
     - `conn.query_row("SELECT * FROM …", [], StructName::from_row)`.
     - Assert one or two field values to confirm correct mapping.
   - Run `cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers` — must PASS.
   - Run `cargo clippy -- -D warnings` — must be clean.
   - Commit: `m2(db): add <Structs> structs`.

### Column quirks to watch

- **`tasks.clock` + `tasks.field_clocks`**: JSON strings stored as `TEXT`. Expose as `Option<String>` in M2; typed `VectorClock`/`FieldClocks` parsing lands in M6 when sync code needs them. Do NOT introduce JSON parsing here.
- **`is_inbox`, `is_default`, `is_done`, etc.**: SQLite INTEGER 0/1 → Rust `bool`. Use the `row.get::<_, i64>("col")? != 0` pattern; never try `row.get::<_, bool>(...)` (rusqlite's bool coercion is version-dependent and Clippy warns).
- **`created_at` / `modified_at`**: `TEXT` in ISO-8601 format. Keep as `String`; do not convert to `chrono::DateTime` in M2 (adds serde<>chrono bridge cost we don't need yet).
- **`note_metadata.properties` (if present as JSON column)**: same treatment as `clock` — `Option<String>`, parsing deferred.

### Critical gotchas

1. **Field name conflict with serde rename:** You write Rust field `is_inbox`. With `rename_all = "camelCase"`, specta emits TS `isInbox`. But `from_row("is_inbox")` reads from DB column `is_inbox`. All three (Rust field, DB column, TS field) different casings — no bug, just confirming the mental model: `row.get("snake_case")` always matches DB, serde renames only the wire format.
2. **Non-existent columns in SELECT:** If your struct has a field that doesn't exist in any migration (typo, or column was removed by a later ALTER), rusqlite will fail on `from_row`. Re-cat the final migration state (apply all → `PRAGMA table_info(<table>)`) to verify.
3. **`db/mod.rs` export order:** Keep imports alphabetical within each category. Put `pub mod migrations;` first (infrastructure), then data modules alphabetically.
4. **Smoke test determinism:** `Db::open_memory` is fresh for each test. Insert + select is deterministic. But if you use `datetime('now')` in an assertion, your test will be flaky — assert field presence, not timestamp equality.
5. **Test helpers feature gate:** `cargo test --features test-helpers` — don't forget the flag. Without it, `Db::open_memory` is hidden and tests fail to compile.

### Constraints

- **No CRUD helpers beyond `from_row`.** No `create`, `update`, `delete`, `list`, `find_by_*` methods in Phase C. Those come in later milestones (M5 for notes, M8.1 for tasks/projects, etc).
- **No `rusqlite::types::FromSql` custom impls.** Stay on the built-in conversions + `from_row` helper. `FromSql` derives are a future optimization not needed in M2.
- **No premature generics.** Don't abstract `from_row` into a trait — repetition is fine; each struct has its own column set.
- **Commit granularity:** Task 8 = one commit (`m2(db): add Project/Status/Task structs with from_row helpers`). Task 9 = one commit. Total: 2 commits in Phase C.

### Acceptance criteria (Phase C done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Files exist
for f in projects statuses tasks notes_cache note_metadata note_positions; do
  test -f apps/desktop-tauri/src-tauri/src/db/$f.rs || echo "MISSING: $f.rs"
done

# Module exports match
grep -c '^pub mod' apps/desktop-tauri/src-tauri/src/db/mod.rs
# Expect >= 7 (migrations + 6 new)

# Compile clean + clippy
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy

# Tests pass with new smoke tests
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -5
# Expect passed count at least +4 vs Phase B end (projects_and_tasks_roundtrip + one per notes_* table)

# Canonical struct names present in source
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
grep -l 'pub struct Project\b' apps/desktop-tauri/src-tauri/src/db/projects.rs
grep -l 'pub struct Status\b' apps/desktop-tauri/src-tauri/src/db/statuses.rs
grep -l 'pub struct Task\b' apps/desktop-tauri/src-tauri/src/db/tasks.rs
grep -l 'pub struct PropertyDefinition\b' apps/desktop-tauri/src-tauri/src/db/notes_cache.rs
grep -l 'pub struct NoteMetadata\b' apps/desktop-tauri/src-tauri/src/db/note_metadata.rs
grep -l 'pub struct NotePosition\b' apps/desktop-tauri/src-tauri/src/db/note_positions.rs

# Commits
git log --oneline | grep -c "m2(db)"
# expect ≥ 2 for Phase C

# Electron untouched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ | wc -l
# expect 0
```

### When done

Report:

```
Phase C complete.
Tasks covered: 8, 9
Commits: <N> (<first_hash>..<last_hash>)
Structs added: Project, Status, Task, PropertyDefinition, NoteMetadata, NotePosition
Rust tests: <passed count> (smoke roundtrips: <count>)

Next: Phase D — prompts/m2/m2-phase-d-calendar-collections-structs.md
Blockers: <none | list>
```

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:verification-before-completion`.
2. Read plan Tasks 8, 9 fully.
3. Run prerequisite verification.
4. Task 8: cat `0000`, `0010`, `0015`, `0017`, and `0018` migrations → write `Project`/`Status`/`Task` → export → smoke test → commit.
5. Task 9: cat `0006` and `0022` migrations → write `NoteMetadata`/`NotePosition`/`PropertyDefinition` → export → smoke test → commit.

## PROMPT END
