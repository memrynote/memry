# M5 Phase B - DB Schema + Notes DB Primitives

Fresh session prompt. This phase adds the CRDT migrations and fleshes out the notes,
folder-config, position, cache, and tag DB modules.

---

## PROMPT START

You are implementing **Phase B of Milestone M5**. This phase executes plan Tasks
10-19 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-a-crdt-foundation.md`

Phase A created the in-memory CRDT runtime. Phase B builds the local data persistence
base needed by notes/folder/property/CRDT commands. It does not expose Tauri commands.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
git rev-parse --abbrev-ref HEAD
test -f apps/desktop-tauri/src-tauri/src/crdt/docstore.rs
test -f apps/desktop-tauri/src-tauri/src/crdt/wire.rs
pnpm --filter @memry/desktop-tauri cargo:test -- --test 'crdt_*'
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

If any command fails, STOP and fix Phase A first.

### Your Scope

Execute Tasks 10-19 in order:

- **Task 10:** Capture schema diff baseline and inspect Electron SQL as read-only
  reference. No commit.
- **Task 11:** Add migration `0029_crdt_updates.sql` and migration test.
- **Task 12:** Add migration `0030_crdt_snapshots.sql` and migration test.
- **Task 13:** Register both migrations in `db/migrations.rs`.
- **Task 14:** Declare/re-export DB modules in `db/mod.rs`.
- **Task 15:** Implement `db/note_metadata.rs` CRUD, soft delete, rename, local-only,
  exists, list helpers, and tests.
- **Task 16:** Implement `db/note_positions.rs` reorder/get/drop helpers and tests.
- **Task 17:** Implement `db/notes_cache.rs` refresh/list/count/delete helpers and
  tests. Add a migration only if the table is actually missing.
- **Task 18:** Implement `db/folder_configs.rs` get/set/delete/template inheritance
  and tests.
- **Task 19:** Implement `db/tag_definitions.rs` list/count/upsert/rename behavior
  and tests.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 10-19 fully before editing.
3. Use Electron SQL only as reference; do not modify `apps/desktop/**`.
4. Add `test_helpers` only if missing, behind the same cfg pattern already used in
   the Tauri crate.
5. Keep SQL simple and explicit. No speculative indexing beyond the plan.
6. Commit once per task when source changed.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

test -f apps/desktop-tauri/src-tauri/migrations/0029_crdt_updates.sql
test -f apps/desktop-tauri/src-tauri/migrations/0030_crdt_snapshots.sql
test -f apps/desktop-tauri/src-tauri/src/db/note_metadata.rs
test -f apps/desktop-tauri/src-tauri/src/db/note_positions.rs
test -f apps/desktop-tauri/src-tauri/src/db/notes_cache.rs
test -f apps/desktop-tauri/src-tauri/src/db/folder_configs.rs
test -f apps/desktop-tauri/src-tauri/src/db/tag_definitions.rs

cd apps/desktop-tauri/src-tauri
cargo test --test migrations_test
cargo test --test db_note_metadata_test
cargo test --test db_note_positions_test
cargo test --test db_notes_cache_test
cargo test --test db_folder_configs_test
cargo test --test db_tag_definitions_test

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
pnpm --filter @memry/desktop-tauri cargo:test -- --test 'db_*' --test migrations_test
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

### When Done

Report:

```text
Phase B complete.
Tasks covered: 10, 11, 12, 13, 14, 15, 16, 17, 18, 19
Commits: <count> (<first hash>..<last hash>)
Verification: migrations_test + db note/folder/tag tests + cargo clippy
Next: Phase C - prompts/m5/m5-phase-c-db-properties-crdt-persistence.md
Blockers: <none | list>
```

## PROMPT END
