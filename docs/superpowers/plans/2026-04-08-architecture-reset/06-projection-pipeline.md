# Architecture Reset Phase 06 - Projection Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move FTS, graph, embeddings, and analytics updates out of feature write paths into a restart-safe projection pipeline.

**Architecture:** Introduce a main-process event bus and one or more projection workers that subscribe to domain events. Canonical writes emit events; projections consume them asynchronously and can rebuild or replay from canonical state.

**Tech Stack:** TypeScript, Electron main process, SQLite, existing FTS/embedding/graph code, queue or worker helpers as needed

---

## File Map

- Create: `packages/projections/package.json`
- Create: `packages/projections/src/index.ts`
- Create: `packages/projections/src/event-bus.ts`
- Create: `packages/projections/src/fts-projector.ts`
- Create: `packages/projections/src/graph-projector.ts`
- Create: `packages/projections/src/embeddings-projector.ts`
- Create: `packages/projections/src/analytics-projector.ts`
- Modify: `apps/desktop/src/main/database/fts.ts`
- Modify: `apps/desktop/src/main/database/fts-inbox.ts`
- Modify: `apps/desktop/src/main/lib/embeddings.ts`
- Modify: note graph/backlink helpers as needed
- Modify: domain write paths introduced in earlier phases so they emit events instead of mutating projections inline

## Chunk 1: Event Bus

### Task 1: Create the internal projection event bus

**Files:**
- Create: `packages/projections/src/event-bus.ts`
- Modify: domain packages from earlier phases to publish events

- [ ] Step 1: Define event envelopes for:
  - note metadata changed
  - note content changed
  - task changed
  - inbox item changed
  - reminder triggered
- [ ] Step 2: Keep publication synchronous and lightweight.
- [ ] Step 3: Let projectors own the heavy work.

## Chunk 2: Projectors

### Task 2: Add projectors for FTS, graph, embeddings, and analytics

**Files:**
- Create: `packages/projections/src/fts-projector.ts`
- Create: `packages/projections/src/graph-projector.ts`
- Create: `packages/projections/src/embeddings-projector.ts`
- Create: `packages/projections/src/analytics-projector.ts`
- Modify: existing FTS, embeddings, and graph helpers

- [ ] Step 1: Wrap existing projection logic so it can consume domain events.
- [ ] Step 2: Remove direct projector calls from feature/domain write paths.
- [ ] Step 3: Add replay or rebuild entrypoints so projections can recover from stale or deleted indexes.

## Chunk 3: Verification

### Task 3: Validate replay and rebuild behavior

- [ ] Step 1: Add or update tests for idempotent replay.
- [ ] Step 2: Add a rebuild scenario for `index.db` and derived projections.
- [ ] Step 3: Run targeted projection tests plus `pnpm test`.

## Exit Criteria

- Search, graph, embeddings, and stats are no longer updated inline by feature write paths.
- Projection workers consume domain events.
- Projection state can be replayed or rebuilt from canonical state.

