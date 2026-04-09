# Memry Architecture Reset Checklist

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current hybrid architecture on `main` into the target architecture without losing shipping momentum or breaking existing user-visible behavior.

**Architecture:** Keep the foundations that already exist on `main` and finish the migration phase by phase. Each phase removes one class of structural duplication or coupling before the next phase is allowed to start, so the system converges toward domain-owned commands, adapter-driven sync, and projection-only derived state instead of handler-driven orchestration.

**Tech Stack:** Electron, React, TanStack Query, Drizzle ORM, better-sqlite3, Zod, Yjs, Cloudflare Workers, Turborepo

---

## Status Legend

- `[x]` already present on `main`
- `[ ]` still required

## Audit Snapshot

Last audited against `main` on 2026-04-09.

- [x] Generated RPC definitions and bindings exist in `packages/rpc` and `apps/desktop/src/preload/generated-rpc.ts`
- [x] Task domain and repository foundations exist in `packages/domain-tasks` and `packages/storage-data`
- [x] Canonical note metadata foundation exists in `packages/domain-notes` and `packages/storage-data`
- [x] Vault content store foundation exists in `packages/storage-vault`
- [x] Sync adapter registry and record/CRDT split exist in `packages/sync-core` and `apps/desktop/src/main/sync/runtime.ts`
- [x] Projection runtime exists in `apps/desktop/src/main/projections`
- [x] Sync server already exposes distinct record and CRDT route groups
- [ ] `pnpm ipc:check` currently passes on `main`
- [ ] IPC handlers are thin transport adapters across tasks, inbox, and notes
- [ ] Renderer uses one canonical model per domain instead of UI-specific duplicates
- [ ] Inbox has a domain package and domain-owned command/query/job boundary
- [ ] Notes and journal are unified under one real domain aggregate
- [ ] `index.db` is projection-only in practice, not just by intent

## Global Execution Rules

- [ ] Do not start a later phase until the current phase gate is green.
- [ ] Keep each branch or PR scoped to one phase, unless a phase must be split further.
- [ ] Preserve current user-facing behavior unless the phase explicitly calls for a behavior change.
- [ ] Prefer strangler migrations over rewrites.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:architecture`, `pnpm check:contracts`, and `pnpm ipc:check` at the end of every phase.
- [ ] If a phase changes RPC definitions or preload bindings, also run `pnpm ipc:generate`.
- [ ] Do not weaken guardrails to get a phase merged. Tighten them as migrations land.

## Phase 0: Foundations And Guardrails

**Purpose:** Make the intended architecture enforceable before doing more migration work.

**Current foundation on `main`:**

- [x] `scripts/check-architecture-boundaries.js` exists
- [x] `scripts/check-contract-boundaries.js` exists
- [x] `DataDb` and `IndexDb` types exist in `apps/desktop/src/main/database/types.ts`

**Checklist:**

- [x] Fix the current baseline failure so `pnpm ipc:check` passes on `main`
- [x] Resolve `typescript` module lookup for `apps/desktop/scripts/generate-ipc-invoke-map.js`
- [x] Remove the transitional `DrizzleDb` alias from `apps/desktop/src/main/database/types.ts`
- [x] Update remaining legacy call sites to use `DataDb` or `IndexDb` explicitly
- [x] Reduce the IPC query allowlist in `scripts/check-architecture-boundaries.js` to zero
- [x] Add a blocked-pattern rule so IPC handlers cannot import direct DB query modules
- [x] Add a blocked-pattern rule so feature code cannot call sync services directly
- [x] Add a blocked-pattern rule so canonical writes cannot go through `index.db`
- [x] Ensure CI runs `check:architecture`, `check:contracts`, and `ipc:check`

Progress note (2026-04-09):
- `scripts/check-architecture-boundaries.js` now hard-fails direct IPC query imports and direct IPC sync-module imports, with the Phase 0 IPC allowlist removed entirely.
- Canonical note and journal compatibility writes now sit behind dedicated vault/sync adapters, and `check:architecture` now hard-fails feature imports of `vault/note-sync` or other note-cache write modules.
- `apps/desktop/package.json` now repairs stale workspace package links before lint/typecheck/test/dev/build, so desktop verification no longer depends on the removed `run-package-bin.js` shim.
- `apps/desktop/electron.vite.config.ts` now bundles the internal workspace packages the desktop app imports at runtime, so `pnpm dev` no longer fails on raw workspace TypeScript module loading.
- Full Phase 0 verification is green on this branch: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:architecture`, `pnpm check:contracts`, and `pnpm ipc:check` all pass.

**Gate:**

- [x] `pnpm ipc:check` passes
- [x] `pnpm check:architecture` passes without allowlisted IPC query imports
- [x] No new code uses the transitional DB alias

## Phase 1: RPC And Type Unification

**Purpose:** Finish the transition from mixed preload/service APIs to one canonical transport surface.

**Current foundation on `main`:**

- [x] `packages/rpc/src/index.ts` defines RPC domains
- [x] `apps/desktop/src/preload/generated-rpc.ts` is generated from RPC definitions
- [x] `apps/desktop/src/preload/index.ts` mounts generated RPC APIs

**Checklist:**

- [ ] Keep the generated RPC path as the only domain API pattern for new work
- [ ] Replace remaining handwritten preload domain methods with generated RPC where possible
- [ ] Restrict handwritten preload APIs to Electron-shell-only concerns
- [ ] Remove duplicate renderer service DTO definitions when they match canonical RPC entities
- [ ] Collapse transport-specific wrappers in renderer services that only forward to `window.api`
- [ ] Define the single source of truth for entity and command/result types per domain
- [ ] Ensure new commands, queries, and events are added once in `packages/rpc` and generated outward

Progress note (2026-04-09):
- `apps/desktop/src/renderer/src/services/tasks-service.ts`, `apps/desktop/src/renderer/src/services/notes-service.ts`, and `apps/desktop/src/renderer/src/services/inbox-service.ts` now proxy the generated `window.api` RPC clients through one shared `window-api-forwarder.ts` helper instead of maintaining manual transport passthrough objects.
- `packages/rpc/src/inbox.ts` now exports the canonical inbox item/action/status type aliases used by the domain RPC surface, and a focused renderer slice now imports task, note, and inbox entities from `@memry/rpc/*` instead of `apps/desktop/src/preload/index.d.ts`.
- `pnpm ipc:generate`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:architecture`, `pnpm check:contracts`, and `pnpm ipc:check` are green on this branch after this slice.
- Phase 1 remains incomplete: `apps/desktop/src/preload/index.ts` still exposes a large handwritten non-shell API surface, and renderer code still has remaining `preload/index.d.ts` imports plus direct `window.api.tasks` / `window.api.notes` / `window.api.inbox` usage outside the service layer.

**Key files:**

- `packages/rpc/src/index.ts`
- `packages/rpc/src/tasks.ts`
- `packages/rpc/src/notes.ts`
- `packages/rpc/src/inbox.ts`
- `apps/desktop/src/preload/generated-rpc.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/services/tasks-service.ts`
- `apps/desktop/src/renderer/src/services/notes-service.ts`
- `apps/desktop/src/renderer/src/services/inbox-service.ts`

**Gate:**

- [ ] Preload exposes generated domain RPC plus a small handwritten shell API only
- [ ] Renderer no longer defines parallel DTO shapes where canonical RPC types already exist

## Phase 2: Tasks Vertical Slice

**Purpose:** Make tasks the first complete feature migrated to the new architecture.

**Current foundation on `main`:**

- [x] `packages/domain-tasks` exists
- [x] `packages/storage-data/src/tasks-repository.ts` exists
- [x] `apps/desktop/src/main/ipc/tasks-handlers.ts` already creates a domain object
- [x] TanStack Query hooks exist in `apps/desktop/src/renderer/src/features/tasks/use-task-queries.ts`

**Checklist:**

- [ ] Remove durable task and project orchestration from `apps/desktop/src/renderer/src/App.tsx`
- [ ] Delete the compatibility `TasksProvider` once its consumers move to feature-local hooks
- [ ] Move renderer task selection, drag state, dialogs, and temporary filters into UI-only state
- [ ] Converge on one canonical task, project, and status model
- [ ] Remove task-specific UI/domain mapping layers that only rename or reshape equivalent concepts
- [ ] Move reorder and drag side effects fully into the tasks feature boundary
- [ ] Remove direct sync calls from `apps/desktop/src/main/ipc/tasks-handlers.ts`
- [ ] Remove direct projection calls from `apps/desktop/src/main/ipc/tasks-handlers.ts`
- [ ] Keep business rules in `packages/domain-tasks` and persistence in `packages/storage-data`

**Key files:**

- `packages/domain-tasks/src/index.ts`
- `packages/domain-tasks/src/commands.ts`
- `packages/domain-tasks/src/queries.ts`
- `packages/storage-data/src/tasks-repository.ts`
- `apps/desktop/src/main/ipc/tasks-handlers.ts`
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/contexts/tasks/index.tsx`
- `apps/desktop/src/renderer/src/features/tasks/use-task-queries.ts`

**Gate:**

- [ ] `App.tsx` does not own durable task/project state
- [ ] `TasksProvider` is removed or reduced to pure UI-only compatibility with no domain orchestration
- [ ] Tasks handlers are transport plus validation only

## Phase 3: Inbox Vertical Slice

**Purpose:** Move inbox from a handler-driven feature to a domain-owned ingestion pipeline.

**Current foundation on `main`:**

- [x] Inbox jobs, capture helpers, and query/batch helper modules already exist
- [x] Renderer already uses TanStack Query in inbox flows

**Checklist:**

- [x] Create `packages/domain-inbox`
- [x] Define canonical inbox entities, commands, queries, events, and job records
- [ ] Move capture acceptance, dedupe, enrich, suggest, triage, file, archive, and snooze rules into the inbox domain
- [x] Move job-state semantics out of IPC handlers and into domain job records
- [x] Remove direct DB writes from `apps/desktop/src/main/ipc/inbox-handlers.ts`
- [x] Remove direct sync calls from `apps/desktop/src/main/ipc/inbox-handlers.ts`
- [x] Remove direct projection calls from `apps/desktop/src/main/ipc/inbox-handlers.ts`
- [ ] Keep handlers as adapters that validate input and dispatch domain commands

Progress note (2026-04-09):
- Added `packages/domain-inbox` with canonical inbox entities, command/query contracts, event shapes, and durable job record types, plus focused domain-command tests for dedupe, social capture enrichment, link filing validation, and retry job orchestration.
- Added `apps/desktop/src/main/inbox/domain.ts` as the desktop adapter layer for the new inbox domain commands. It now owns text/link/image capture persistence, social metadata storage, retry-state resets, and the shared inbox handler dependency wiring that used to live directly in `ipc/inbox-handlers.ts`.
- `apps/desktop/src/main/ipc/inbox-handlers.ts` now registers transport handlers against the inbox domain surface instead of doing direct DB writes or calling sync/projection helpers inline.
- Phase 3 remains intentionally incomplete on this branch: CRUD, batch, and query handler modules still contain inbox-specific persistence/orchestration, and archive/snooze/query boundaries are not yet fully moved behind `packages/domain-inbox`.

**Key files:**

- `apps/desktop/src/main/ipc/inbox-handlers.ts`
- `apps/desktop/src/main/ipc/inbox-crud-handlers.ts`
- `apps/desktop/src/main/ipc/inbox-batch-handlers.ts`
- `apps/desktop/src/main/ipc/inbox-query-handlers.ts`
- `apps/desktop/src/main/inbox/jobs/*`
- `apps/desktop/src/renderer/src/hooks/use-inbox*.ts`
- `apps/desktop/src/renderer/src/features/inbox/*`

**Gate:**

- [ ] `packages/domain-inbox` owns inbox command/query/job boundaries
- [ ] Inbox handlers are adapters only
- [ ] Renderer consumes enrichment state through typed query results instead of handler-specific transitions

## Phase 4: Notes, Journal, And Vault

**Purpose:** Finish the notes architecture so vault content, canonical metadata, and derived projections are cleanly separated.

**Current foundation on `main`:**

- [x] Canonical note metadata lives in `packages/domain-notes` and `packages/storage-data`
- [x] Vault content store exists in `packages/storage-vault`
- [x] Journal already uses the storage-vault content store

**Checklist:**

- [ ] Expand `packages/domain-notes` from metadata helpers into the real notes and journal domain boundary
- [ ] Unify notes and journal under one aggregate model
- [ ] Move note rename, move, local-only, sync policy, and property-definition rules behind note domain services
- [ ] Move vault file operations behind the note domain and storage-vault abstractions
- [ ] Remove direct index/cache mutation from note write paths
- [ ] Replace compatibility code in `apps/desktop/src/main/vault/note-sync.ts` with domain events plus projectors
- [ ] Remove direct sync and CRDT orchestration from `apps/desktop/src/main/ipc/notes-handlers.ts` where it belongs behind adapters
- [ ] Ensure note body content remains vault-authoritative and structured metadata remains data-db-authoritative

**Key files:**

- `packages/domain-notes/src/commands.ts`
- `packages/domain-notes/src/queries.ts`
- `packages/storage-data/src/note-metadata-repository.ts`
- `packages/storage-vault/src/note-content-store.ts`
- `apps/desktop/src/main/ipc/notes-handlers.ts`
- `apps/desktop/src/main/vault/note-sync.ts`
- `apps/desktop/src/main/vault/notes.ts`
- `apps/desktop/src/main/vault/journal.ts`

**Gate:**

- [ ] Notes and journal share one domain model
- [ ] `index.db` can be dropped and rebuilt without losing canonical note or journal state
- [ ] Note write paths do not mutate projections inline

## Phase 5: Sync-Core Simplification

**Purpose:** Make sync adapter-driven instead of feature-driven.

**Current foundation on `main`:**

- [x] `packages/sync-core` exists
- [x] `RecordSyncController` exists
- [x] Runtime adapter registry exists in `apps/desktop/src/main/sync/runtime.ts`
- [x] CRDT is already limited to note content in runtime wiring

**Checklist:**

- [x] Keep the adapter registry as the only extension point for domain sync integration
- [ ] Stop calling `enqueue*` and offline clock helpers from handlers, watchers, and feature modules
- [x] Move queue writes, clock increments, and recovery bookkeeping behind adapters only
- [x] Keep notes on CRDT content sync only
- [ ] Keep tasks, inbox, settings, projects, reminders, saved filters, and tags on record sync only
- [ ] Align all domains with a common adapter contract: serialize local change, enqueue outbound mutation, apply remote mutation, resolve conflict policy, emit domain event

**Key files:**

- `packages/sync-core/src/adapter.ts`
- `packages/sync-core/src/registry.ts`
- `packages/sync-core/src/record-sync.ts`
- `apps/desktop/src/main/sync/runtime.ts`
- `apps/desktop/src/main/sync/task-sync.ts`
- `apps/desktop/src/main/sync/project-sync.ts`
- `apps/desktop/src/main/sync/inbox-sync.ts`
- `apps/desktop/src/main/sync/*`

**Gate:**

- [x] Domain code no longer calls sync queue services directly
- [x] Sync runtime depends on adapters, not feature modules

## Phase 6: Projection Pipeline

**Purpose:** Make search, graph, embeddings, and stats recoverable derived state.

**Current foundation on `main`:**

- [x] Projection runtime exists
- [x] Projectors already exist for several derived concerns

**Checklist:**

- [ ] Route all feature writes through domain events rather than inline projection updates
- [ ] Move FTS updates, graph edge updates, embeddings, and stats into projector code only
- [ ] Add rebuild coverage for each projector
- [ ] Add reconcile coverage for each projector
- [ ] Make crash recovery and full rebuild paths explicit and tested

**Key files:**

- `apps/desktop/src/main/projections/runtime.ts`
- `apps/desktop/src/main/projections/index.ts`
- `apps/desktop/src/main/projections/projectors/*`
- `apps/desktop/src/main/vault/note-sync.ts`
- `apps/desktop/src/main/vault/index.ts`

**Gate:**

- [ ] Feature write paths do not update projections inline
- [ ] Search and graph correctness can be recovered by replay or rebuild

## Phase 7: Sync Server Alignment

**Purpose:** Match the server to the final client sync model.

**Current foundation on `main`:**

- [x] Record transport routes exist
- [x] CRDT routes exist separately
- [x] Sync telemetry distinguishes record and CRDT transport

**Checklist:**

- [ ] Align payload validation with the final adapter contracts
- [ ] Align conflict semantics with the final client-side domain model
- [ ] Ensure record-sync and CRDT metrics remain separate by transport and domain type
- [ ] Remove legacy route shapes only after all clients use the final split

**Key files:**

- `apps/sync-server/src/routes/sync.ts`
- `apps/sync-server/src/services/sync.ts`
- `apps/sync-server/src/services/crdt.ts`
- `apps/sync-server/src/services/sync-telemetry.ts`

**Gate:**

- [ ] Record-sync and CRDT are separate in validation, metrics, and conflict handling end to end
- [ ] Client and server contracts agree domain by domain

## Cross-Cutting Cleanup

- [ ] Decide whether `packages/domain-settings` is needed and create it if settings continue to bypass the domain-package layout
- [ ] Decide whether reminders belong inside tasks or a separate domain boundary and finish that migration before broad cleanup
- [ ] Remove renderer-local domain orchestration patterns that survive individual phase work
- [ ] Delete dead compatibility layers only after their replacement paths are fully green
- [ ] Keep the checklist updated as phases land so this file remains the source of truth

## Suggested Branch Order

- [ ] `arch/phase-00-guardrails`
- [ ] `arch/phase-01-rpc`
- [ ] `arch/phase-02-tasks`
- [ ] `arch/phase-03-inbox`
- [ ] `arch/phase-04-notes`
- [ ] `arch/phase-05-sync-core`
- [ ] `arch/phase-06-projections`
- [ ] `arch/phase-07-server-alignment`

## Verification Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm check:architecture
pnpm check:contracts
pnpm ipc:check
```

If a phase changes RPC definitions or preload bindings, also run:

```bash
pnpm ipc:generate
```
