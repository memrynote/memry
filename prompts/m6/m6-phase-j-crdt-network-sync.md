# M6 Phase J - CRDT Network Sync

Fresh session prompt. This phase connects the M5 local CRDT runtime to the sync-server
CRDT endpoints without changing the local IPC binary discipline.

---

## PROMPT START

You are implementing **Phase J of Milestone M6**. This phase executes Chunk 10 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-i-websocket-listener.md`

Phase J uses base64 JSON over network CRDT routes. Keep M5 local Tauri CRDT IPC binary
behavior unchanged.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_ws_test
pnpm --filter @memry/desktop-tauri cargo:check
```

If any command fails, STOP and report.

### Your Scope

Execute Chunk 10 in order:

- **Step 1:** Write CRDT sync tests.
- **Step 2:** Implement CRDT cursor state.
- **Step 3:** Implement CRDT push.
- **Step 4:** Implement CRDT pull.
- **Step 5:** Implement seed existing CRDT.
- **Step 6:** Run focused gate.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `apps/desktop-tauri/src-tauri/src/crdt/*`
- `apps/desktop-tauri/src-tauri/src/db/crdt_updates.rs`
- `apps/desktop-tauri/src-tauri/src/db/crdt_snapshots.rs`
- `apps/desktop-tauri/src-tauri/src/sync/engine.rs`
- `apps/sync-server/src/services/crdt.ts`
- `apps/sync-server/src/routes/sync.ts`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md` Chunk 10

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Write tests first and confirm RED:
   - local pending updates POST to `/sync/crdt/updates` as base64 and persist returned
     sequence.
   - remote update pull applies to M5 `CrdtRuntime`.
   - batch pull handles 100 notes with independent cursors.
   - snapshot push uploads current encoded doc and does not prune unconfirmed local
     updates.
   - sign-out/sign-in preserves local CRDT rows and resumes cursor.
   - network payload over 5 MB is rejected before send.
3. Use `sync_state` keys `crdt_cursor:<note_id>`.
4. Persist a cursor only after all updates for that note apply.
5. If M5 `crdt_updates` lacks `synced_at` or server sequence metadata, add the smallest
   migration and DB helpers before pushing. Stop if safe exactly-once metadata needs a
   larger schema decision.
6. Pull updates through existing M5 CRDT apply internals or a narrow new internal helper.
7. Do not re-emit local-origin updates back to renderer as duplicates.
8. Seed existing CRDT docs asynchronously after initial record pull. Errors become sync
   history error rows and `crdt-sync-step` events, not engine crashes.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_crdt_updates_test
```

Expected: PASS.

### When Done

Report:

```text
Phase J complete.
Plan chunk: 10
Commits: <count> (<first hash>..<last hash>)
Verification: sync_crdt_updates_test
Next: Phase K - prompts/m6/m6-phase-k-attachments-blob-sync.md
Blockers: <none | list>
```

## PROMPT END
