# M5 Phase E - Notes Advanced Commands

Fresh session prompt. This phase completes the notes command surface that is not folder
or property specific.

---

## PROMPT START

You are implementing **Phase E of Milestone M5**. This phase executes plan Tasks
29-32 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-d-notes-core-commands.md`

Phase D landed basic notes lifecycle commands. Phase E completes rename/move/existence,
local-only state, tags, links, wiki-link helpers, and the aggregate notes command test.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
test -f apps/desktop-tauri/src-tauri/src/commands/notes.rs
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

If this fails, STOP and finish Phase D.

### Your Scope

Execute Tasks 29-32 in order:

- **Task 29:** Implement `notes_rename`, `notes_move`, and `notes_exists`.
- **Task 30:** Implement `notes_set_local_only` and `notes_get_local_only_count`.
- **Task 31:** Implement `notes_get_tags`, `notes_get_links`,
  `notes_resolve_by_title`, and `notes_preview_by_title`.
- **Task 32:** Create/finish `commands_notes_test.rs` with at least 6 happy-path
  scenarios across create/list/rename/move/delete/local-only/exists.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 29-32 fully before editing.
3. Keep wiki-link resolution SQL `LIKE`/`COLLATE NOCASE` only. Add the TODO(M7) note
   from the plan, but do not build FTS in M5.
4. Preserve existing renderer DTO shape from Phase D.
5. Register new commands in the same Rust handler/bindings path used by Phase D.
6. Commit once per task.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

rg -n "notes_rename|notes_move|notes_exists|notes_get_links|notes_preview_by_title" \
  apps/desktop-tauri/src-tauri/src/commands/notes.rs
test -f apps/desktop-tauri/src-tauri/tests/commands_notes_test.rs

cd apps/desktop-tauri/src-tauri
cargo test --test commands_notes_test

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

Commit regenerated bindings only if this phase changes generated bindings.

### When Done

Report:

```text
Phase E complete.
Tasks covered: 29, 30, 31, 32
Commits: <count> (<first hash>..<last hash>)
Verification: commands_notes_test + bindings check + clippy
Next: Phase F - prompts/m5/m5-phase-f-folder-commands.md
Blockers: <none | list>
```

## PROMPT END
