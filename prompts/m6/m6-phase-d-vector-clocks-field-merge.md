# M6 Phase D - Vector Clocks + Field Merge

Fresh session prompt. This phase ports the deterministic vector-clock and field-level
merge rules used by sync handlers.

---

## PROMPT START

You are implementing **Phase D of Milestone M6**. This phase executes Chunk 4 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-c-queue-retry-state-history.md`

Phase D implements pure sync merge logic. It does not touch handlers, queue wiring, or
network code.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_queue_test --test sync_retry_test
pnpm --filter @memry/desktop-tauri cargo:check
```

If any command fails, STOP and report.

### Your Scope

Execute Chunk 4 in order:

- **Step 1:** Write vector-clock tests.
- **Step 2:** Write field-merge tests.
- **Step 3:** Implement vector-clock helpers.
- **Step 4:** Implement `merge_fields`.
- **Step 5:** Run focused gate.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `apps/desktop/src/main/sync/field-merge.ts`
- `packages/contracts/src/sync-api.ts`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md` Chunk 4

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Write tests first and confirm RED:
   - vector-clock before/after/equal/concurrent.
   - merge takes max tick per device.
   - `_offline` pseudo-device is accepted and can be rebound before push.
   - invalid JSON returns validation error, not panic.
   - task title local and due date remote both survive.
   - concurrent same-field conflict reports `had_conflicts`.
   - project field clocks use the project syncable field list.
   - calendar field clocks preserve rich fields.
3. Keep DB-boundary JSON as `serde_json::Map<String, Value>`.
4. Use typed `BTreeMap<String, u64>` inside sync code for deterministic output.
5. Port Electron `field-merge.ts` behavior:
   - remote wins when remote total is greater.
   - local wins when local total is greater.
   - equal totals prefer remote except offline-local changed value.
   - concurrent differing values report conflict and merged clock.
6. Do not invent new conflict policy in this phase. Preserve existing semantics unless
   tests prove the Electron behavior no longer matches contracts.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_vector_clock_test
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_field_merge_test
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_vector_clock_test --test sync_field_merge_test
```

Expected: PASS.

### When Done

Report:

```text
Phase D complete.
Plan chunk: 4
Commits: <count> (<first hash>..<last hash>)
Verification: sync_vector_clock_test + sync_field_merge_test
Next: Phase E - prompts/m6/m6-phase-e-crypto-batch-device-keys.md
Blockers: <none | list>
```

## PROMPT END
