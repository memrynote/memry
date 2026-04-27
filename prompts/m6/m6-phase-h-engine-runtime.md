# M6 Phase H - Push/Pull Coordinators + Engine Runtime

Fresh session prompt. This phase introduces the Rust sync runtime and the pull, apply,
push, and full-sync loops.

---

## PROMPT START

You are implementing **Phase H of Milestone M6**. This phase executes Chunk 8 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-g-local-mutation-enqueue.md`

Phase H creates `SyncRuntime` and `SyncEngine`. It should prove pull-before-push,
durable queue draining, cursor advancement, bounded stop, pause behavior, and event
emission. It does not add public Tauri sync ops commands yet.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_local_mutations_test --test sync_queue_test
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_handlers_test --test sync_crypto_batch_test
pnpm --filter @memry/desktop-tauri cargo:check
```

If any command fails, STOP and report.

### Your Scope

Execute Chunk 8 in order:

- **Step 1:** Write engine lifecycle tests.
- **Step 2:** Implement `SyncRuntime`.
- **Step 3:** Implement push coordinator.
- **Step 4:** Implement pull coordinator.
- **Step 5:** Implement full sync.
- **Step 6:** Run focused gate.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `apps/desktop-tauri/src-tauri/src/app_state.rs`
- `apps/desktop-tauri/src-tauri/src/lib.rs`
- `apps/desktop-tauri/src-tauri/src/sync/client.rs`
- `apps/desktop-tauri/src-tauri/src/sync/session.rs`
- `apps/desktop-tauri/src-tauri/src/sync/queue.rs`
- `apps/desktop-tauri/src-tauri/src/sync/handlers/*`
- `apps/desktop-tauri/src-tauri/src/sync/crypto_batch.rs`
- `apps/desktop-tauri/src-tauri/src/sync/local_mutations.rs`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md` Chunk 8

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Write tests first and confirm RED:
   - `start` with no auth stays idle.
   - `start` with auth pulls before push.
   - `push_now` drains queue in batches of 100.
   - `pull_now` applies changes and advances cursor exactly once.
   - `stop` aborts listen loop and does a bounded final push.
   - pause prevents scheduled sync but preserves queue.
3. Implement `SyncRuntime` with `engine: tokio::sync::Mutex<Option<SyncEngine>>`,
   `status: watch::Sender<SyncStatusView>`, task handles, and quarantine state.
4. Push flow:
   - read queue batch from DB.
   - build payloads through handlers.
   - rebind `_offline` clocks before encryption/signing.
   - encrypt/sign batch.
   - POST `/sync/records/push`.
   - mark accepted rows success and rejected rows failed.
   - emit `item-synced`, status, and history events.
5. Pull flow:
   - GET `/sync/records/changes?cursor=<last_cursor>&limit=<page>`.
   - POST `/sync/records/pull` for item refs.
   - decrypt/verify pulled items.
   - apply through handlers.
   - persist cursor only after successful page.
   - compare server time and emit `clock-skew-warning` outside tolerance.
   - emit conflict/security/status/history events.
6. Full-sync order is strict: pull records -> seed existing CRDT docs -> push CRDT ->
   push records -> connect/listen.
7. No `rusqlite::Connection` guard may cross `.await`. Snapshot owned data before
   network awaits, then reacquire DB for persistence.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_engine_test
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

Expected: PASS.

### When Done

Report:

```text
Phase H complete.
Plan chunk: 8
Commits: <count> (<first hash>..<last hash>)
Verification: sync_engine_test + clippy
Next: Phase I - prompts/m6/m6-phase-i-websocket-listener.md
Blockers: <none | list>
```

## PROMPT END
