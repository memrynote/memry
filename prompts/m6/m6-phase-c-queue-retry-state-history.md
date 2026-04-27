# M6 Phase C - Queue, Retry, State + History

Fresh session prompt. This phase turns M2 DTO-only sync DB modules into the durable
queue/state/history primitives used by the runtime.

---

## PROMPT START

You are implementing **Phase C of Milestone M6**. This phase executes Chunk 3 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-b-http-session-pinning.md`

Phase C implements durable local mutation queue CRUD, retry/backoff policy, sync
state keys, and sync history helpers. It does not wire local CRUD paths yet.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
test -f apps/desktop-tauri/src-tauri/src/db/sync_queue.rs
test -f apps/desktop-tauri/src-tauri/src/db/sync_state.rs
test -f apps/desktop-tauri/src-tauri/src/db/sync_history.rs
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_http_contract_test --test sync_pinning_test
pnpm --filter @memry/desktop-tauri cargo:check
```

If any command fails, STOP and report.

### Your Scope

Execute Chunk 3 in order:

- **Step 1:** Write queue tests.
- **Step 2:** Write retry tests.
- **Step 3:** Implement `SyncQueueManager`.
- **Step 4:** Implement retry helpers.
- **Step 5:** Implement state/history helpers.
- **Step 6:** Run focused gate.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `apps/desktop-tauri/src-tauri/src/db/sync_queue.rs`
- `apps/desktop-tauri/src-tauri/src/db/sync_state.rs`
- `apps/desktop-tauri/src-tauri/src/db/sync_history.rs`
- `apps/desktop/src/main/sync/queue*` or equivalent Electron queue reference
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md` Chunk 3

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Write tests first and confirm RED:
   - enqueue create/update/delete writes durable rows.
   - same item/type coalesces create/update/delete like Electron.
   - dequeue orders by priority desc then created_at asc.
   - `mark_success` deletes the row.
   - `mark_failed` increments attempts and preserves redacted error.
   - pending/failed/dead-letter counts match Electron semantics.
   - exponential backoff caps at max.
   - 429 honors retry-after.
   - 4xx except 429 is non-retryable.
   - abort signal stops sleep.
   - offline wait resumes when network status flips.
3. Implement `SyncQueueManager` with a small API: `enqueue`, `dequeue`,
   `mark_success`, `mark_failed`, `stats`, `clear`, and `remove_by_item_id`.
4. Use `EnqueueInput { item_type, item_id, operation, payload, priority }`.
5. Implement retry sleeps with tokio and owned abort state. Never hold a DB lock while
   sleeping.
6. Implement state keys exactly: `last_cursor`, `last_sync_at`, `sync_paused`,
   `offline_since`, and `crdt_cursor:<note_id>`.
7. Implement history row helpers for `push`, `pull`, and `error`.
8. Keep schema changes minimal. Reuse existing `sync_queue` unless a schema diff proves
   it cannot support M6.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_queue_test
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_retry_test
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_queue_test --test sync_retry_test
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

Expected: PASS.

### When Done

Report:

```text
Phase C complete.
Plan chunk: 3
Commits: <count> (<first hash>..<last hash>)
Verification: sync_queue_test + sync_retry_test + clippy
Next: Phase D - prompts/m6/m6-phase-d-vector-clocks-field-merge.md
Blockers: <none | list>
```

## PROMPT END
