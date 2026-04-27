# M6 Phase K - Attachments + Blob Sync

Fresh session prompt. This phase graduates note attachment and sync attachment commands
from deferred mocks to real encrypted blob upload/download/delete behavior.

---

## PROMPT START

You are implementing **Phase K of Milestone M6**. This phase executes Chunk 11 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-j-crdt-network-sync.md`

Phase K implements real attachment upload/download/list/delete for current note editor
calls and sync attachment calls. Durable resumable transfer UI can remain deferred; the
server chunk dedupe path must make retry safe.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_crdt_updates_test
pnpm --filter @memry/desktop-tauri cargo:check
```

If any command fails, STOP and report.

### Your Scope

Execute Chunk 11 in order:

- **Step 1:** Write attachment tests.
- **Step 2:** Implement upload service.
- **Step 3:** Implement manifest encryption/signing.
- **Step 4:** Implement attachment commands.
- **Step 5:** Graduate renderer routing.
- **Step 6:** Run focused gate.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `apps/desktop-tauri/src/lib/ipc/mocks/stubs/attachments.ts`
- `apps/desktop-tauri/src/lib/ipc/invoke.ts`
- `apps/desktop-tauri/src-tauri/src/db/note_metadata.rs`
- `apps/desktop-tauri/src-tauri/src/sync/client.rs`
- `apps/desktop-tauri/src-tauri/src/sync/crypto_batch.rs`
- `apps/sync-server/src/routes/blob.ts`
- `apps/sync-server/src/routes/sync.ts`
- `packages/contracts/src/blob-api.ts`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md` Chunk 11

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Write tests first and confirm RED:
   - `notes_upload_attachment` validates note id and file path.
   - empty file fails.
   - files over 500 MB fail before upload.
   - chunks are 8 MB max.
   - upload initiate -> chunk PUT -> complete writes note metadata `attachment_id` and
     `attachment_references`.
   - chunk 409 duplicate is resumable success.
   - download target stays under vault attachments folder.
   - progress events include attachmentId/sessionId/progress/status.
   - delete removes local metadata and calls server manifest/blob cleanup when
     authenticated.
3. Implement routes:
   - `/attachments/upload/initiate`
   - `/attachments/upload/:session_id/chunk/:chunk_index`
   - `/attachments/upload/:session_id/complete`
   - `/attachments/upload/:session_id`
   - chunk HEAD/GET routes.
4. Mirror Electron attachment manifest shape.
5. Wrap file keys with the vault key. Never persist plaintext file keys.
6. Implement commands:
   - `notes_upload_attachment`
   - `notes_list_attachments`
   - `notes_delete_attachment`
   - `sync_attachments_upload_attachment`
   - `sync_attachments_get_upload_progress`
   - `sync_attachments_download_attachment`
   - `sync_attachments_get_download_progress`
7. Remove the graduated note attachment commands from `DEFERRED_COMMANDS` and add them
   to `realCommands`.
8. Keep transfer progress process-local unless the plan is explicitly changed.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_attachments_test
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri command:parity
```

Expected: PASS for attachment commands. If global `command:parity` still fails for
ungenerated sync ops, record exact remaining names for Phase L.

### When Done

Report:

```text
Phase K complete.
Plan chunk: 11
Commits: <count> (<first hash>..<last hash>)
Verification: sync_attachments_test + bindings + command parity state
Next: Phase L - prompts/m6/m6-phase-l-sync-ops-renderer-wiring.md
Blockers: <none | list>
```

## PROMPT END
