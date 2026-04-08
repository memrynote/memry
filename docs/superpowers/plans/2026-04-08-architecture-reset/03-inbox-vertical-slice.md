# Architecture Reset Phase 03 - Inbox Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert inbox into a domain-owned command/query/job pipeline with durable enrichment state.

**Architecture:** Keep the current inbox feature set, but split the system into synchronous commands and asynchronous enrichment jobs. The UI consumes typed inbox queries and job-status projections instead of understanding background work internals.

**Tech Stack:** TypeScript, Electron main process jobs, React, TanStack Query, Drizzle, existing inbox capture/transcription infrastructure

---

## File Map

- Create: `packages/domain-inbox/package.json`
- Create: `packages/domain-inbox/src/index.ts`
- Create: `packages/domain-inbox/src/commands.ts`
- Create: `packages/domain-inbox/src/queries.ts`
- Create: `packages/domain-inbox/src/jobs.ts`
- Create: `packages/storage-data/src/inbox-repository.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-query-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-crud-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-batch-handlers.ts`
- Modify: `apps/desktop/src/main/inbox/capture.ts`
- Modify: `apps/desktop/src/main/inbox/transcription.ts`
- Modify: `apps/desktop/src/main/inbox/suggestions.ts`
- Modify: `apps/desktop/src/renderer/src/pages/inbox.tsx`
- Modify: `apps/desktop/src/renderer/src/hooks/use-inbox.ts`
- Create: `apps/desktop/src/renderer/src/features/inbox/use-inbox-jobs.ts`

## Chunk 1: Domain And Job Model

### Task 1: Create the inbox domain package

**Files:**
- Create: `packages/domain-inbox/package.json`
- Create: `packages/domain-inbox/src/index.ts`
- Create: `packages/domain-inbox/src/commands.ts`
- Create: `packages/domain-inbox/src/queries.ts`
- Create: `packages/domain-inbox/src/jobs.ts`
- Create: `packages/storage-data/src/inbox-repository.ts`

- [ ] Step 1: Define canonical inbox entities and command result types.
- [ ] Step 2: Define synchronous commands:
  - capture
  - file
  - snooze
  - archive/unarchive
  - undo
  - convert-to-task
- [ ] Step 3: Define durable job types:
  - transcription
  - metadata scrape
  - duplicate detection
  - suggestion generation
  - thumbnail generation
- [ ] Step 4: Add repository methods that expose job state explicitly instead of hiding it in feature code.

## Chunk 2: Main-Process Refactor

### Task 2: Separate capture acceptance from enrichment jobs

**Files:**
- Modify: `apps/desktop/src/main/inbox/capture.ts`
- Modify: `apps/desktop/src/main/inbox/transcription.ts`
- Modify: `apps/desktop/src/main/inbox/suggestions.ts`

- [ ] Step 1: Make capture acceptance store the item and enqueue background jobs without blocking on enrichment.
- [ ] Step 2: Persist job state so restarts can resume or retry work safely.
- [ ] Step 3: Ensure job processors update inbox state through domain commands or repository methods, not direct ad hoc patches.
- [ ] Step 4: Keep existing duplicate-handling behavior stable from the user's perspective.

### Task 3: Turn inbox IPC modules into adapters

**Files:**
- Modify: `apps/desktop/src/main/ipc/inbox-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-query-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-crud-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-batch-handlers.ts`

- [ ] Step 1: Route IPC requests to domain-inbox command/query entrypoints.
- [ ] Step 2: Remove business logic from handler files, leaving validation, result formatting, and event bridging only.
- [ ] Step 3: Add explicit result shapes for operations like file, snooze, archive, undo, and convert-to-task.

## Chunk 3: Renderer Migration

### Task 4: Replace enrichment-aware UI branching with typed job status queries

**Files:**
- Modify: `apps/desktop/src/renderer/src/hooks/use-inbox.ts`
- Create: `apps/desktop/src/renderer/src/features/inbox/use-inbox-jobs.ts`
- Modify: `apps/desktop/src/renderer/src/pages/inbox.tsx`

- [ ] Step 1: Add query hooks for inbox items, health/stats, and job status.
- [ ] Step 2: Make the UI consume typed status such as `pending`, `running`, `failed`, `complete` instead of inferring work from scattered fields.
- [ ] Step 3: Keep the triage and list-view UX intact while simplifying the state flow.

## Chunk 4: Verification

### Task 5: Validate restart safety and inbox behavior

- [ ] Step 1: Run targeted inbox main-process tests.
- [ ] Step 2: Add or update tests for job restart/resume behavior.
- [ ] Step 3: Run focused renderer tests for inbox list, triage, undo, and duplicate handling.
- [ ] Step 4: Run `pnpm typecheck` and `pnpm test`.

## Exit Criteria

- Inbox acceptance is synchronous and durable.
- Enrichment work is modeled as durable jobs.
- Inbox handlers are adapters, not business-logic owners.
- The UI consumes typed job status instead of understanding background implementation details.

