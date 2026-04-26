# M5 Phase I - CRDT Commands

Fresh session prompt. This phase exposes the Rust CRDT runtime through Tauri commands.

---

## PROMPT START

You are implementing **Phase I of Milestone M5**. This phase executes plan Tasks
40-46 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-h-deferred-stubs-parity.md`

The CRDT runtime and DB persistence exist. Phase I exposes open/apply/snapshot/state
vector/sync/chunk commands for the renderer provider.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
test -f apps/desktop-tauri/src-tauri/src/crdt/apply.rs
test -f apps/desktop-tauri/src-tauri/src/db/crdt_updates.rs
test -f apps/desktop-tauri/src-tauri/src/db/crdt_snapshots.rs
pnpm --filter @memry/desktop-tauri cargo:test -- --test 'crdt_*' --test 'db_crdt_*'
```

If this fails, STOP and finish earlier CRDT/DB phases.

### Your Scope

Execute Tasks 40-46 in order:

- **Task 40:** Create `commands/crdt.rs`; implement `crdt_open_doc`,
  `crdt_close_doc`, and inner helpers.
- **Task 41:** Implement `crdt_apply_update` with 8 KB inline cap, persistence,
  compaction, and `crdt-update` event emission.
- **Task 41A:** Implement large-update chunk commands:
  `crdt_apply_update_chunk_start`, `crdt_apply_update_chunk_append`,
  `crdt_apply_update_chunk_finish`.
- **Task 42:** Implement binary `Response` commands `crdt_get_snapshot` and
  `crdt_get_state_vector`.
- **Task 43:** Implement `crdt_sync_step_1` and `crdt_sync_step_2`.
- **Task 44:** Implement `crdt_get_or_init_doc`.
- **Task 45:** Add capability scopes for CRDT commands.
- **Task 46:** Finish aggregate `commands_crdt_test.rs`.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 40-46 fully before editing.
3. Use binary `tauri::ipc::Response` for snapshot/state-vector returns.
4. Inline CRDT updates above 8 KB must fail and direct users to chunked transport.
5. Chunk finish must persist once, emit one `crdt-update`, and clear the accumulator.
6. Register commands and regenerate bindings after the commands compile.
7. Commit once per task.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

test -f apps/desktop-tauri/src-tauri/src/commands/crdt.rs
test -f apps/desktop-tauri/src-tauri/tests/commands_crdt_test.rs
rg -n "crdt_apply_update_chunk_start|crdt_get_snapshot|crdt_sync_step_1" \
  apps/desktop-tauri/src-tauri/src

cd apps/desktop-tauri/src-tauri
cargo test --test commands_crdt_test
cargo test --test crdt_compaction_test

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

### When Done

Report:

```text
Phase I complete.
Tasks covered: 40, 41, 41A, 42, 43, 44, 45, 46
Commits: <count> (<first hash>..<last hash>)
Verification: commands_crdt_test + bindings/capability check + clippy
Next: Phase J - prompts/m5/m5-phase-j-renderer-provider-blocknote.md
Blockers: <none | list>
```

## PROMPT END
