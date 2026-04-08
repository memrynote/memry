# Architecture Reset Phase 05 - Sync Core Simplification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace feature-owned sync calls with a shared sync adapter model.

**Architecture:** Sync becomes a platform subsystem with one adapter contract per domain. Record-based domains use vector clocks; note document content remains CRDT-based. Feature modules stop calling queue and clock helpers directly.

**Tech Stack:** TypeScript, Electron main process, existing sync runtime and queue, vector clocks, Yjs CRDT

---

## File Map

- Create: `packages/sync-core/package.json`
- Create: `packages/sync-core/src/index.ts`
- Create: `packages/sync-core/src/adapter.ts`
- Create: `packages/sync-core/src/registry.ts`
- Create: `packages/sync-core/src/record-sync.ts`
- Create: `packages/sync-core/src/crdt-sync.ts`
- Modify: `apps/desktop/src/main/sync/runtime.ts`
- Modify: `apps/desktop/src/main/sync/engine.ts`
- Modify: `apps/desktop/src/main/sync/task-sync.ts`
- Modify: `apps/desktop/src/main/sync/inbox-sync.ts`
- Modify: `apps/desktop/src/main/sync/project-sync.ts`
- Modify: `apps/desktop/src/main/sync/settings-sync.ts`
- Modify: `apps/desktop/src/main/sync/note-sync.ts`
- Modify: `apps/desktop/src/main/sync/journal-sync.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/*.ts`

## Chunk 1: Sync Adapter Contract

### Task 1: Create `sync-core`

**Files:**
- Create: `packages/sync-core/package.json`
- Create: `packages/sync-core/src/index.ts`
- Create: `packages/sync-core/src/adapter.ts`
- Create: `packages/sync-core/src/registry.ts`
- Create: `packages/sync-core/src/record-sync.ts`
- Create: `packages/sync-core/src/crdt-sync.ts`

- [ ] Step 1: Define the adapter contract with methods for:
  - serialize local change
  - enqueue outbound mutation
  - apply remote mutation
  - resolve conflict policy
  - emit domain event
- [ ] Step 2: Define a separate CRDT adapter path for note document content only.
- [ ] Step 3: Keep record-sync generic so tasks, inbox, settings, projects, filters, reminders, and tag definitions can all use it.

## Chunk 2: Runtime Migration

### Task 2: Make sync runtime depend on adapters, not features

**Files:**
- Modify: `apps/desktop/src/main/sync/runtime.ts`
- Modify: `apps/desktop/src/main/sync/engine.ts`

- [ ] Step 1: Add an adapter registry that runtime and engine can consume.
- [ ] Step 2: Remove direct feature-specific initialization from the runtime over time.
- [ ] Step 3: Keep current runtime behavior stable while swapping internal dependencies to the adapter registry.

### Task 3: Migrate feature sync modules behind adapters

**Files:**
- Modify: task, inbox, project, settings, note, journal sync modules
- Modify: `apps/desktop/src/main/sync/item-handlers/*.ts`

- [ ] Step 1: Stop allowing feature code or IPC handlers to call queue/enqueue/clock helpers directly.
- [ ] Step 2: Route those operations through adapter-owned side effects.
- [ ] Step 3: Keep CRDT code isolated to note content and note-specific sync helpers.

## Chunk 3: Verification

### Task 4: Validate sync determinism

- [ ] Step 1: Run targeted sync tests for tasks, inbox, settings, projects, and notes.
- [ ] Step 2: Add coverage showing non-note domains use record sync while notes keep CRDT for document content.
- [ ] Step 3: Run `pnpm test` and document any pre-existing unrelated sync failures.

## Exit Criteria

- Sync runtime depends on registered adapters instead of direct feature-specific logic.
- Feature code no longer owns queue writes or offline clock increments.
- CRDT remains only on the note document path.

