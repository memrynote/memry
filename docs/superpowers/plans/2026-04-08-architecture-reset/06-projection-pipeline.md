# Architecture Reset Phase 06 - Projection Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move search, note-derived graph state, embeddings, and inbox stats out of inline feature mutations into a restart-safe projection runtime.

**Architecture:** Keep canonical writes in the domain and vault layers introduced by phases 02-05, then publish lightweight projection events into a main-process projection runtime under `apps/desktop/src/main/projections/`. Projectors own rebuildable state only: `note_cache`, `note_tags`, `note_links`, `note_properties`, `fts_notes`, `fts_tasks`, `fts_inbox`, `vec_notes`, and `inbox_stats`. Recovery comes from projector `rebuild` and `reconcile` entrypoints wired into startup and the existing rebuild actions, not from a second durable event log in this phase.

**Tech Stack:** TypeScript, Electron main process, better-sqlite3, Drizzle, sqlite-vec, existing vault/index/search helpers

---

## Scope Notes

- Keep the projection runtime in `apps/desktop/src/main`, not a new workspace package. It depends on Electron lifecycle, main-process DB handles, and existing rebuild IPC.
- Do not add a separate persisted graph table. The graph projection is the existing note-derived state in `note_cache`, `note_tags`, and `note_links`; `apps/desktop/src/main/database/queries/graph.ts` stays a read model over those tables.
- Remove SQLite FTS triggers once projector-owned updates exist. Trigger-based writes are still inline writes.
- Treat current helper queues (`database/fts-queue.ts`, `inbox/embedding-queue.ts`) as migration shims. They should end this phase as thin wrappers over the projection runtime or be deleted.
- If phase-02/03/04 packages already exist, publish projection events from those domain command surfaces first. If they do not, publish from the current compatibility entrypoints listed below and leave TODOs pointing back to those phases.

## File Map

- Create: `apps/desktop/src/main/projections/index.ts`
- Create: `apps/desktop/src/main/projections/types.ts`
- Create: `apps/desktop/src/main/projections/bus.ts`
- Create: `apps/desktop/src/main/projections/runtime.ts`
- Create: `apps/desktop/src/main/projections/projectors/note-derived-state-projector.ts`
- Create: `apps/desktop/src/main/projections/projectors/search-projector.ts`
- Create: `apps/desktop/src/main/projections/projectors/embedding-projector.ts`
- Create: `apps/desktop/src/main/projections/projectors/inbox-stats-projector.ts`
- Create: `apps/desktop/src/main/projections/runtime.test.ts`
- Create: projector-focused tests under `apps/desktop/src/main/projections/projectors/`
- Modify: `apps/desktop/src/main/vault/index.ts`
- Modify: `apps/desktop/src/main/vault/note-sync.ts`
- Modify: `apps/desktop/src/main/vault/indexer.ts`
- Modify: `apps/desktop/src/main/vault/watcher.ts`
- Modify: `apps/desktop/src/main/vault/notes.ts`
- Modify: `apps/desktop/src/main/ipc/journal-handlers.ts`
- Modify: `apps/desktop/src/main/sync/crdt-writeback.ts`
- Modify: `apps/desktop/src/main/database/index.ts`
- Modify: `apps/desktop/src/main/database/fts.ts`
- Modify: `apps/desktop/src/main/database/fts-tasks.ts`
- Modify: `apps/desktop/src/main/database/fts-inbox.ts`
- Modify: `apps/desktop/src/main/database/fts-queue.ts`
- Modify: `apps/desktop/src/main/database/fts-rebuild.ts`
- Modify: `apps/desktop/src/main/database/queries/graph.ts`
- Modify: `apps/desktop/src/main/inbox/embedding-queue.ts`
- Modify: `apps/desktop/src/main/inbox/suggestions.ts`
- Modify: `apps/desktop/src/main/inbox/stats.ts`
- Modify: `apps/desktop/src/main/inbox/capture.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-crud-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-batch-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/search-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/settings-handlers.ts`
- Modify: existing task/inbox/note domain command entrypoints from phases 02-05 if already present
- Test: `apps/desktop/src/main/vault/note-sync.test.ts`
- Test: `apps/desktop/src/main/vault/indexer.test.ts`
- Test: `apps/desktop/src/main/vault/watcher.test.ts`
- Test: `apps/desktop/src/main/database/fts-queue.test.ts`
- Test: `apps/desktop/src/main/ipc/search-handlers.test.ts`
- Test: `apps/desktop/src/main/inbox/stats.test.ts`

## Chunk 1: Projection Runtime

### Task 1: Add the projection runtime and event contract

**Files:**
- Create: `apps/desktop/src/main/projections/index.ts`
- Create: `apps/desktop/src/main/projections/types.ts`
- Create: `apps/desktop/src/main/projections/bus.ts`
- Create: `apps/desktop/src/main/projections/runtime.ts`
- Create: `apps/desktop/src/main/projections/runtime.test.ts`
- Modify: `apps/desktop/src/main/vault/index.ts`

- [ ] Step 1: Define a `ProjectionEvent` union that covers the actual derived-state owners in this repo:
  - note upsert
  - note delete
  - task upsert
  - task delete
  - inbox item upsert
  - inbox item delete
  - inbox item filed or unfiled
  - inbox item archived or unarchived
- [ ] Step 2: Define a projector contract with explicit methods for:
  - `handles(event)`
  - `project(event)`
  - `rebuild()`
  - `reconcile()` for missed deletes or stale rows
- [ ] Step 3: Keep publication synchronous and cheap. Publishing should only enqueue work in memory and schedule a drain.
- [ ] Step 4: Wire runtime startup and teardown into `vault/index.ts` so vault open initializes projectors and vault close drains or cancels pending work cleanly.
- [ ] Step 5: Write `apps/desktop/src/main/projections/runtime.test.ts` for:
  - fan-out to multiple projectors
  - per-projector isolation on failure
  - deterministic drain order
  - rebuild and reconcile dispatch

## Chunk 2: Note-Derived State

### Task 2: Move note cache, tags, properties, and links behind a note-derived-state projector

**Files:**
- Create: `apps/desktop/src/main/projections/projectors/note-derived-state-projector.ts`
- Modify: `apps/desktop/src/main/vault/note-sync.ts`
- Modify: `apps/desktop/src/main/vault/indexer.ts`
- Modify: `apps/desktop/src/main/vault/watcher.ts`
- Modify: `apps/desktop/src/main/vault/notes.ts`
- Modify: `apps/desktop/src/main/ipc/journal-handlers.ts`
- Modify: `apps/desktop/src/main/sync/crdt-writeback.ts`
- Modify: `apps/desktop/src/main/database/queries/graph.ts`
- Test: `apps/desktop/src/main/vault/note-sync.test.ts`
- Test: `apps/desktop/src/main/vault/indexer.test.ts`
- Test: `apps/desktop/src/main/vault/watcher.test.ts`

- [ ] Step 1: Split `vault/note-sync.ts` into:
  - pure extraction of metadata, links, tags, and properties
  - projector-owned persistence of `note_cache`, `note_tags`, `note_links`, and `note_properties`
- [ ] Step 2: Stop calling projection writes inline from the note write paths. `vault/notes.ts`, `ipc/journal-handlers.ts`, `vault/indexer.ts`, `vault/watcher.ts`, and `sync/crdt-writeback.ts` should publish note events instead.
- [ ] Step 3: Make the note projector responsible for delete cleanup that is currently scattered across `deleteNoteCache`, link cleanup, and watcher flows.
- [ ] Step 4: Keep `database/queries/graph.ts` read-only. It should continue reading `note_links` and `note_tags`, but no graph mutation code should remain outside the projector.
- [ ] Step 5: Add tests that prove idempotent replay for the same note event and correct cleanup on note delete or rename.

## Chunk 3: Search And Embeddings

### Task 3: Replace inline FTS updates and FTS triggers with a search projector

**Files:**
- Create: `apps/desktop/src/main/projections/projectors/search-projector.ts`
- Modify: `apps/desktop/src/main/database/index.ts`
- Modify: `apps/desktop/src/main/database/fts.ts`
- Modify: `apps/desktop/src/main/database/fts-tasks.ts`
- Modify: `apps/desktop/src/main/database/fts-inbox.ts`
- Modify: `apps/desktop/src/main/database/fts-queue.ts`
- Modify: `apps/desktop/src/main/database/fts-rebuild.ts`
- Modify: `apps/desktop/src/main/ipc/search-handlers.ts`
- Test: `apps/desktop/src/main/database/fts-queue.test.ts`
- Test: `apps/desktop/src/main/ipc/search-handlers.test.ts`

- [ ] Step 1: Remove the FTS triggers in `fts.ts`, `fts-tasks.ts`, and `fts-inbox.ts`, leaving table creation but moving all row maintenance into the search projector.
- [ ] Step 2: Teach the search projector to update:
  - `fts_notes` from note events
  - `fts_tasks` from task events
  - `fts_inbox` from inbox events
- [ ] Step 3: Make `database/fts-queue.ts` a compatibility shim around projector scheduling or delete it once callers are migrated.
- [ ] Step 4: Replace `rebuildAllIndexes()` with a projector-owned rebuild entrypoint that rebuilds notes, tasks, and inbox FTS from canonical stores and emits the same progress events used today.
- [ ] Step 5: Verify that `search:rebuild-index` still works through existing IPC without adding a new renderer contract.

### Task 4: Move embedding updates behind an embedding projector

**Files:**
- Create: `apps/desktop/src/main/projections/projectors/embedding-projector.ts`
- Modify: `apps/desktop/src/main/inbox/embedding-queue.ts`
- Modify: `apps/desktop/src/main/inbox/suggestions.ts`
- Modify: `apps/desktop/src/main/vault/notes.ts`
- Modify: `apps/desktop/src/main/vault/indexer.ts`
- Modify: `apps/desktop/src/main/vault/watcher.ts`
- Modify: `apps/desktop/src/main/ipc/journal-handlers.ts`
- Modify: `apps/desktop/src/main/sync/crdt-writeback.ts`
- Modify: `apps/desktop/src/main/ipc/settings-handlers.ts`

- [ ] Step 1: Stop calling `queueEmbeddingUpdate()` from feature code. Publish note upsert and delete events instead.
- [ ] Step 2: Let the embedding projector own `storeNoteEmbedding()`, `deleteNoteEmbedding()`, and the batching policy that currently lives in `embedding-queue.ts`.
- [ ] Step 3: Keep model loading and generation in `inbox/suggestions.ts` or a helper extracted from it, but remove projector orchestration from that module.
- [ ] Step 4: Route the existing settings reindex action through the embedding projector rebuild path.
- [ ] Step 5: Add replay coverage showing repeated note updates overwrite the embedding once and deletes remove orphaned vectors from `vec_notes`.

## Chunk 4: Inbox Stats And Recovery

### Task 5: Move inbox stats to a projector and wire startup recovery

**Files:**
- Create: `apps/desktop/src/main/projections/projectors/inbox-stats-projector.ts`
- Modify: `apps/desktop/src/main/inbox/stats.ts`
- Modify: `apps/desktop/src/main/inbox/capture.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-crud-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-batch-handlers.ts`
- Modify: `apps/desktop/src/main/vault/index.ts`
- Test: `apps/desktop/src/main/inbox/stats.test.ts`

- [ ] Step 1: Replace direct calls to `incrementProcessedCount()` and `incrementArchivedCount()` with projection events from inbox command flows.
- [ ] Step 2: Add capture events from current capture entrypoints so `captureCount*` finally comes from the same projection pipeline as the other stats.
- [ ] Step 3: Make `inbox/stats.ts` the read and rebuild surface for `inbox_stats`, not the write orchestrator.
- [ ] Step 4: On vault open, run projector `reconcile()` or `rebuild()` for any projection that can miss deletes or restart in the middle of a batch.
- [ ] Step 5: Keep existing stats IPC contracts stable while changing the write path under them.

## Chunk 5: Verification

### Task 6: Validate replay, rebuild, and no-inline-write invariants

**Files:**
- Test: `apps/desktop/src/main/projections/runtime.test.ts`
- Test: projector tests under `apps/desktop/src/main/projections/projectors/`
- Test: `apps/desktop/src/main/vault/note-sync.test.ts`
- Test: `apps/desktop/src/main/vault/indexer.test.ts`
- Test: `apps/desktop/src/main/vault/watcher.test.ts`
- Test: `apps/desktop/src/main/database/fts-queue.test.ts`
- Test: `apps/desktop/src/main/ipc/search-handlers.test.ts`
- Test: `apps/desktop/src/main/inbox/stats.test.ts`

- [ ] Step 1: Add focused tests for projector replay and idempotency.
Run: `pnpm --filter @memry/desktop test -- apps/desktop/src/main/projections`
Expected: PASS

- [ ] Step 2: Re-run the existing note indexing and search handler suites against the new pipeline.
Run: `pnpm --filter @memry/desktop test -- apps/desktop/src/main/vault/indexer.test.ts apps/desktop/src/main/vault/watcher.test.ts apps/desktop/src/main/ipc/search-handlers.test.ts`
Expected: PASS

- [ ] Step 3: Re-run inbox stats coverage after replacing direct counter writes.
Run: `pnpm --filter @memry/desktop test -- apps/desktop/src/main/inbox/stats.test.ts`
Expected: PASS

- [ ] Step 4: Run the phase verification bar.
Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm ipc:check`
Expected: PASS, or only pre-existing unrelated failures documented in the PR

## Exit Criteria

- No feature or IPC handler path performs direct FTS, embedding, or inbox-stats writes.
- `note_cache`, `note_tags`, `note_links`, and `note_properties` are owned by a projector, not by note command handlers.
- FTS triggers are removed and replaced by projector-owned maintenance.
- Search rebuild and embedding reindex both execute through projector rebuild entrypoints.
- Projection state can be replayed or reconciled after restart without losing canonical note, task, or inbox data.
