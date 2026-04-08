# Architecture Reset Phase 01 - RPC And Type Unification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `packages/contracts` the single source of truth for the `tasks`, `notes`, `inbox`, and `settings` transport surface, then generate preload bindings from that source instead of maintaining parallel DTOs in preload and renderer services.

**Architecture:** Keep `@memry/contracts` as the canonical transport package for this phase instead of introducing a second `packages/rpc` workspace. Phase 00 already protects `packages/contracts`, every current desktop tsconfig alias points at it, and the desktop app already imports it everywhere. Add the missing API modules and parity gaps there, introduce a small declarative preload-binding manifest for the four phase domains, and generate preload wrappers from that manifest while keeping the existing `generated-ipc-invoke-map.ts` alive for untouched domains.

**Tech Stack:** TypeScript, Zod, Electron preload bridge, Node 24 `--experimental-strip-types`, existing `ipc:generate` / `ipc:check` flow

**Roadmap:** `docs/superpowers/plans/2026-04-08-architecture-reset/README.md`

---

## File Map

- Modify: `packages/contracts/package.json`
- Modify: `packages/contracts/src/tasks-api.ts`
- Modify: `packages/contracts/src/notes-api.ts`
- Modify: `packages/contracts/src/inbox-api.ts`
- Modify: `packages/contracts/src/settings-schemas.ts`
- Create: `packages/contracts/src/settings-api.ts`
- Create: `packages/contracts/src/preload-bindings.ts`
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/scripts/generate-rpc-bindings.ts`
- Create: `apps/desktop/src/preload/generated-rpc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/main/preload-types.test.ts`
- Modify: `apps/desktop/src/renderer/src/services/tasks-service.ts`
- Modify: `apps/desktop/src/renderer/src/services/tasks-service.test.ts`
- Modify: `apps/desktop/src/renderer/src/services/notes-service.ts`
- Modify: `apps/desktop/src/renderer/src/services/notes-service.test.ts`
- Modify: `apps/desktop/src/renderer/src/services/inbox-service.ts`
- Modify: `apps/desktop/src/renderer/src/services/inbox-service.test.ts`

## Chunk 1: Canonical Contract Surface

### Task 1: Make `packages/contracts` the canonical owner for phase-domain RPC

**Files:**
- Modify: `packages/contracts/package.json`
- Modify: `packages/contracts/src/tasks-api.ts`
- Modify: `packages/contracts/src/notes-api.ts`
- Modify: `packages/contracts/src/inbox-api.ts`
- Modify: `packages/contracts/src/settings-schemas.ts`
- Create: `packages/contracts/src/settings-api.ts`
- Create: `packages/contracts/src/preload-bindings.ts`

- [ ] **Step 1: Keep Phase 01 inside `packages/contracts`**

Do not create `packages/rpc` in this phase. Phase 00's boundary checker, the current tsconfig path aliases, and the desktop package dependencies already treat `@memry/contracts` as the transport boundary. Adding a second canonical package now would create a migration inside the migration.

- [ ] **Step 2: Promote `tasks-api.ts` from schema-only to full transport contract**

Expand `packages/contracts/src/tasks-api.ts` so it owns the public tasks surface currently split across:
- `packages/contracts/src/ipc-channels.ts`
- `apps/desktop/src/preload/index.d.ts`
- `apps/desktop/src/renderer/src/services/tasks-service.ts`

It should define:
- request schemas and inferred inputs
- response DTOs
- project/status DTOs
- task event payloads
- handler signatures
- `TasksClientAPI`

Match the existing public methods in preload/service:
- task CRUD
- project/status CRUD
- bulk operations
- stats/today/upcoming/overdue
- linked-task lookups

- [ ] **Step 3: Bring `notes-api.ts` to full parity with `NotesChannels`**

`packages/contracts/src/notes-api.ts` currently covers only the older note surface. Expand it to include every `NotesChannels.invoke` method already exposed in preload, including:
- file metadata lookup
- wikilink resolution and hover previews
- property-definition operations
- attachment upload/list/delete
- folder config/template operations
- PDF/HTML export
- version history
- note positions and reordering
- file import flows
- local-only note toggles

Also move note event payloads that still only exist in `apps/desktop/src/preload/index.d.ts` into the canonical contract module, especially:
- `NoteExternalChangeEvent`
- any remaining note-adjacent preview/file DTOs used by the public note API

- [ ] **Step 4: Bring `inbox-api.ts` to full parity with `InboxChannels`**

`packages/contracts/src/inbox-api.ts` is closer, but it still misses public methods already exposed from preload and used by the renderer. Add canonical types and handler/client signatures for:
- `PREVIEW_LINK`
- `TRACK_SUGGESTION`
- `BULK_SNOOZE`
- `RETRY_METADATA`
- `LIST_ARCHIVED`
- `UNARCHIVE`
- `DELETE_PERMANENT`
- `GET_FILING_HISTORY`
- `UNDO_FILE`
- `UNDO_ARCHIVE`

Ground the request and response shapes in the current handler behavior visible in:
- `apps/desktop/src/main/ipc/inbox-handlers.ts`
- `apps/desktop/src/main/ipc/inbox-batch-handlers.ts`

- [ ] **Step 5: Create a real `settings-api.ts` instead of keeping settings types in preload**

Create `packages/contracts/src/settings-api.ts` and export it from `packages/contracts/package.json`.

This file should own:
- `SettingsClientAPI`
- settings event payloads
- request/response DTOs for the grouped settings methods
- the typed return shapes currently hand-written in `apps/desktop/src/preload/index.d.ts`

Keep `packages/contracts/src/settings-schemas.ts` as the home for Zod schemas and defaults. `settings-api.ts` should import types from those schemas instead of duplicating them.

- [ ] **Step 6: Add a declarative preload-binding manifest**

Create `packages/contracts/src/preload-bindings.ts` as the single input for preload codegen for this phase.

For each generated method/event in `tasks`, `notes`, `inbox`, and `settings`, record:
- public preload method name
- target channel constant
- whether the public API is positional or object-shaped
- the canonical request/response/event type owner

The generator should consume this manifest instead of scraping `src/main/**`.

- [ ] **Step 7: Verify the contract layer before touching preload**

Run:

```bash
pnpm typecheck:packages
```

Expected:
- `@memry/contracts` compiles with the new API modules and manifest
- there is exactly one canonical type owner for the phase-domain transport surface

## Chunk 2: Generated Bindings

### Task 2: Add a contract-driven preload generator without breaking untouched domains

**Files:**
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/scripts/generate-rpc-bindings.ts`
- Create: `apps/desktop/src/preload/generated-rpc.ts`

- [ ] **Step 1: Implement `generate-rpc-bindings.ts` as the new phase generator**

Use the manifest in `packages/contracts/src/preload-bindings.ts` as the source of truth and generate:
- domain objects for `notes`, `tasks`, `inbox`, and `settings`
- typed event subscription helpers for those domains

The generated file should live at `apps/desktop/src/preload/generated-rpc.ts`.

- [ ] **Step 2: Preserve the public renderer API shape during generation**

Do not use this phase to rename renderer-facing methods.

The generated or generated-plus-thin-wrapper output must preserve today's public call shapes, including positional convenience methods such as:
- `notes.rename(id, newTitle)`
- `notes.move(id, newFolder)`
- `inbox.linkToNote(itemId, noteId, tags?)`
- any other currently consumed helper whose public shape differs from the underlying handler signature

- [ ] **Step 3: Keep the legacy invoke map alive for non-phase domains**

Do not delete or replace:
- `apps/desktop/scripts/generate-ipc-invoke-map.js`
- `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts`

Those are still needed by the handwritten preload sections for domains outside this phase. Phase 01 should add a contract-driven path for the four target domains, not force an all-at-once preload rewrite.

- [ ] **Step 4: Update desktop scripts so `ipc:generate` and `ipc:check` run both generators**

Update `apps/desktop/package.json` so:
- `ipc:generate` writes both the legacy invoke map and the new generated phase bindings
- `ipc:check` verifies both outputs are current

Suggested shape:

```bash
node scripts/generate-ipc-invoke-map.js
node --experimental-strip-types scripts/generate-rpc-bindings.ts
```

and the corresponding `--check` variants.

- [ ] **Step 5: Generate and verify the codegen output**

Run:

```bash
pnpm ipc:generate
pnpm ipc:check
```

Expected:
- `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts` still serves untouched domains
- `apps/desktop/src/preload/generated-rpc.ts` is created and checked in
- both generators are stable under `--check`

### Task 3: Replace hand-maintained preload phase domains with generated bindings

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/main/preload-types.test.ts`

- [ ] **Step 1: Swap only the four phase domains onto generated bindings**

In `apps/desktop/src/preload/index.ts`, replace only:
- `notes`
- `tasks`
- `inbox`
- `settings`
- their matching `onNote*`, `onTask*`, `onInbox*`, and `onSettings*` helpers

with imports from `./generated-rpc`.

Leave these sections handwritten in Phase 01:
- window controls
- `getFileDropPaths`
- `getStartupThemeSync` and first-paint theme bootstrapping
- all non-phase domains that still depend on `generated-ipc-invoke-map.ts`

- [ ] **Step 2: Delete mirrored phase-domain DTOs from `preload/index.d.ts`**

`apps/desktop/src/preload/index.d.ts` should stop hand-maintaining the `tasks`, `notes`, `inbox`, and `settings` transport types that now live in `packages/contracts`.

Keep this file for:
- the global `Window` declaration
- non-phase domains that are still handwritten
- preload-only shell helpers that do not belong in contracts

For the phase domains, import and re-use the canonical types from:
- `@memry/contracts/tasks-api`
- `@memry/contracts/notes-api`
- `@memry/contracts/inbox-api`
- `@memry/contracts/settings-api`
- `./generated-rpc` where the global declaration needs generated helper types

- [ ] **Step 3: Strengthen preload type coverage**

Update `apps/desktop/src/main/preload-types.test.ts` so it asserts the generated phase-domain surface exists on `Window['api']`, for example:
- `Window['api']['tasks']['create']`
- `Window['api']['notes']['getByPath']`
- `Window['api']['inbox']['captureLink']`
- `Window['api']['settings']['getTaskSettings']`
- representative generated event helpers

- [ ] **Step 4: Run focused preload verification**

Run:

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/preload-types.test.ts src/main/preload-sync-bridge.test.ts
```

Expected:
- preload type declarations still compile
- preload import/exposure still works in tests
- the generated phase-domain bindings do not break the sync/crypto shell surface

## Chunk 3: Renderer Adoption

### Task 4: Remove parallel renderer DTOs while keeping service call sites stable

**Files:**
- Modify: `apps/desktop/src/renderer/src/services/tasks-service.ts`
- Modify: `apps/desktop/src/renderer/src/services/tasks-service.test.ts`
- Modify: `apps/desktop/src/renderer/src/services/notes-service.ts`
- Modify: `apps/desktop/src/renderer/src/services/notes-service.test.ts`
- Modify: `apps/desktop/src/renderer/src/services/inbox-service.ts`
- Modify: `apps/desktop/src/renderer/src/services/inbox-service.test.ts`

- [ ] **Step 1: Replace local tasks DTOs with canonical contract imports**

`apps/desktop/src/renderer/src/services/tasks-service.ts` currently re-defines the entire tasks transport model locally. Replace those local interfaces with imports from `@memry/contracts/tasks-api` and keep the service as a thin wrapper over `window.api.tasks`.

Do not delete the service in this phase. It is already consumed by:
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/contexts/tasks/index.tsx`

- [ ] **Step 2: Stop importing note types from `preload/index.d.ts`**

`apps/desktop/src/renderer/src/services/notes-service.ts` should import canonical note types from `@memry/contracts/notes-api` instead of `../../../preload/index.d`.

If a helper type is genuinely preload-only after the contract parity pass, isolate that exception and document it inline rather than continuing broad `.d.ts` imports.

- [ ] **Step 3: Bring inbox service onto the completed contract surface**

`apps/desktop/src/renderer/src/services/inbox-service.ts` should stop defining local transport shapes when the canonical inbox contract already owns them.

Make sure the service stays aligned with the now-complete inbox contract for:
- suggestion tracking
- retry metadata
- archived-item flows
- undo flows
- any preview helpers that remain publicly exposed

- [ ] **Step 4: Keep settings direct in the renderer for now**

Do not introduce a new `settings-service.ts` in Phase 01. The current renderer already calls `window.api.settings` directly across hooks and settings pages. This phase only needs to make that surface canonical and generated, not add a second abstraction layer.

- [ ] **Step 5: Verify the thin-wrapper layer and key consumers**

Run:

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/renderer/src/services/tasks-service.test.ts src/renderer/src/services/notes-service.test.ts src/renderer/src/services/inbox-service.test.ts src/renderer/src/hooks/use-task-preferences.test.ts src/renderer/src/pages/settings/tasks-section.test.tsx
```

Expected:
- the service wrappers still forward calls correctly
- the tasks vertical slice still compiles against the stable service surface
- the most important settings consumers still typecheck against `window.api.settings`

## Chunk 4: Verification

### Task 5: Validate the contract migration

- [ ] **Step 1: Regenerate both IPC artifacts**

Run:

```bash
pnpm ipc:generate
```

- [ ] **Step 2: Verify generated outputs are checked in and stable**

Run:

```bash
pnpm ipc:check
```

- [ ] **Step 3: Run the full typecheck bar**

Run:

```bash
pnpm typecheck
```

- [ ] **Step 4: Run the full quality bar for the phase**

Run:

```bash
pnpm lint
pnpm test
```

## Exit Criteria

- `packages/contracts` is the single canonical owner for the `tasks`, `notes`, `inbox`, and `settings` transport surface.
- `apps/desktop/src/preload/index.d.ts` no longer mirrors `tasks`, `notes`, `inbox`, or `settings` DTOs by hand.
- `apps/desktop/src/preload/index.ts` delegates those four domains and their event helpers to generated bindings while leaving non-phase/manual shell code intact.
- `ipc:generate` and `ipc:check` validate both the legacy invoke map and the new contract-driven phase bindings.
- Renderer services no longer define parallel transport types for tasks, notes, or inbox.
- Existing renderer settings consumers compile against the canonical generated `window.api.settings` surface without adding a second renderer abstraction.
