# M5 Phase M - Renderer Legacy CRDT + Contract Cleanup

Fresh session prompt. This phase removes legacy renderer CRDT aliases and rehomes
M5-owned renderer contracts.

---

## PROMPT START

You are implementing **Phase M of Milestone M5**. This phase executes plan Tasks
57-60 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-l-registration-devtools-bindings.md`

The real command surface is registered. Phase M removes the old renderer CRDT path and
prevents shared-package dependencies from leaking into the Tauri app for notes/CRDT.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri command:parity
rg "sync_crdt_|crdt-state-changed" apps/desktop-tauri/src || true
```

Legacy matches are expected at the start only if Phase M has not run yet.

### Your Scope

Execute Tasks 57-60 in order:

- **Task 57:** Replace legacy `sync_crdt_*` provider calls in
  `src/sync/yjs-ipc-provider.ts` and `use-yjs-collaboration.ts`; update tests.
- **Task 58:** Bind current `ContentArea` deliberately to the Rust-backed provider,
  including ready/error/not-ready test coverage.
- **Task 59:** Create narrow local contracts in `src/contracts/notes.ts` and
  `src/contracts/crdt.ts`; update imports away from touched `@memry/*` notes/CRDT
  surfaces.
- **Task 60:** Final mock router cleanup for all graduated M5 commands.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 57-60 fully before editing.
3. Do not keep two active CRDT provider implementations.
4. Move only M5-owned renderer types. Do not copy sync-server schemas or unrelated RPC
   contracts.
5. Real M5 commands must route to Rust; deferred commands must be ledgered.
6. Commit once per task.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

rg "sync_crdt_|crdt-state-changed" apps/desktop-tauri/src
# expected: no matches

rg "@memry/(contracts|rpc).*(notes|ipc-crdt)|@memry/rpc/notes|@memry/contracts/ipc-crdt" \
  apps/desktop-tauri/src
# expected: no matches unless every remaining hit is documented with an owner milestone

pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri test -- src/sync
pnpm --filter @memry/desktop-tauri test -- src/components/note/content-area
pnpm --filter @memry/desktop-tauri test -- src/lib/ipc
pnpm --filter @memry/desktop-tauri command:parity
```

### When Done

Report:

```text
Phase M complete.
Tasks covered: 57, 58, 59, 60
Commits: <count> (<first hash>..<last hash>)
Verification: no legacy CRDT aliases + typecheck + sync/content/ipc tests + parity
Next: Phase N - prompts/m5/m5-phase-n-runtime-e2e.md
Blockers: <none | list>
```

## PROMPT END
