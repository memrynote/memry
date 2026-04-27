# M6 Phase F - Sync Handler Registry

Fresh session prompt. This phase implements all record-type handlers from the contracts
and no extras.

---

## PROMPT START

You are implementing **Phase F of Milestone M6**. This phase executes Chunk 6 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-e-crypto-batch-device-keys.md`

Phase F implements the handler registry for record sync. Attachments are not record
handlers; they use blob routes in Phase K. Note bodies remain CRDT-owned in Phase J.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_crypto_batch_test
pnpm --filter @memry/desktop-tauri cargo:check
```

If any command fails, STOP and report.

### Your Scope

Execute Chunk 6 in order:

- **Step 1:** Write registry coverage test.
- **Step 2:** Define `SyncItemHandler`.
- **Step 3:** Implement note/task/project/settings handlers.
- **Step 4:** Implement inbox/filter/journal/tag/folder handlers.
- **Step 5:** Implement calendar record handlers.
- **Step 6:** Run focused gate.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `packages/contracts/src/sync-api.ts`
- `apps/desktop/src/main/sync/item-handlers/*`
- `apps/desktop-tauri/src-tauri/src/db/*.rs` modules for affected domains
- `apps/desktop-tauri/src-tauri/src/sync/vector_clock.rs`
- `apps/desktop-tauri/src-tauri/src/sync/field_merge.rs`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md` Chunk 6

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Assert every `RECORD_SYNC_ITEM_TYPES` value has one handler and no extras:
   `note`, `task`, `project`, `settings`, `inbox`, `filter`, `journal`,
   `tag_definition`, `folder_config`, `calendar_event`, `calendar_source`,
   `calendar_binding`, `calendar_external_event`.
3. Define the minimal trait:

```rust
pub trait SyncItemHandler {
    fn item_type(&self) -> SyncItemType;
    fn fetch_local(&self, conn: &Connection, item_id: &str) -> AppResult<Option<serde_json::Value>>;
    fn build_push_payload(
        &self,
        conn: &Connection,
        item_id: &str,
        device_id: &str,
        operation: SyncOperation,
    ) -> AppResult<Option<serde_json::Value>>;
    fn apply_remote(
        &self,
        conn: &Connection,
        item_id: &str,
        operation: SyncOperation,
        payload: serde_json::Value,
        clock: Option<VectorClock>,
    ) -> AppResult<ApplyResult>;
}
```

4. Add focused DB fetch/upsert helpers only where handlers need them.
5. For notes, sync metadata and tombstones here; leave note body convergence to the
   CRDT coordinator.
6. For task/project/settings, prove different-field conflicts merge correctly.
7. For inbox/filter/journal/tag/folder config, prove tombstone and JSON round-trip
   behavior.
8. For calendar handlers, include clocks but never serialize provider tokens/secrets.
9. Do not implement bookmarks, templates, or reminders. The contract is the source of
   truth.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_handlers_test
```

Expected: PASS with at least one positive apply and one delete/tombstone case per
handler.

### When Done

Report:

```text
Phase F complete.
Plan chunk: 6
Commits: <count> (<first hash>..<last hash>)
Verification: sync_handlers_test
Next: Phase G - prompts/m6/m6-phase-g-local-mutation-enqueue.md
Blockers: <none | list>
```

## PROMPT END
