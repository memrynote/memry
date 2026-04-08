# Architecture Reset Phase 04 - Notes, Journal, And Vault Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified note domain that separates canonical metadata, vault-backed content, and projection-backed derived state.

**Architecture:** Notes and journal become one aggregate model. Canonical note metadata moves into `data.db`, vault files remain authoritative for note body content, and `index.db` is reduced to rebuildable projection state.

**Tech Stack:** TypeScript, Electron main process, Drizzle, filesystem vault operations, Yjs CRDT, existing note/journal UI

---

## File Map

- Create: `packages/domain-notes/package.json`
- Create: `packages/domain-notes/src/index.ts`
- Create: `packages/domain-notes/src/commands.ts`
- Create: `packages/domain-notes/src/queries.ts`
- Create: `packages/storage-vault/package.json`
- Create: `packages/storage-vault/src/index.ts`
- Create: `packages/storage-vault/src/note-content-store.ts`
- Create: `packages/storage-data/src/note-metadata-repository.ts`
- Modify: `packages/db-schema/src/data-schema.ts`
- Modify: note-related schema files if canonical note metadata needs a new table
- Modify: `apps/desktop/src/main/vault/notes.ts`
- Modify: `apps/desktop/src/main/vault/journal.ts`
- Modify: `apps/desktop/src/main/ipc/notes-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/journal-handlers.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/note-handler.ts`
- Modify: `apps/desktop/src/main/sync/journal-sync.ts`

## Chunk 1: Canonical Note Metadata

### Task 1: Add canonical note metadata to `data.db`

**Files:**
- Modify: `packages/db-schema/src/data-schema.ts`
- Create or modify: a note metadata schema file under `packages/db-schema/src/schema/`
- Create: `packages/storage-data/src/note-metadata-repository.ts`

- [ ] Step 1: Define canonical note metadata fields:
  - id
  - canonical path
  - local-only flag
  - sync policy
  - journal date
  - attachment references
  - property-definition references as needed
- [ ] Step 2: Keep derived fields such as snippet, embeddings, backlinks, graph edges, and FTS tokens out of this store.
- [ ] Step 3: Add a repository layer that the note domain can call without touching projection tables.

## Chunk 2: Unified Note Domain

### Task 2: Create `domain-notes` and `storage-vault`

**Files:**
- Create: `packages/domain-notes/package.json`
- Create: `packages/domain-notes/src/index.ts`
- Create: `packages/domain-notes/src/commands.ts`
- Create: `packages/domain-notes/src/queries.ts`
- Create: `packages/storage-vault/package.json`
- Create: `packages/storage-vault/src/index.ts`
- Create: `packages/storage-vault/src/note-content-store.ts`

- [ ] Step 1: Define a single note aggregate that can represent journal entries via a `journalDate` field instead of a parallel subsystem.
- [ ] Step 2: Put file-content reads/writes behind `storage-vault`.
- [ ] Step 3: Put metadata and property-definition rules behind `domain-notes`.
- [ ] Step 4: Keep renderer-facing query shapes separate from internal storage details.

### Task 3: Refactor vault and journal entrypoints

**Files:**
- Modify: `apps/desktop/src/main/vault/notes.ts`
- Modify: `apps/desktop/src/main/vault/journal.ts`
- Modify: `apps/desktop/src/main/ipc/notes-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/journal-handlers.ts`

- [ ] Step 1: Move business rules out of vault helper files where appropriate and into `domain-notes`.
- [ ] Step 2: Keep `vault/notes.ts` and `vault/journal.ts` focused on file-system adapters only if they survive this phase.
- [ ] Step 3: Turn the IPC handlers into transport adapters that call the note domain.
- [ ] Step 4: Remove any direct projection/cache updates from handler flows.

## Chunk 3: Sync And Projection Preparation

### Task 4: Separate note writes from projection updates

**Files:**
- Modify: `apps/desktop/src/main/sync/item-handlers/note-handler.ts`
- Modify: `apps/desktop/src/main/sync/journal-sync.ts`
- Modify: any note cache/index update helpers used inline today

- [ ] Step 1: Make note sync operate on canonical note metadata and note content, not projection tables.
- [ ] Step 2: Treat journal as the same domain with different query semantics.
- [ ] Step 3: Emit note-domain events for later projection rebuilding instead of performing projection writes inline.

## Chunk 4: Verification

### Task 5: Validate canonical-vs-projection split

- [ ] Step 1: Run targeted note, journal, and vault tests.
- [ ] Step 2: Add a rebuild test that drops or reconstructs `index.db` and verifies canonical note metadata survives.
- [ ] Step 3: Run `pnpm typecheck` and `pnpm test`.

## Exit Criteria

- Notes and journal share one domain model.
- Canonical note metadata lives in `data.db`.
- Vault files remain authoritative for content.
- `index.db` is no longer the owner of canonical note state.

