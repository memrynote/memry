# Body CRDT Sync E2E: Fixes And Flow Diagrams

This companion doc explains two things:

1. What the checklist implementation forced us to fix in the product and test harness.
2. What each sync case is actually doing, in a compact flow diagram.

Use this together with [2026-04-10-body-crdt-sync-e2e-checklist.md](/Users/h4yfans/.codex/worktrees/4429/memry/docs/superpowers/plans/2026-04-10-body-crdt-sync-e2e-checklist.md).

## Legend

- `A` = Device A
- `B` = Device B
- `Sync` = sync backend plus push/pull cycle
- `A=B` = both devices converge to the same final note body
- `||` = both sides act concurrently

## What We Fixed

### 1. Dual-device E2E infrastructure

We did not have a real two-device desktop E2E harness before this work.

Fixed in:

- [sync-fixtures.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/tests/e2e/fixtures/sync-fixtures.ts)
- [sync-auth-fixtures.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/tests/e2e/fixtures/sync-auth-fixtures.ts)
- [sync-backend.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/tests/e2e/utils/sync-backend.ts)
- [simulated-server.ts](/Users/h4yfans/.codex/worktrees/4429/memry/tests/sync-harness/src/simulated-server.ts)

What changed:

- `A` and `B` now run as truly separate desktop devices.
- Both devices can be bootstrapped into the same sync account without UI auth flows.
- The local sync backend is reachable over the real HTTP/WebSocket path that Electron uses.

### 2. Deterministic offline and sync control

The app previously depended on the main-process network monitor, which Playwright page-level offline toggles do not control.

Fixed in:

- [network.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/sync/network.ts)
- [test-hooks.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/test-hooks.ts)
- [network-control.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/tests/e2e/utils/network-control.ts)

What changed:

- Tests can force `offline` and `online` in Electron main deterministically.
- Tests can trigger sync manually and wait for real idle state instead of sleeping.

### 3. Stable note-body control for E2E

We needed reliable open/edit/read helpers that target the real CRDT-backed editor.

Fixed in:

- [App.tsx](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/renderer/src/App.tsx)
- [electron-helpers.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/tests/e2e/utils/electron-helpers.ts)
- [note-sync-helpers.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/tests/e2e/utils/note-sync-helpers.ts)

What changed:

- Tests can open a note by known title.
- Tests can replace or append body content deterministically.
- Tests can assert editor body, CRDT body, and persisted writeback body.

### 4. Create-propagation fix: empty CRDT docs could open blank

The receiver could have the note metadata and file, but still open an empty editor if the main-process CRDT doc already existed and had not been seeded.

Fixed in:

- [crdt-provider.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/sync/crdt-provider.ts)

What changed:

- If a CRDT doc exists but is still empty, opening the note seeds it from markdown instead of leaving the body blank.

### 5. Single-writer propagation fix: local CRDT updates were not pushed aggressively enough

After a successful local CRDT update batch, the sender path could lag before publishing the fresh state.

Fixed in:

- [runtime.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/sync/runtime.ts)
- [crdt-queue.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/sync/crdt-queue.ts)

What changed:

- The live sender path now pushes a fresh CRDT snapshot immediately after successful update batching.
- The E2E wait logic tracks real CRDT work, not just queue rows.

### 6. Reconnect fix: inactive markdown notes were not always re-pulled

On full sync after reconnect, body-only changes on notes that were not open could be missed.

Fixed in:

- [full-sync-runner.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/sync/engine/full-sync-runner.ts)
- [note-crud.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/database/queries/notes/note-crud.ts)
- [index.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/database/queries/notes/index.ts)

What changed:

- Full sync now queues CRDT pull follow-up for all local markdown notes, not only notes with a record-layer change or notes already open.

### 7. Same-note merge fix: renderer autosave raced CRDT ownership

When Yjs owned the body, renderer autosave could still try to persist direct body changes and race CRDT writeback.

Fixed in:

- [use-editor-sync.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/renderer/src/components/note/content-area/hooks/use-editor-sync.ts)
- [crdt-provider.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/sync/crdt-provider.ts)
- [crdt-writeback.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/sync/crdt-writeback.ts)

What changed:

- Renderer body autosave is disabled while CRDT mode owns the note body.
- Main-process writeback persists both IPC-origin and network-origin CRDT changes consistently.

### 8. Same-note merge fix: already-applied updates could be fetched again

After snapshot replacement, the pull coordinator could re-fetch updates it had already logically applied.

Fixed in:

- [crdt-sync-coordinator.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/sync/engine/crdt-sync-coordinator.ts)
- [crdt-sync-coordinator.test.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/sync/engine/crdt-sync-coordinator.test.ts)

What changed:

- The coordinator now tracks the highest applied sequence per note and avoids replaying stale updates.

### 9. Full-suite guard fix: full sync catch-up should not crash without index DB

The new full-sync CRDT catch-up path was additive, but one desktop unit test runs without an initialized index DB.

Fixed in:

- [client.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/database/client.ts)
- [full-sync-runner.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/desktop/src/main/sync/engine/full-sync-runner.ts)

What changed:

- Full sync now skips the index-backed CRDT sweep when the index DB is unavailable instead of throwing.

### 10. CI fix: sync-server tests must stay Worker-safe

The new sync-server CRDT test used Node `Buffer`, but the sync-server package typechecks under Worker types only.

Fixed in:

- [crdt.test.ts](/Users/h4yfans/.codex/worktrees/4429/memry/apps/sync-server/src/services/crdt.test.ts)

What changed:

- The test now uses `TextEncoder` and returns a real `ArrayBuffer`, which works under the sync-server TS environment and in CI.

## Flow Diagrams

These diagrams cover the sync scenarios from `C*`, `E*`, `D*`, `M*`, and `V*`.
`H*` items are harness tasks, so they are not modeled as user sync flows here.

## Phase 1: Create Propagation

`C1`  `A(off) create noteA --> A(on) push --> Sync store --> B(on) pull --> A=B(noteA)`

`C2`  `B(off) create noteB --> B(on) push --> Sync store --> A(on) pull --> A=B(noteB)`

`C3`  `A(on) create noteA --> Sync store --> B(off) later on --> B pull --> A=B(noteA)`

`C4`  `B(on) create noteB --> Sync store --> A(off) later on --> A pull --> A=B(noteB)`

## Phase 2: Single-Writer Edit Propagation

`E1`  `shared noteA --> A(off) edit own note --> A(on) push CRDT --> B pull/apply --> A=B(noteA)`

`E2`  `shared noteB --> B(off) edit own note --> B(on) push CRDT --> A pull/apply --> A=B(noteB)`

`E3`  `shared noteB --> A(off) edit peer note --> A(on) push CRDT --> B pull/apply --> A=B(noteB)`

`E4`  `shared noteA --> B(off) edit peer note --> B(on) push CRDT --> A pull/apply --> A=B(noteA)`

`E5`  `shared noteX --> A(on) edit --> Sync store --> B(off) later on --> B pull/apply --> A=B(noteX)`

`E6`  `shared noteX --> B(on) edit --> Sync store --> A(off) later on --> A pull/apply --> A=B(noteX)`

## Phase 3: Independent Edits On Different Notes

`D1`  `A(off) edit noteA || B(off) edit noteB --> both on --> Sync stores both --> both pull --> A=B(noteA,noteB)`

`D2`  `A(on) edit noteA --> Sync storeA || B(off) edit noteB --> B(on) push/pull --> A=B(noteA,noteB)`

`D3`  `B(on) edit noteB --> Sync storeB || A(off) edit noteA --> A(on) push/pull --> A=B(noteA,noteB)`

`D4`  `A(on) edit noteA || B(on) edit noteB --> Sync stores both --> both pull/apply --> A=B(noteA,noteB)`

## Phase 4: Concurrent Edits On The Same Note

`M1`  `shared noteX --> A(off) edit block1 || B(off) edit block2 --> reconnect --> Sync merge --> A=B(noteX)`

`M2`  `shared noteX --> A(off) edit same block pos1 || B(off) edit same block pos2 --> reconnect --> Sync merge --> A=B(noteX)`

`M3`  `shared noteX --> A(off) edit same exact range || B(off) edit same exact range --> reconnect --> deterministic merge --> A=B(noteX)`

`M4`  `shared noteX --> A(on) edit || B(off) edit --> B(on) sync --> Sync merge --> A=B(noteX)`

`M5`  `shared noteX --> B(on) edit || A(off) edit --> A(on) sync --> Sync merge --> A=B(noteX)`

`M6`  `shared noteX --> A(on) edit || B(on) edit --> Sync merge live --> A=B(noteX)`

`M7`  `shared noteB --> A edit noteB || B edit noteB --> Sync merge --> A=B(noteB)`

`M8`  `shared noteA --> B edit noteA || A edit noteA --> Sync merge --> A=B(noteA)`

## Phase 5: Coverage Variants

`V1`  `offline/offline same-note merge --> A reconnects first --> Sync gets A delta first --> B reconnects second --> final merge --> A=B`

`V2`  `offline/offline same-note merge --> B reconnects first --> Sync gets B delta first --> A reconnects second --> final merge --> A=B`

`V3`  `offline/offline same-note merge --> A and B reconnect together --> Sync receives both sides in one reconnect window --> A=B`

`V4`  `writer edits --> receiver already has note open --> sync arrives --> open editor updates live --> A=B`

`V5`  `writer edits --> receiver note closed --> sync arrives --> receiver reopens note --> reopened editor shows merged body --> A=B`

`V6`  `A(off) create noteA || B(off) create noteB --> both on sync --> both have noteA+noteB --> A edits noteB and noteA || B edits noteA and noteB --> Sync merge on both notes --> A=B(2 notes, 4 edits)`

## Short Version

The checklist did not just add tests. It exposed real sync correctness gaps in:

- note seeding
- reconnect pull behavior
- same-note merge ownership
- stale update replay protection
- test/runtime guards
- CI Worker-safe typing

That is why this branch contains both E2E tests and product fixes.
