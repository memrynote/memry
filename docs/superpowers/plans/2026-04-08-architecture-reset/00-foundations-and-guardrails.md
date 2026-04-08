# Architecture Reset Phase 00 - Foundations And Guardrails Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hard architectural guardrails before any domain migration begins.

**Architecture:** This phase introduces compile-time and CI-enforced constraints without changing product behavior. The main outputs are boundary-check scripts, explicit `DataDb` and `IndexDb` types, and a dependency map for current high-risk files.

**Tech Stack:** Node scripts, TypeScript, ESLint, Vitest, existing workspace scripts

---

## File Map

- Modify: `package.json`
- Modify: `scripts/check-contract-boundaries.js`
- Create: `scripts/check-architecture-boundaries.js`
- Create: `apps/desktop/src/main/database/types.ts`
- Modify: `apps/desktop/src/main/database/client.ts`
- Modify: `apps/desktop/src/main/database/index.ts`
- Modify: `apps/desktop/src/main/database/queries/tasks.ts`
- Modify: `apps/desktop/src/main/database/queries/projects.ts`
- Modify: `apps/desktop/src/main/database/queries/notes.ts`
- Create: `docs/plan/architecture-dependency-map.md`
- Test: add script-level or unit coverage for architecture checks if practical

## Chunk 1: Boundary Checks

### Task 1: Extend architectural boundary enforcement

**Files:**
- Modify: `package.json`
- Modify: `scripts/check-contract-boundaries.js`
- Create: `scripts/check-architecture-boundaries.js`

- [ ] Step 1: Review current root scripts and define one new script entry for architecture checks.
- [ ] Step 2: Expand `check-contract-boundaries.js` only for contract-specific rules; do not turn it into a generic checker.
- [ ] Step 3: Create `check-architecture-boundaries.js` with these rules:
  - renderer cannot import `src/main/**`
  - renderer cannot import sync internals directly
  - IPC handlers cannot import `apps/desktop/src/main/database/queries/**` after later migration, but start by reporting current offenders in allowlist mode
  - modules intended for `index.db` cannot import canonical-write helpers
- [ ] Step 4: Add root scripts:
  - `check:contracts`
  - `check:architecture`
  - include both in the existing typecheck/lint path if the runtime cost is acceptable
- [ ] Step 5: Run the new scripts and adjust any false-positive path rules before landing.

### Task 2: Write the dependency map for hotspot files

**Files:**
- Create: `docs/plan/architecture-dependency-map.md`

- [ ] Step 1: Capture import and responsibility summaries for these hotspots:
  - `apps/desktop/src/preload/index.ts`
  - `apps/desktop/src/renderer/src/App.tsx`
  - `apps/desktop/src/renderer/src/contexts/tasks/index.tsx`
  - `apps/desktop/src/main/ipc/notes-handlers.ts`
  - `apps/desktop/src/main/ipc/tasks-handlers.ts`
  - `apps/desktop/src/main/sync/runtime.ts`
- [ ] Step 2: For each file, document:
  - what it owns today
  - what it should own after the reset
  - which later phase is responsible for shrinking it
- [ ] Step 3: Keep this doc factual; it is an input to later phases, not a second roadmap.

## Chunk 2: Database Boundary Safety

### Task 3: Introduce explicit `DataDb` and `IndexDb` types

**Files:**
- Create: `apps/desktop/src/main/database/types.ts`
- Modify: `apps/desktop/src/main/database/client.ts`
- Modify: `apps/desktop/src/main/database/index.ts`

- [ ] Step 1: Define separate schema imports for `data-schema` and `index-schema`.
- [ ] Step 2: Export explicit types:
  - `DataDb`
  - `IndexDb`
  - `RawIndexDb`
- [ ] Step 3: Update database client initialization to return the correct typed DB handle for each database instead of using one superset schema.
- [ ] Step 4: Re-export the new types from `apps/desktop/src/main/database/index.ts`.
- [ ] Step 5: Run typecheck and identify every query module that needs a type update.

### Task 4: Migrate query modules to explicit DB ownership

**Files:**
- Modify: `apps/desktop/src/main/database/queries/tasks.ts`
- Modify: `apps/desktop/src/main/database/queries/projects.ts`
- Modify: `apps/desktop/src/main/database/queries/notes.ts`

- [ ] Step 1: Change task and project query modules to accept `DataDb` only.
- [ ] Step 2: Change note projection/cache query modules to accept `IndexDb` only, unless the query truly reads canonical metadata from `data.db`.
- [ ] Step 3: Where a module currently mixes both databases, split the module by responsibility instead of leaving a union type.
- [ ] Step 4: Re-run typecheck and resolve every implicit mixed-db access.

## Chunk 3: Verification

### Task 5: Lock the guardrails into normal verification

**Files:**
- Modify: `package.json` if needed

- [ ] Step 1: Run `pnpm check:contracts`.
- [ ] Step 2: Run `pnpm check:architecture`.
- [ ] Step 3: Run `pnpm typecheck`.
- [ ] Step 4: Run targeted tests for any touched database or script modules.
- [ ] Step 5: Document any temporary allowlist entries and which later phase removes them.

## Exit Criteria

- `DataDb` and `IndexDb` are distinct types in the desktop app.
- CI can detect forbidden renderer-to-main imports.
- CI can detect future architecture regressions through a dedicated script.
- A dependency map exists for the current large orchestration files.

