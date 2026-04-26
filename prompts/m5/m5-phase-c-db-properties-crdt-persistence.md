# M5 Phase C - DB Properties + CRDT Persistence

Fresh session prompt. This phase adds property-definition persistence and CRDT
update/snapshot persistence.

---

## PROMPT START

You are implementing **Phase C of Milestone M5**. This phase executes plan Tasks
20-22 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-b-db-schema-notes.md`

Phase B landed the DB scaffolding and notes-adjacent modules. Phase C completes the
DB layer by adding property definitions and CRDT persistence modules.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
test -f apps/desktop-tauri/src-tauri/migrations/0029_crdt_updates.sql
test -f apps/desktop-tauri/src-tauri/migrations/0030_crdt_snapshots.sql
pnpm --filter @memry/desktop-tauri cargo:test -- --test 'db_*' --test migrations_test
```

If this fails, STOP and finish Phase B.

### Your Scope

Execute Tasks 20-22 in order:

- **Task 20:** Create `db/property_definitions.rs` and tests. Cover list/get/create,
  update/ensure, add/remove/rename option, update option color, status options, delete.
- **Task 21:** Create `db/crdt_updates.rs` and tests. Cover append, max_seq,
  list_for_note, drop_through, origin persistence, and payload size cap.
- **Task 22:** Create `db/crdt_snapshots.rs` and tests. Cover get_latest and
  upsert_with_compaction dropping old updates in one transaction.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 20-22 fully before editing.
3. Keep JSON option mutation local to `property_definitions.rs`.
4. Do not introduce connection pools. Use the existing single-connection pattern.
5. For snapshot compaction, transactionality matters: write snapshot and drop old update
   rows together.
6. Commit once per task.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

test -f apps/desktop-tauri/src-tauri/src/db/property_definitions.rs
test -f apps/desktop-tauri/src-tauri/src/db/crdt_updates.rs
test -f apps/desktop-tauri/src-tauri/src/db/crdt_snapshots.rs
test -f apps/desktop-tauri/src-tauri/tests/db_property_definitions_test.rs
test -f apps/desktop-tauri/src-tauri/tests/db_crdt_updates_test.rs
test -f apps/desktop-tauri/src-tauri/tests/db_crdt_snapshots_test.rs

cd apps/desktop-tauri/src-tauri
cargo test --test db_property_definitions_test
cargo test --test db_crdt_updates_test
cargo test --test db_crdt_snapshots_test

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
pnpm --filter @memry/desktop-tauri cargo:test -- --test 'db_*' --test migrations_test
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

### When Done

Report:

```text
Phase C complete.
Tasks covered: 20, 21, 22
Commits: <count> (<first hash>..<last hash>)
Verification: property/crdt DB tests + db full slice + clippy
Next: Phase D - prompts/m5/m5-phase-d-notes-core-commands.md
Blockers: <none | list>
```

## PROMPT END
