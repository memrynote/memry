# Architecture Reset Phase 00 - Foundations And Guardrails Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hard architectural guardrails and explicit database ownership before any domain migration begins.

**Architecture:** This phase should land compiler-visible and CI-visible constraints without changing product behavior. The repo already has separate `packages/db-schema/src/data-schema.ts` and `packages/db-schema/src/index-schema.ts`; this phase wires those into the desktop app, splits the highest-risk mixed query modules, and adds a dedicated architecture checker that can block new violations while temporarily allowlisting today's debt.

**Tech Stack:** Node scripts, TypeScript, Drizzle ORM, Vitest, GitHub Actions, existing workspace scripts

**Roadmap:** `docs/superpowers/plans/2026-04-08-architecture-reset/README.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Modify | Add stable root entrypoints for contract and architecture checks |
| `apps/desktop/package.json` | Modify | Wire architecture checks into desktop `pretypecheck` |
| `.github/workflows/ci.yml` | Modify | Surface boundary-check failures as first-class CI steps |
| `scripts/check-contract-boundaries.js` | Modify | Keep the existing checker narrowly focused on `packages/contracts` |
| `scripts/check-architecture-boundaries.js` | Create | Enforce renderer/main, IPC/query, and index/data ownership rules |
| `apps/desktop/src/main/database/types.ts` | Create | Export `DataDb`, `IndexDb`, `RawIndexDb`, and the temporary compatibility alias |
| `apps/desktop/src/main/database/client.ts` | Modify | Initialize data and index DB handles with their real schema types |
| `apps/desktop/src/main/database/index.ts` | Modify | Re-export the new DB types and getters |
| `apps/desktop/src/main/database/client.test.ts` | Modify | Keep runtime coverage around DB initialization and getters intact |
| `apps/desktop/src/main/database/queries/tasks.ts` | Modify | Restrict task queries to `DataDb` |
| `apps/desktop/src/main/database/queries/projects.ts` | Modify | Restrict project/status queries to `DataDb` |
| `apps/desktop/src/main/database/queries/note-positions.ts` | Modify | Restrict note position queries to `DataDb` |
| `apps/desktop/src/main/database/queries/search.ts` | Modify | Make mixed-db orchestration explicit via `IndexDb` + `DataDb` params |
| `apps/desktop/src/main/database/queries/graph.ts` | Modify | Make mixed-db orchestration explicit via `IndexDb` + `DataDb` params |
| `apps/desktop/src/main/database/queries/tags.ts` | Modify | Keep cross-db tag aggregation explicit instead of hidden behind one `DrizzleDb` |
| `apps/desktop/src/main/database/queries/notes/index.ts` | Modify | Keep the public barrel stable while internal note/query ownership is split |
| `apps/desktop/src/main/database/queries/notes/note-crud.ts` | Modify | Restrict note cache CRUD to `IndexDb` |
| `apps/desktop/src/main/database/queries/notes/link-queries.ts` | Modify | Restrict note link queries to `IndexDb` |
| `apps/desktop/src/main/database/queries/notes/property-queries.ts` | Modify | Restrict note property cache queries to `IndexDb` |
| `apps/desktop/src/main/database/queries/notes/journal-queries.ts` | Modify | Restrict journal cache queries to `IndexDb` |
| `apps/desktop/src/main/database/queries/notes/tag-queries.ts` | Modify | Keep only note-tag rows in the index DB helper layer |
| `apps/desktop/src/main/database/queries/tag-definitions.ts` | Create | Move tag definition helpers onto a clearly data-db-owned module |
| `docs/plan/architecture-dependency-map.md` | Create | Record today's large orchestration files, dependencies, and target owner phases |

## Chunk 1: Guardrail Scripts And CI

### Task 1: Split contract checks from broader architecture checks

**Files:**
- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/check-contract-boundaries.js`
- Create: `scripts/check-architecture-boundaries.js`

- [ ] **Step 1: Keep the root contract checker contract-only**

Confirm `scripts/check-contract-boundaries.js` continues to scan only `packages/contracts/src` and continues to reject:
- app-package imports such as `@memry/desktop` and `@memry/sync-server`
- app-source imports under `apps/desktop/src/{main,preload,renderer}`
- legacy shared-schema imports under `apps/desktop/src/shared/db/schema`

Do not turn this file into a generic checker. Its only job is protecting `packages/contracts`.

- [ ] **Step 2: Add stable root script names for both boundary checks**

In `package.json`, add:
- `check:contracts` -> `node scripts/check-contract-boundaries.js`
- `check:architecture` -> `node scripts/check-architecture-boundaries.js`

Keep the existing `check:contract-boundaries` entry as a temporary compatibility alias if other scripts still reference it.

- [ ] **Step 3: Wire architecture checks into the normal desktop typecheck path**

Update `apps/desktop/package.json` so `pretypecheck` runs both root checks before `pnpm ipc:check`.

Target behavior:

```bash
pnpm --dir ../.. check:contracts
pnpm --dir ../.. check:architecture
pnpm ipc:check
```

This keeps `pnpm typecheck` honest without requiring engineers to remember a separate command.

- [ ] **Step 4: Surface the checks explicitly in CI**

Update `.github/workflows/ci.yml` so the quality job has a named boundary-check step before the existing lint/typecheck/test steps.

Run:

```bash
pnpm check:contracts
pnpm check:architecture
```

Do this even though `pretypecheck` will also run them. The extra step makes failures obvious in CI output instead of burying them inside the desktop package lifecycle.

- [ ] **Step 5: Implement `scripts/check-architecture-boundaries.js` with repo-specific rule sets**

Build the new script by reusing the same low-level patterns from `check-contract-boundaries.js`:
- recursive file walk
- source-file filtering
- import/export regex scan
- relative path resolution
- root containment checks

Add desktop-specific rule groups:

1. Renderer boundary rules:
   - source root: `apps/desktop/src/renderer/src`
   - fail on any import that resolves into `apps/desktop/src/main/**`
   - fail on any `@main/*` package-path import
   - fail on any import that resolves into `apps/desktop/src/main/sync/**`

2. IPC handler boundary rules:
   - source root: `apps/desktop/src/main/ipc`
   - fail on direct imports of `apps/desktop/src/main/database/queries/**`
   - start in allowlist mode so current offenders are reported but not blocking
   - fail immediately on any new offender that is not allowlisted

3. Index-owned query boundary rules:
   - source root: `apps/desktop/src/main/database/queries/notes`
   - fail if those files import data-db-only schema/modules such as:
     - `@memry/db-schema/schema/tag-definitions`
     - `@memry/db-schema/schema/note-positions`
     - task/project query modules
     - `getDatabase`

Leave intentional dual-db orchestrators like `queries/graph.ts` and `queries/search.ts` out of this rule. Task 4 should make their mixed ownership explicit through function signatures instead.

The point is not to model the entire future architecture yet. The point is to make the future mistakes impossible while this refactor is in flight.

- [ ] **Step 6: Seed the IPC allowlist from the current repo state**

Build the initial allowlist from the current direct-query IPC handler imports already present in the repo:
- `apps/desktop/src/main/ipc/ai-inline-handlers.ts`
- `apps/desktop/src/main/ipc/bookmarks-handlers.ts`
- `apps/desktop/src/main/ipc/graph-handlers.ts`
- `apps/desktop/src/main/ipc/journal-handlers.ts`
- `apps/desktop/src/main/ipc/notes-handlers.ts`
- `apps/desktop/src/main/ipc/properties-handlers.ts`
- `apps/desktop/src/main/ipc/reminder-handlers.ts`
- `apps/desktop/src/main/ipc/saved-filters-handlers.ts`
- `apps/desktop/src/main/ipc/search-handlers.ts`
- `apps/desktop/src/main/ipc/settings-handlers.ts`
- `apps/desktop/src/main/ipc/sync-handlers.ts`
- `apps/desktop/src/main/ipc/tags-handlers.ts`
- `apps/desktop/src/main/ipc/tasks-handlers.ts`

Do not add `generated-ipc-invoke-map.ts` to this allowlist. It is generated type output, not handwritten architecture debt.

- [ ] **Step 7: Run the new checks before moving on**

Run:

```bash
pnpm check:contracts
pnpm check:architecture
```

Expected:
- contract checker still passes
- architecture checker either passes or reports only the intentionally allowlisted IPC offenders

### Task 2: Write the dependency map for the current hotspot files

**Files:**
- Create: `docs/plan/architecture-dependency-map.md`

- [ ] **Step 1: Document the six hotspot files named in the roadmap**

Create sections for:
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/contexts/tasks/index.tsx`
- `apps/desktop/src/main/ipc/notes-handlers.ts`
- `apps/desktop/src/main/ipc/tasks-handlers.ts`
- `apps/desktop/src/main/sync/runtime.ts`

- [ ] **Step 2: Use the same section template for every hotspot**

Each section should contain:
- `Owns today`
- `Key dependencies today`
- `Should own after the reset`
- `Primary shrink phase`
- `Secondary notes`

Keep this file factual. Do not turn it into a second roadmap.

- [ ] **Step 3: Ground the summaries in the code that exists today**

Capture the real responsibilities visible in the current codebase:
- `preload/index.ts` currently owns the giant handwritten `window.api` bridge plus startup theme bootstrapping
- `App.tsx` currently owns app-shell providers, onboarding gates, and leftover sample-task bootstrapping
- `contexts/tasks/index.tsx` currently converts DB DTOs to UI DTOs and owns shared task/project event state
- `notes-handlers.ts` currently mixes IPC validation, vault orchestration, DB queries, file I/O, attachments, and export concerns
- `tasks-handlers.ts` currently mixes IPC validation, query calls, sync enqueue logic, and renderer event emission
- `sync/runtime.ts` currently owns session bootstrap, singleton wiring, CRDT seeding, queue setup, and worker bridge lifecycle

- [ ] **Step 4: Map each hotspot to the primary cleanup phase**

Use these as the initial owner phases unless deeper code review proves otherwise:
- `preload/index.ts` -> Phase 01
- `App.tsx` -> Phase 01 first, then follow-on cleanup in Phases 02-04
- `contexts/tasks/index.tsx` -> Phase 02
- `tasks-handlers.ts` -> Phase 02
- `notes-handlers.ts` -> Phase 04
- `sync/runtime.ts` -> Phase 05

- [ ] **Step 5: Record temporary allowlists here too**

Add a short final section listing:
- the IPC handler allowlist introduced by `check-architecture-boundaries.js`
- which later phase is expected to retire each cluster of entries

This keeps the "temporary" debt visible in a doc people will actually read.

## Chunk 2: Database Boundary Safety

### Task 3: Introduce explicit `DataDb` and `IndexDb` types

**Files:**
- Create: `apps/desktop/src/main/database/types.ts`
- Modify: `apps/desktop/src/main/database/client.ts`
- Modify: `apps/desktop/src/main/database/index.ts`
- Modify: `apps/desktop/src/main/database/client.test.ts`

- [ ] **Step 1: Create a dedicated database types module**

In `apps/desktop/src/main/database/types.ts`, import the already-existing split schema entrypoints:
- `@memry/db-schema/data-schema`
- `@memry/db-schema/index-schema`

Export:
- `DataDb = BetterSQLite3Database<typeof dataSchema>`
- `IndexDb = BetterSQLite3Database<typeof indexSchema>`
- `RawIndexDb = Database.Database`

Also export a temporary compatibility alias:
- `DrizzleDb = DataDb | IndexDb`

Keep this alias intentionally marked as transitional so later phases can remove it after call sites are migrated.

- [ ] **Step 2: Update `client.ts` to initialize each DB with its real schema**

Replace the current superset import from `@memry/db-schema/schema` with explicit data/index schema imports.

Target behavior:
- `initDatabase()` returns `DataDb`
- `initIndexDatabase()` returns `IndexDb`
- `getDatabase()` returns `DataDb`
- `getIndexDatabase()` returns `IndexDb`
- `getRawIndexDatabase()` returns `RawIndexDb`

Do not change the runtime database setup behavior in this step. Keep pragmas, sqlite-vec loading, and health checks exactly as they work today.

- [ ] **Step 3: Re-export the new types from the database barrel**

Update `apps/desktop/src/main/database/index.ts` so the rest of the app can import:
- `type DataDb`
- `type IndexDb`
- `type RawIndexDb`
- `type DrizzleDb`

This should be a pure barrel change, not a second place where types are redefined.

- [ ] **Step 4: Keep the existing runtime tests passing**

Update `apps/desktop/src/main/database/client.test.ts` only as needed for the new imports or renamed types.

Do not try to unit-test TypeScript aliases at runtime. Let `pnpm typecheck` verify the compile-time side, and keep Vitest focused on:
- initialization
- getters
- vec table setup
- health checks
- timeout behavior

- [ ] **Step 5: Run the targeted client verification**

Run:

```bash
pnpm --filter @memry/desktop test -- src/main/database/client.test.ts
pnpm typecheck
```

Expected:
- client test stays green
- typecheck now sees distinct data/index getter types

### Task 4: Migrate the highest-risk query modules to explicit DB ownership

**Files:**
- Modify: `apps/desktop/src/main/database/queries/tasks.ts`
- Modify: `apps/desktop/src/main/database/queries/projects.ts`
- Modify: `apps/desktop/src/main/database/queries/note-positions.ts`
- Modify: `apps/desktop/src/main/database/queries/search.ts`
- Modify: `apps/desktop/src/main/database/queries/graph.ts`
- Modify: `apps/desktop/src/main/database/queries/tags.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/index.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/note-crud.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/link-queries.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/property-queries.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/journal-queries.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/tag-queries.ts`
- Create: `apps/desktop/src/main/database/queries/tag-definitions.ts`

- [ ] **Step 1: Move obvious data-db query modules to `DataDb`**

Update:
- `queries/tasks.ts`
- `queries/projects.ts`
- `queries/note-positions.ts`

These modules should accept `DataDb` directly instead of redefining their own `BetterSQLite3Database<typeof schema>` alias.

- [ ] **Step 2: Move obvious index-db query modules to `IndexDb`**

Update:
- `queries/notes/note-crud.ts`
- `queries/notes/link-queries.ts`
- `queries/notes/property-queries.ts`
- `queries/notes/journal-queries.ts`

These files should stop importing the full schema barrel and should instead depend on the explicit index-db type.

- [ ] **Step 3: Split mixed note-tag concerns instead of hiding them behind one DB type**

`queries/notes/tag-queries.ts` currently mixes:
- index-db note-tag rows from `notes-cache`
- data-db tag definitions from `tag-definitions`

Split that responsibility so:
- `queries/notes/tag-queries.ts` keeps only note-tag row operations that belong to `IndexDb`
- `queries/tag-definitions.ts` owns `getOrCreateTag`, `getAllTagDefinitions`, `updateTagColor`, `renameTagDefinition`, `deleteTagDefinition`, and `ensureTagDefinitions` on `DataDb`

Keep `queries/notes/index.ts` re-exporting the public helpers if that avoids a noisy callsite migration in this phase. The important change is DB ownership, not barrel purity.

- [ ] **Step 4: Make dual-db orchestration explicit where it is truly required**

Update:
- `queries/search.ts`
- `queries/graph.ts`
- `queries/tags.ts`

These files are allowed to touch both databases, but they must do so explicitly:
- `search.ts` should take `indexDb: IndexDb` and `dataDb: DataDb`
- `graph.ts` should take `indexDb: IndexDb` and `dataDb: DataDb`
- `tags.ts` should take `indexDb: IndexDb` and `dataDb: DataDb`

Do not leave these modules on the compatibility `DrizzleDb` alias. They are the canonical examples of intentional dual-db orchestration.

- [ ] **Step 5: Re-run typecheck and only widen scope if the compiler forces it**

Run:

```bash
pnpm typecheck
```

Expected:
- the query modules above compile with explicit DB ownership
- other legacy call sites may still use the temporary `DrizzleDb` compatibility alias

If typecheck forces more updates, keep them tightly scoped to imports and type annotations. Do not let this phase turn into a broad feature refactor.

## Chunk 3: Verification

### Task 5: Lock the new guardrails into normal verification

**Files:**
- Modify: `package.json` if needed
- Modify: `apps/desktop/package.json` if needed
- Modify: `.github/workflows/ci.yml` if needed
- Modify: `docs/plan/architecture-dependency-map.md` if allowlists need documentation updates

- [ ] **Step 1: Run the boundary checks directly**

Run:

```bash
pnpm check:contracts
pnpm check:architecture
```

- [ ] **Step 2: Run the desktop-focused verification after the type split**

Run:

```bash
pnpm --filter @memry/desktop test -- src/main/database/client.test.ts
pnpm --filter @memry/desktop test -- src/main/database/queries/tasks.test.ts
pnpm --filter @memry/desktop test -- src/main/database/queries/projects.test.ts
pnpm --filter @memry/desktop test -- src/main/database/queries/notes/notes.test.ts
```

- [ ] **Step 3: Run the phase-wide verification bar**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ipc:check
```

- [ ] **Step 4: Confirm the "temporary" debt is written down**

Before landing, verify both of these exist:
- the IPC-query allowlist lives in `check-architecture-boundaries.js`
- the same allowlist is summarized in `docs/plan/architecture-dependency-map.md` with the phase expected to remove it

- [ ] **Step 5: Commit**

```bash
git add package.json apps/desktop/package.json .github/workflows/ci.yml scripts/check-contract-boundaries.js scripts/check-architecture-boundaries.js apps/desktop/src/main/database apps/desktop/src/main/database/queries docs/plan/architecture-dependency-map.md
git commit -m "chore: add architecture boundary guardrails"
```

## Exit Criteria

- `DataDb` and `IndexDb` exist as explicit desktop app types, backed by the real split schema entrypoints.
- `apps/desktop/src/main/database/client.ts` no longer initializes both databases from the superset `@memry/db-schema/schema` import.
- Renderer-to-main and renderer-to-main-sync imports are blocked by a dedicated architecture checker.
- New direct IPC-handler imports of `database/queries/**` fail unless deliberately allowlisted.
- Mixed note-tag definition helpers are no longer hidden inside an index-db query module.
- `docs/plan/architecture-dependency-map.md` exists and names the current hotspot files plus the phase expected to shrink each one.
