# M5 Phase D - Notes Core Commands

Fresh session prompt. This phase lands the notes command skeleton and basic lifecycle
commands.

---

## PROMPT START

You are implementing **Phase D of Milestone M5**. This phase executes plan Tasks
23-28 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-c-db-properties-crdt-persistence.md`

The DB layer now exists. Phase D exposes the core notes lifecycle as Rust commands and
inner helpers. Advanced notes helpers come in Phase E.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
test -f apps/desktop-tauri/src-tauri/src/db/note_metadata.rs
test -f apps/desktop-tauri/src-tauri/src/db/notes_cache.rs
pnpm --filter @memry/desktop-tauri cargo:test -- --test 'db_*' --test migrations_test
```

If this fails, STOP and finish the DB phases.

### Your Scope

Execute Tasks 23-28 in order:

- **Task 23:** Create `commands/notes.rs` skeleton, renderer-shape DTOs, shared helpers,
  and module registration. Add `chrono` only if needed after searching current deps.
- **Task 24:** Implement `notes_create` and `notes_create_inner`.
- **Task 25:** Implement `notes_get` and `notes_get_by_path`.
- **Task 26:** Implement `notes_update`.
- **Task 27:** Implement `notes_delete` soft delete. Add a minimal vault trash helper only
  if the M3 vault layer lacks one.
- **Task 28:** Implement `notes_list` and `notes_list_by_folder`.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 23-28 fully before editing.
3. Keep commands thin: validate input -> vault FS -> DB modules -> emit event -> return DTO.
4. Write inner helpers for testability when `AppHandle` is not needed.
5. Register commands only after the implementation exists.
6. Commit once per task.

### Critical Gotchas

1. Body content lives in the vault FS. Metadata/cache live in SQLite.
2. User-facing command errors must use `AppError` variants, not raw strings.
3. Event names for this phase must be `note-created`, `note-updated`, and
   `note-deleted`.
4. Do not implement folders/properties/CRDT commands here.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

test -f apps/desktop-tauri/src-tauri/src/commands/notes.rs
test -f apps/desktop-tauri/src-tauri/tests/commands_notes_create_test.rs
test -f apps/desktop-tauri/src-tauri/tests/commands_notes_get_test.rs

cd apps/desktop-tauri/src-tauri
cargo test --test commands_notes_create_test
cargo test --test commands_notes_get_test
cargo test --test commands_notes_test || true

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

`commands_notes_test` may not exist until Phase E. If it exists, it must pass.

### When Done

Report:

```text
Phase D complete.
Tasks covered: 23, 24, 25, 26, 27, 28
Commits: <count> (<first hash>..<last hash>)
Verification: notes create/get/update/delete/list tests + cargo check/clippy
Next: Phase E - prompts/m5/m5-phase-e-notes-advanced-commands.md
Blockers: <none | list>
```

## PROMPT END
