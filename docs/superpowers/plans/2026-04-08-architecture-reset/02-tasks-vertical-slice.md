# Architecture Reset Phase 02 - Tasks Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move tasks, projects, statuses, and reminders onto the new domain/query architecture and remove renderer-owned task orchestration.

**Architecture:** Introduce a `domain-tasks` package plus a `storage-data` repository layer. The renderer consumes feature-local query hooks and a small UI-only store; IPC handlers become transport adapters into the task domain.

**Tech Stack:** TypeScript, React, TanStack Query, Electron IPC/RPC, Drizzle, better-sqlite3

---

## File Map

- Create: `packages/domain-tasks/package.json`
- Create: `packages/domain-tasks/tsconfig.json`
- Create: `packages/domain-tasks/src/index.ts`
- Create: `packages/domain-tasks/src/types.ts`
- Create: `packages/domain-tasks/src/commands.ts`
- Create: `packages/domain-tasks/src/queries.ts`
- Create: `packages/storage-data/package.json`
- Create: `packages/storage-data/src/tasks-repository.ts`
- Modify: `apps/desktop/src/main/ipc/tasks-handlers.ts`
- Modify: `apps/desktop/src/renderer/src/contexts/tasks/index.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/tasks.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Create: `apps/desktop/src/renderer/src/features/tasks/use-task-queries.ts`
- Create: `apps/desktop/src/renderer/src/features/tasks/use-task-ui-store.ts`

## Chunk 1: Domain And Repository

### Task 1: Create the task domain package

**Files:**
- Create: `packages/domain-tasks/package.json`
- Create: `packages/domain-tasks/tsconfig.json`
- Create: `packages/domain-tasks/src/index.ts`
- Create: `packages/domain-tasks/src/types.ts`
- Create: `packages/domain-tasks/src/commands.ts`
- Create: `packages/domain-tasks/src/queries.ts`

- [ ] Step 1: Define canonical entities:
  - `Task`
  - `Project`
  - `Status`
  - `Reminder`
- [ ] Step 2: Define command entrypoints:
  - create/update/delete
  - reorder/move
  - complete/uncomplete
  - archive/unarchive
  - convert-to-subtask / convert-to-task
- [ ] Step 3: Define query entrypoints:
  - list
  - today/upcoming/overdue
  - stats
  - project/status lookups
- [ ] Step 4: Keep this package free of Electron-specific code.

### Task 2: Add the task repository layer

**Files:**
- Create: `packages/storage-data/package.json`
- Create: `packages/storage-data/src/tasks-repository.ts`
- Modify: existing database query modules if they remain the implementation

- [ ] Step 1: Wrap the current task/project/status query modules behind a repository interface.
- [ ] Step 2: Make the domain package depend on repository interfaces, not query-file imports.
- [ ] Step 3: Keep repository methods shaped around domain use-cases, not raw table access.
- [ ] Step 4: Include methods for linked notes, tags, subtask counts, and reminder scheduling metadata.

## Chunk 2: IPC And Sync Boundaries

### Task 3: Turn `tasks-handlers.ts` into an adapter

**Files:**
- Modify: `apps/desktop/src/main/ipc/tasks-handlers.ts`

- [ ] Step 1: Move business rules out of the handler file and into the task domain.
- [ ] Step 2: Leave Zod validation, result translation, and event emission coordination in the handler adapter only.
- [ ] Step 3: Replace direct query usage in handlers with calls into `domain-tasks`.
- [ ] Step 4: Keep current channel names stable during the migration.
- [ ] Step 5: Mark any remaining direct DB access with a TODO tied to this phase if removal cannot happen in one PR.

### Task 4: Pull task sync coupling behind the domain

**Files:**
- Modify: `apps/desktop/src/main/ipc/tasks-handlers.ts`
- Modify: task sync wiring modules only as needed

- [ ] Step 1: Stop letting handler code decide whether to enqueue sync or increment offline clocks directly.
- [ ] Step 2: Route task mutation side effects through a domain-level change publisher, even if it still delegates to existing sync code in this phase.
- [ ] Step 3: Keep the external task behavior unchanged.

## Chunk 3: Renderer Migration

### Task 5: Replace `TasksProvider` orchestration

**Files:**
- Modify: `apps/desktop/src/renderer/src/contexts/tasks/index.tsx`
- Create: `apps/desktop/src/renderer/src/features/tasks/use-task-queries.ts`
- Create: `apps/desktop/src/renderer/src/features/tasks/use-task-ui-store.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/tasks.tsx`

- [ ] Step 1: Move durable task/project loading into TanStack Query hooks.
- [ ] Step 2: Reduce `TasksProvider` to either:
  - a compatibility shell during migration, or
  - remove it entirely if the hooks and UI store cover the use-cases
- [ ] Step 3: Keep only ephemeral UI state in the client store:
  - selection
  - open dialogs/drawers
  - drag state
  - temporary filter controls
- [ ] Step 4: Remove `App.tsx` ownership of task and project arrays.
- [ ] Step 5: Change task page updates to invalidate/refetch or apply typed optimistic updates instead of custom provider patch graphs.

## Chunk 4: Verification

### Task 6: Run full task-surface verification

- [ ] Step 1: Run targeted main tests for task handlers and task sync.
- [ ] Step 2: Run targeted renderer tests for the tasks page, task detail drawer, and task shortcuts.
- [ ] Step 3: Run `pnpm typecheck`.
- [ ] Step 4: Run `pnpm test`.

## Exit Criteria

- `App.tsx` no longer owns durable task/project arrays.
- `tasks-handlers.ts` is primarily transport and validation code.
- The renderer task surface uses feature-local queries plus a small UI-only store.
- Task domain types are canonical and reused across RPC and renderer.

