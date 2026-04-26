# M5 Phase F - Folder Commands

Fresh session prompt. This phase ships folder CRUD, folder configs/templates, and note
position commands.

---

## PROMPT START

You are implementing **Phase F of Milestone M5**. This phase executes plan Tasks
33-35 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-e-notes-advanced-commands.md`

The notes command surface exists. Phase F adds folder-level commands and positions.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
test -f apps/desktop-tauri/src-tauri/src/db/folder_configs.rs
test -f apps/desktop-tauri/src-tauri/src/db/note_positions.rs
test -f apps/desktop-tauri/src-tauri/src/commands/notes.rs
pnpm --filter @memry/desktop-tauri cargo:test -- --test commands_notes_test
```

If this fails, STOP and finish notes commands first.

### Your Scope

Execute Tasks 33-35 in order:

- **Task 33:** Create `commands/folders.rs`; implement `notes_get_folders`,
  `notes_create_folder`, `notes_rename_folder`, `notes_delete_folder`, with tests.
- **Task 34:** Implement `notes_get_folder_config`, `notes_set_folder_config`, and
  `notes_get_folder_template`.
- **Task 35:** Implement `notes_get_positions`, `notes_get_all_positions`, and
  `notes_reorder`.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 33-35 fully before editing.
3. Use M3 vault FS helpers for directory operations. If a helper is missing, add the
   smallest method in the existing vault module.
4. Rename folder must update child note metadata paths.
5. Delete folder must refuse non-empty folders unless `recursive: true`.
6. Commit once per task.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

test -f apps/desktop-tauri/src-tauri/src/commands/folders.rs
test -f apps/desktop-tauri/src-tauri/tests/commands_folders_test.rs
rg -n "notes_get_folders|notes_create_folder|notes_reorder" apps/desktop-tauri/src-tauri/src

cd apps/desktop-tauri/src-tauri
cargo test --test commands_folders_test

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

### When Done

Report:

```text
Phase F complete.
Tasks covered: 33, 34, 35
Commits: <count> (<first hash>..<last hash>)
Verification: commands_folders_test + bindings check + clippy
Next: Phase G - prompts/m5/m5-phase-g-property-commands.md
Blockers: <none | list>
```

## PROMPT END
