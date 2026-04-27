# M6 Phase G - Local Mutation Enqueue Wiring

Fresh session prompt. This phase makes live M5 local writes enqueue durable sync
records. Without this, the engine can run but has nothing to push.

---

## PROMPT START

You are implementing **Phase G of Milestone M6**. This phase executes Chunk 7 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-f-handler-registry.md`

Phase G wires current M5 real writes only: notes, folders, tag definitions, and folder
config paths. It exposes helper logic for future domains but does not patch M8-only
mock CRUD paths.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_handlers_test
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_queue_test
pnpm --filter @memry/desktop-tauri cargo:check
```

If any command fails, STOP and report.

### Your Scope

Execute Chunk 7 in order:

- **Step 1:** Write local mutation tests.
- **Step 2:** Add Cargo test entry.
- **Step 3:** Implement `local_mutations.rs`.
- **Step 4:** Wire only currently real local write paths.
- **Step 5:** Add local-only stop guard.
- **Step 6:** Run focused gate.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `apps/desktop-tauri/src-tauri/src/commands/notes.rs`
- `apps/desktop-tauri/src-tauri/src/commands/folders.rs`
- `apps/desktop-tauri/src-tauri/src/commands/properties.rs`
- `apps/desktop-tauri/src-tauri/src/sync/queue.rs`
- `apps/desktop-tauri/src-tauri/src/sync/vector_clock.rs`
- `packages/contracts/src/sync-api.ts`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md` Chunk 7

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Write tests first and confirm RED:
   - `notes_create` enqueues `note/create` only after DB/vault commit.
   - `notes_update` enqueues `note/update` and increments/rebinds clock metadata.
   - `notes_delete` enqueues `note/delete` tombstone and skips local-only notes.
   - folder config edits enqueue `folder_config/update`.
   - tag definition edits enqueue `tag_definition/update` when those commands are live.
   - failed vault/DB writes do not enqueue.
   - duplicate update bursts coalesce in `sync_queue`.
   - missing device id records ticks under `_offline`.
   - push-time rebind replaces `_offline` with current `device_id`.
   - rebind is idempotent across engine restarts.
3. Implement helpers only:
   - `enqueue_create(state, item_type, item_id)`
   - `enqueue_update(state, item_type, item_id, changed_fields)`
   - `enqueue_delete(state, item_type, item_id)`
   - `bump_clock_json(existing, device_id_or_offline)`
   - `bump_field_clocks_json(existing, changed_fields, device_id_or_offline)`
   - `rebind_offline_clocks(payload, device_id)`
4. Use `OFFLINE_CLOCK_DEVICE_ID` from contracts for `_offline` behavior.
5. Wire local mutations after the local write commits, not before.
6. No `rusqlite::Connection` guard may cross `.await`.
7. `sync_policy = local_only` or `local_only = true` must not enqueue network sync
   records.
8. Do not patch mock-only task/project/inbox/calendar renderer paths.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_local_mutations_test
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_local_mutations_test --test sync_queue_test
```

Expected: PASS.

### When Done

Report:

```text
Phase G complete.
Plan chunk: 7
Commits: <count> (<first hash>..<last hash>)
Verification: sync_local_mutations_test + sync_queue_test
Next: Phase H - prompts/m6/m6-phase-h-engine-runtime.md
Blockers: <none | list>
```

## PROMPT END
