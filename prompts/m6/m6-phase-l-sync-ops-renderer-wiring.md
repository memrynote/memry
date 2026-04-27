# M6 Phase L - Sync Ops Commands + Renderer Wiring

Fresh session prompt. This phase exposes the Rust sync runtime through real Tauri
commands, aligns renderer DTOs, and retires the M1 sync mocks.

---

## PROMPT START

You are implementing **Phase L of Milestone M6**. This phase executes Chunk 12 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-k-attachments-blob-sync.md`

Phase L is the main command graduation phase for M6. Commands should be thin wrappers
over `SyncRuntime`; tests should target `*_inner` functions where possible.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_engine_test --test sync_attachments_test
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri cargo:check
```

If any command fails, STOP and report.

### Your Scope

Execute Chunk 12 in order:

- **Step 1:** Write command tests.
- **Step 2:** Implement thin commands over `SyncRuntime`.
- **Step 3:** Register commands in Tauri and capabilities.
- **Step 4:** Align renderer DTOs.
- **Step 5:** Graduate `realCommands` and retire mapped mocks.
- **Step 6:** Run focused gate.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `apps/desktop-tauri/src-tauri/src/sync/runtime.rs`
- `apps/desktop-tauri/src-tauri/src/sync/engine.rs`
- `apps/desktop-tauri/src-tauri/src/sync/status.rs`
- `apps/desktop-tauri/src-tauri/src/lib.rs`
- `apps/desktop-tauri/src-tauri/capabilities/default.json`
- `apps/desktop-tauri/src/lib/ipc/invoke.ts`
- `apps/desktop-tauri/src/lib/ipc/mocks/sync.ts`
- `apps/desktop-tauri/src/contexts/sync-context.tsx`
- `apps/desktop-tauri/src/hooks/use-sync-history.ts`
- `apps/desktop-tauri/src/hooks/use-storage-usage.ts`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md` Chunk 12 and Mock Retirement Mapping

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Write tests first and confirm RED:
   - `sync_ops_get_status` returns idle when no auth.
   - `sync_ops_trigger_sync` calls `full_sync`.
   - `sync_ops_get_history` paginates and parses details JSON.
   - `sync_ops_get_queue_size` returns pending/failed.
   - `sync_ops_pause` and `sync_ops_resume` persist state and emit events.
   - `sync_ops_get_storage_breakdown` calls `/sync/storage`.
   - `sync_ops_get_quarantined_items` returns current quarantine.
   - `sync_ops_retry_quarantined_item` requeues retryable quarantine.
   - `sync_ops_delete_quarantined_item` validates explicit input before deletion.
   - `sync_ops_check_device_status` detects revoked/auth unknown.
   - `sync_ops_emergency_wipe` clears queue/session/runtime safely.
   - `sync_ops_update_synced_setting` and `sync_ops_get_synced_settings` round-trip.
   - `sync_start`, `sync_stop`, `sync_push_now`, `sync_pull_now`, `sync_status`, and
     `sync_reset_cursor` are direct runtime/devtools controls.
3. Keep command functions small. Push business logic into runtime/service internals.
4. Prefer Rust `serde(rename_all = "camelCase")` over renderer churn.
5. Register commands in `src-tauri/src/lib.rs`, `capabilities/default.json`, and
   `build.rs` only if the checker requires manifest coverage.
6. Add all `sync_ops_*`, `sync_*`, and `sync_attachments_*` commands to `realCommands`
   once generated bindings exist.
7. Visit each legacy mock mapping:
   - `sync_status` -> real command with same name.
   - `sync_trigger` -> `sync_ops_trigger_sync` or `sync_push_now`.
   - `sync_stats` -> `sync_ops_get_history` or delete if unused.
   - `sync_identity` -> `account_get_info` or a justified distinct shape.
   - `sync_enable` -> `sync_ops_pause` / `sync_ops_resume`.
   - `sync_pending_items` -> queue size and quarantined items.
   - `sync_reset` -> `sync_reset_cursor`.
   - `sync_ops_get_status` -> real command.
8. The mock file may not retain a route name with no real/deferred mapping after this
   phase.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri cargo:test -- --test commands_sync_ops_test
pnpm --filter @memry/desktop-tauri test -- src/contexts/sync-context.test.tsx
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
```

Expected: PASS for all M6 sync ops, sync controls, attachment commands, and mock
retirement mapping.

### Commit Rule

If Phase A left staged or unstaged ledger changes, include them in the first commit in
this phase that makes command parity green. Do not leave the branch in a known-failing
parity state.

### When Done

Report:

```text
Phase L complete.
Plan chunk: 12
Commits: <count> (<first hash>..<last hash>)
Mock retirement: <all rows mapped | remaining rows and why>
Verification: commands_sync_ops_test + sync-context test + bindings + capability + command parity
Next: Phase M - prompts/m6/m6-phase-m-runtime-e2e-staging.md
Blockers: <none | list>
```

## PROMPT END
