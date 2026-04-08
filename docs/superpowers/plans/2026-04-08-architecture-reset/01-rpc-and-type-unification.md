# Architecture Reset Phase 01 - RPC And Type Unification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the handwritten preload/service surface with one generated RPC layer and canonical domain transport types.

**Architecture:** Add a new `packages/rpc` workspace package that defines commands, queries, and events. Generate thin renderer and preload bindings from that schema while keeping a small handwritten shell API for Electron-only concerns.

**Tech Stack:** TypeScript, Zod, Electron preload bridge, existing IPC generation flow

---

## File Map

- Create: `packages/rpc/package.json`
- Create: `packages/rpc/tsconfig.json`
- Create: `packages/rpc/src/index.ts`
- Create: `packages/rpc/src/tasks.ts`
- Create: `packages/rpc/src/notes.ts`
- Create: `packages/rpc/src/inbox.ts`
- Create: `packages/rpc/src/settings.ts`
- Create: `apps/desktop/scripts/generate-rpc-bindings.ts`
- Create: `apps/desktop/src/preload/generated-rpc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/renderer/src/services/tasks-service.ts`
- Modify: `apps/desktop/src/renderer/src/services/notes-service.ts`
- Modify: `apps/desktop/src/renderer/src/services/inbox-service.ts`
- Modify: `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts` or replace its role with the new generator

## Chunk 1: Canonical RPC Package

### Task 1: Create `packages/rpc`

**Files:**
- Create: `packages/rpc/package.json`
- Create: `packages/rpc/tsconfig.json`
- Create: `packages/rpc/src/index.ts`
- Create: `packages/rpc/src/tasks.ts`
- Create: `packages/rpc/src/notes.ts`
- Create: `packages/rpc/src/inbox.ts`
- Create: `packages/rpc/src/settings.ts`

- [ ] Step 1: Scaffold the package using the same workspace conventions as `packages/shared`.
- [ ] Step 2: Define transport-level shapes for commands, queries, and events for tasks, notes, inbox, and settings.
- [ ] Step 3: Use canonical entity types in this package instead of duplicating DTOs in renderer services.
- [ ] Step 4: Re-export the domain RPC definitions from `src/index.ts`.
- [ ] Step 5: Keep the package transport-focused; do not move domain logic into it.

### Task 2: Pick the canonical type owner per domain

**Files:**
- Modify: `packages/contracts/src/tasks-api.ts`
- Modify: `packages/contracts/src/notes-api.ts`
- Modify: `packages/contracts/src/inbox-api.ts`
- Modify: `packages/contracts/src/settings-schemas.ts`
- Create or modify: matching RPC files in `packages/rpc/src`

- [ ] Step 1: For each domain, decide whether `packages/contracts` remains the schema owner or whether `packages/rpc` becomes the new owner with `packages/contracts` re-exporting.
- [ ] Step 2: Do not keep parallel interfaces alive in both places.
- [ ] Step 3: Update one domain at a time, starting with tasks.
- [ ] Step 4: Remove duplicate renderer-side service interfaces once the canonical owner is in place.

## Chunk 2: Generated Bindings

### Task 3: Generate preload and renderer bindings

**Files:**
- Create: `apps/desktop/scripts/generate-rpc-bindings.ts`
- Create: `apps/desktop/src/preload/generated-rpc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`

- [ ] Step 1: Write a generator that consumes the canonical RPC definitions and emits typed invoke/event wrappers.
- [ ] Step 2: Keep manual preload code only for:
  - window controls
  - file-picker/file-drop helpers
  - protocol helpers
  - native notifications
- [ ] Step 3: Replace handwritten domain bridge methods in preload with generated bindings.
- [ ] Step 4: Keep the public `window.api` shape stable where possible for the first migration step.
- [ ] Step 5: Run the generation script and then `pnpm ipc:check`.

### Task 4: Migrate renderer services to thin wrappers or remove them

**Files:**
- Modify: `apps/desktop/src/renderer/src/services/tasks-service.ts`
- Modify: `apps/desktop/src/renderer/src/services/notes-service.ts`
- Modify: `apps/desktop/src/renderer/src/services/inbox-service.ts`

- [ ] Step 1: Remove duplicated DTO definitions in each service file.
- [ ] Step 2: Either replace each service with a tiny re-export/wrapper over the generated RPC client or delete the service layer entirely if the feature hooks can consume the generated client directly.
- [ ] Step 3: Keep event subscriptions typed through the generated layer instead of feature-specific ad hoc callbacks.
- [ ] Step 4: Verify the tasks vertical slice can use this surface before migrating notes and inbox.

## Chunk 3: Verification

### Task 5: Validate the contract migration

- [ ] Step 1: Run `pnpm ipc:generate` if the existing IPC map still exists during transition.
- [ ] Step 2: Run `pnpm ipc:check`.
- [ ] Step 3: Run `pnpm typecheck`.
- [ ] Step 4: Run focused tests for preload typings and any touched renderer services.

## Exit Criteria

- A `packages/rpc` package exists and owns the new generated RPC surface.
- Preload is primarily generated for domain APIs.
- Renderer services no longer define parallel domain DTOs for the migrated surfaces.
- New commands, queries, and events can be added in one canonical place.

