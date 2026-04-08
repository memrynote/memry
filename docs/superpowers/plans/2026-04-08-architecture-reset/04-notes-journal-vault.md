# Architecture Reset Phase 04 - Notes, Journal, And Vault Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified note domain that separates canonical note state, vault-backed content, and rebuildable projection state.

**Architecture:** Today note and journal behavior is split across vault helpers, IPC handlers, sync handlers, `data.db`, and `index.db`. This phase introduces a single note aggregate with `journalDate` as a mode flag, moves durable note state out of `index.db`, and keeps `index.db` limited to rebuildable search/graph/property projections behind an explicit bridge so phase 06 can replace the bridge with workers later.

**Tech Stack:** TypeScript, Electron main process, Drizzle, better-sqlite3, filesystem vault operations, gray-matter/frontmatter parsing, Yjs CRDT sync, existing note/journal renderer surfaces

---

## Current State To Replace

- `apps/desktop/src/main/vault/notes.ts` mixes filesystem I/O, metadata persistence, snapshots, sync enqueueing, embedding queue writes, and renderer event concerns.
- `apps/desktop/src/main/ipc/journal-handlers.ts` and `apps/desktop/src/main/ipc/properties-handlers.ts` still own note/journal business rules and repopulate `note_cache` directly.
- `packages/db-schema/src/schema/notes-cache.ts` currently stores both rebuildable projection data and durable user state:
  - `localOnly`
  - sync clock / synced markers
  - attachment IDs for synced binary files
  - version history snapshots
  - tag pin state via `note_tags.pinnedAt`
  - property-definition cache
- `data.db` already owns `note_positions` and `tag_definitions`, so this phase should extend that boundary instead of inventing a third note-state store.

## Phase Guardrails

- Keep existing note/journal IPC channel names stable. This phase is an internal boundary reset, not a renderer rewrite.
- Keep vault files authoritative for markdown/journal body content.
- Keep `.memry/properties.md` authoritative for property-definition source data in this phase.
- Do not implement the full projection-worker architecture from phase 06 here. Use a temporary event/bridge layer so behavior stays stable while ownership moves.

## File Map

- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Create: `packages/domain-notes/package.json`
- Create: `packages/domain-notes/tsconfig.json`
- Create: `packages/domain-notes/src/index.ts`
- Create: `packages/domain-notes/src/types.ts`
- Create: `packages/domain-notes/src/events.ts`
- Create: `packages/domain-notes/src/commands.ts`
- Create: `packages/domain-notes/src/queries.ts`
- Create: `packages/storage-vault/package.json`
- Create: `packages/storage-vault/tsconfig.json`
- Create: `packages/storage-vault/src/index.ts`
- Create: `packages/storage-vault/src/note-content-store.ts`
- Create or modify: `packages/storage-data/package.json`
- Create or modify: `packages/storage-data/tsconfig.json`
- Create or modify: `packages/storage-data/src/index.ts`
- Create: `packages/storage-data/src/note-metadata-repository.ts`
- Modify: `packages/db-schema/src/data-schema.ts`
- Modify: `packages/db-schema/src/index-schema.ts`
- Modify: `packages/db-schema/src/schema/index.ts`
- Create: `packages/db-schema/src/schema/note-metadata.ts`
- Modify: `packages/db-schema/src/schema/notes-cache.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/note-crud.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/tag-queries.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/property-queries.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/journal-queries.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/snapshot-queries.ts`
- Modify: `apps/desktop/src/main/vault/notes.ts`
- Modify: `apps/desktop/src/main/vault/journal.ts`
- Modify: `apps/desktop/src/main/vault/note-sync.ts`
- Modify: `apps/desktop/src/main/vault/property-definitions.ts`
- Modify: `apps/desktop/src/main/vault/indexer.ts`
- Modify: `apps/desktop/src/main/vault/watcher.ts`
- Modify: `apps/desktop/src/main/ipc/notes-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/journal-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/properties-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/tags-handlers.ts`
- Modify: `apps/desktop/src/main/sync/note-sync.ts`
- Modify: `apps/desktop/src/main/sync/journal-sync.ts`
- Modify: `apps/desktop/src/main/sync/crdt-writeback.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/note-handler.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/journal-handler.ts`
- Modify: `apps/desktop/src/main/vault/notes.test.ts`
- Modify: `apps/desktop/src/main/vault/journal.test.ts`
- Modify: `apps/desktop/src/main/vault/note-sync.test.ts`
- Modify: `apps/desktop/src/main/vault/indexer.test.ts`
- Modify: `apps/desktop/src/main/ipc/notes-handlers.test.ts`
- Modify: `apps/desktop/src/main/ipc/journal-handlers.test.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/note-handler.test.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/note-handler-binary.test.ts`
- Create if needed: `apps/desktop/src/main/sync/item-handlers/journal-handler.test.ts`

## Chunk 1: Durable State Split

### Task 1: Move durable note state into `data.db`

**Files:**
- Modify: `packages/db-schema/src/data-schema.ts`
- Modify: `packages/db-schema/src/schema/index.ts`
- Create: `packages/db-schema/src/schema/note-metadata.ts`
- Create or modify: `packages/storage-data/package.json`
- Create or modify: `packages/storage-data/tsconfig.json`
- Create or modify: `packages/storage-data/src/index.ts`
- Create: `packages/storage-data/src/note-metadata-repository.ts`

- [ ] Step 1: Add canonical note metadata storage in `data.db` for fields that must survive an `index.db` rebuild:
  - `id`
  - canonical `path`
  - `title`
  - `fileType`
  - `mimeType`
  - `fileSize`
  - `localOnly`
  - `journalDate`
  - `attachmentId`
  - `createdAt`
  - `modifiedAt`
- [ ] Step 2: Move durable sync ownership out of `note_cache` and into canonical storage:
  - sync policy
  - vector clock
  - synced-at marker
- [ ] Step 3: Move non-rebuildable user state out of `index.db`:
  - note snapshots / version history
  - note tag pin state
  - any note-only durable flags that cannot be reconstructed from vault files
- [ ] Step 4: Reuse existing `note_positions` and `tag_definitions` tables in `data.db` instead of duplicating ordering or tag-color state elsewhere.
- [ ] Step 5: Make rename/move updates atomic from the repository point of view so note metadata and `note_positions` stay in sync even if the table remains path-keyed in this phase.
- [ ] Step 6: Expose repository methods around note use-cases instead of raw table access:
  - load by id
  - load by path
  - load by journal date
  - upsert metadata
  - rename / move
  - set local-only / sync state
  - list and restore snapshots
  - pin / unpin tags

### Task 2: Demote `index.db` to projection ownership only

**Files:**
- Modify: `packages/db-schema/src/index-schema.ts`
- Modify: `packages/db-schema/src/schema/notes-cache.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/note-crud.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/tag-queries.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/property-queries.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/journal-queries.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/snapshot-queries.ts`
- Modify: `apps/desktop/src/main/vault/property-definitions.ts`

- [ ] Step 1: Stop treating `note_cache` as canonical for `localOnly`, sync clocks, synced markers, attachment IDs, or snapshot ownership.
- [ ] Step 2: Keep only rebuildable note/journal projections in `index.db`:
  - snippets
  - word and character counts
  - content hashes
  - extracted tags
  - extracted frontmatter properties
  - resolved links / graph edges
  - FTS rows and embeddings
  - journal heatmap and yearly stats derived from projections
- [ ] Step 3: Split durable tag pin state from extracted tag membership so `note_tags` can remain a rebuildable extraction table.
- [ ] Step 4: Keep `.memry/properties.md` authoritative and treat any `property_definitions` table usage as a rebuildable query cache only.
- [ ] Step 5: Leave enough projection tables in place for existing note and journal list/query behavior to keep working until phase 06 replaces the temporary bridge.

## Chunk 2: Unified Note Domain

### Task 3: Create `domain-notes` and `storage-vault`

**Files:**
- Create: `packages/domain-notes/package.json`
- Create: `packages/domain-notes/tsconfig.json`
- Create: `packages/domain-notes/src/index.ts`
- Create: `packages/domain-notes/src/types.ts`
- Create: `packages/domain-notes/src/events.ts`
- Create: `packages/domain-notes/src/commands.ts`
- Create: `packages/domain-notes/src/queries.ts`
- Create: `packages/storage-vault/package.json`
- Create: `packages/storage-vault/tsconfig.json`
- Create: `packages/storage-vault/src/index.ts`
- Create: `packages/storage-vault/src/note-content-store.ts`
- Modify: `package.json`
- Modify: `apps/desktop/package.json`

- [ ] Step 1: Define a single note aggregate with optional `journalDate` instead of separate note and journal domain models.
- [ ] Step 2: Define command entrypoints for the durable operations the main process actually owns:
  - create
  - update
  - delete
  - rename
  - move
  - set tags / properties
  - set local-only / sync metadata
  - create / restore snapshot
  - pin / unpin tag
- [ ] Step 3: Define query entrypoints for current renderer use-cases without exposing storage layout:
  - note detail
  - note list / folders
  - note by path
  - binary-file lookup
  - journal entry by date
  - journal month / year / heatmap views
  - version history
  - tag drill-down
- [ ] Step 4: Put markdown, journal, and binary file reads/writes behind `storage-vault`; keep parsing, serialization, and path helpers there instead of in the domain package.
- [ ] Step 5: Keep renderer-facing DTOs separate from repository and vault-storage structs so IPC contracts stay stable while internals change.
- [ ] Step 6: Wire the new package manifests into the workspace and app dependencies so `typecheck` and desktop builds actually include the new packages.

### Task 4: Turn vault modules and IPC handlers into adapters

**Files:**
- Modify: `apps/desktop/src/main/vault/notes.ts`
- Modify: `apps/desktop/src/main/vault/journal.ts`
- Modify: `apps/desktop/src/main/ipc/notes-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/journal-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/properties-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/tags-handlers.ts`
- Modify: `apps/desktop/src/main/vault/property-definitions.ts`

- [ ] Step 1: Move mutation orchestration out of `vault/notes.ts` and `journal-handlers.ts` into `domain-notes`.
- [ ] Step 2: Reduce `vault/notes.ts` and `vault/journal.ts` to filesystem adapters only:
  - path resolution
  - read / write / delete
  - parse / serialize
  - open / reveal / import helpers
- [ ] Step 3: Route property updates through the note domain instead of branching on `note_cache.date` inside handlers.
- [ ] Step 4: Route tag pinning through canonical note state instead of mutating `note_tags.pinnedAt` directly from handlers.
- [ ] Step 5: Keep `properties.md` read/write behind a service or storage adapter consumed by the domain, not by handler-level query code.
- [ ] Step 6: Preserve existing IPC channel names and result shapes while removing direct `getIndexDatabase()` orchestration from handler business logic.

## Chunk 3: Sync And Projection Bridge

### Task 5: Separate canonical writes from projection refresh

**Files:**
- Modify: `apps/desktop/src/main/vault/note-sync.ts`
- Modify: `apps/desktop/src/main/vault/indexer.ts`
- Modify: `apps/desktop/src/main/vault/watcher.ts`
- Modify: `apps/desktop/src/main/sync/note-sync.ts`
- Modify: `apps/desktop/src/main/sync/journal-sync.ts`
- Modify: `apps/desktop/src/main/sync/crdt-writeback.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/note-handler.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/journal-handler.ts`

- [ ] Step 1: Make note and journal create/update/delete flows write vault content plus canonical note metadata first.
- [ ] Step 2: Publish explicit note-domain events from canonical operations:
  - `noteChanged`
  - `noteDeleted`
  - `noteSnapshotCreated`
  - `noteTagPinChanged`
- [ ] Step 3: Hang the current projection refresh behavior off a temporary bridge subscriber instead of doing inline cache, link, property, FTS, and embedding writes inside the core command path.
- [ ] Step 4: Keep separate note and journal sync wire payloads if that reduces churn, but map both onto the same note aggregate and canonical repository.
- [ ] Step 5: Store sync clocks and synced markers on canonical state so deleting or rebuilding `index.db` does not break sync correctness.
- [ ] Step 6: Ensure indexer and watcher can rebuild projections from vault files plus canonical metadata without inventing snapshots, tag pins, or sync state.

## Chunk 4: Verification

### Task 6: Prove `index.db` is rebuildable without losing note behavior

**Files:**
- Modify: `apps/desktop/src/main/vault/notes.test.ts`
- Modify: `apps/desktop/src/main/vault/journal.test.ts`
- Modify: `apps/desktop/src/main/vault/note-sync.test.ts`
- Modify: `apps/desktop/src/main/vault/indexer.test.ts`
- Modify: `apps/desktop/src/main/ipc/notes-handlers.test.ts`
- Modify: `apps/desktop/src/main/ipc/journal-handlers.test.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/note-handler.test.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/note-handler-binary.test.ts`
- Create if needed: `apps/desktop/src/main/sync/item-handlers/journal-handler.test.ts`

- [ ] Step 1: Update targeted unit tests for note creation, updates, rename/move, journal entry writes, and projection refresh behavior.
- [ ] Step 2: Add coverage for durable state that must survive an `index.db` rebuild:
  - local-only flags
  - sync clocks / synced markers
  - snapshots
  - tag pin state
  - journal metadata
- [ ] Step 3: Extend rebuild coverage in `apps/desktop/src/main/vault/indexer.test.ts` or a new dedicated test so it:
  - seeds notes and journal entries
  - seeds snapshots and tag pins
  - destroys or recreates `index.db`
  - reindexes the vault
  - verifies canonical state survived and projections were repopulated
- [ ] Step 4: Run targeted E2E smoke coverage for notes, journal, and vault if the boundary shift causes integration regressions.
- [ ] Step 5: If IPC surfaces or generated invoke maps changed, run `pnpm ipc:generate`.
- [ ] Step 6: Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm ipc:check`.

## Exit Criteria

- Notes and journal share one aggregate model keyed by note identity plus optional `journalDate`.
- Canonical note state lives outside `index.db`.
  - metadata
  - sync state
  - snapshots
  - tag pin state
- Vault files remain authoritative for note and journal body content.
- `.memry/properties.md` remains authoritative for property-definition source data.
- `index.db` can be deleted and rebuilt without losing durable note behavior.
