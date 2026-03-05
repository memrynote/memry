# Implementation Plan: Global Search System

**Branch**: `007-global-search` | **Date**: 2026-03-03 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/007-global-search/spec.md`

## Summary

Build a unified search system across notes, tasks, journal entries, and inbox items using a single FTS5 virtual table (`fts_content`) with BM25 ranking. Extend the existing `command-palette.tsx` to display grouped multi-type results with type filtering, fuzzy fallback via fuzzysort, keyboard navigation (Cmd+K), and persisted recent searches. All search is local/offline — zero network dependency.

## Technical Context

**Language/Version**: TypeScript 5.x (Electron + React)
**Primary Dependencies**: better-sqlite3, Drizzle ORM, cmdk, fuzzysort (new), Zod
**Storage**: SQLite — `index.db` (FTS index, note cache) + `data.db` (tasks, inbox, settings, recent searches)
**Testing**: Vitest (unit/integration), Playwright (E2E)
**Target Platform**: Electron (macOS primary, Windows/Linux secondary)
**Project Type**: Electron app — main process (Node.js/SQLite) + renderer process (React)
**Performance Goals**: Search modal open < 50ms, first results < 100ms, full search < 200ms on 10k items
**Constraints**: 100% offline, < 200ms p95 search latency, non-blocking FTS updates
**Scale/Scope**: Up to 10,000 items across all content types

## Constitution Check

_GATE: Derived from CLAUDE.md project conventions (no project-specific constitution defined)._

| Principle                                    | Status | Notes                                                              |
| -------------------------------------------- | ------ | ------------------------------------------------------------------ | --- | -------------------- |
| Local-first / offline-first                  | PASS   | All FTS data in local SQLite, zero network calls                   |
| Electron IPC pattern                         | PASS   | All new handlers use `createValidatedHandler()` + Zod schemas      |
| Logging via `createLogger()`                 | PASS   | Search handlers already use logger pattern                         |
| Error extraction via `extractErrorMessage()` | PASS   | All IPC error paths follow pattern                                 |
| Pre-production DB flexibility                | PASS   | Can migrate FTS schema without backward compat                     |
| Files < 500 LOC                              | WATCH  | `command-palette.tsx` and `search.ts` may exceed — plan extraction |
| Conventional Commits                         | PASS   | All commits follow `feat                                           | fix | refactor` convention |

**Post-Design Re-check**: All gates pass. No violations requiring justification.

## Project Structure

### Documentation (this feature)

```text
specs/007-global-search/
├── plan.md                             # This file
├── spec.md                             # Feature specification (12 user stories, 36 FRs)
├── research.md                         # Phase 0: all research findings
├── data-model.md                       # Phase 1: entity models + FTS schema
├── quickstart.md                       # Phase 1: implementation guide
├── contracts/
│   ├── search-api-changes.md           # Contract diffs for search-api.ts
│   └── fts-api.md                      # FTS engine API contract
└── checklists/                         # Acceptance test checklists
```

### Source Code (files to modify/create)

```text
src/
├── main/
│   ├── database/
│   │   ├── fts.ts                      # MODIFY: migrate fts_notes → fts_content
│   │   ├── fts-queue.ts                # MODIFY: add type parameter
│   │   └── fts-rebuild.ts              # NEW: full rebuild logic
│   ├── ipc/
│   │   ├── search-handlers.ts          # MODIFY: implement all types, fix stubs
│   │   ├── tasks-handlers.ts           # MODIFY: add FTS hooks on CRUD
│   │   └── inbox-crud-handlers.ts      # MODIFY: add FTS hooks on CRUD
│   └── ...
├── shared/
│   ├── contracts/
│   │   └── search-api.ts               # MODIFY: add inbox type, update unions
│   └── db/
│       ├── queries/
│       │   └── search.ts               # MODIFY: unified searchAll(), fix bugs
│       └── schema/
│           └── recent-searches.ts      # NEW: Drizzle schema
├── renderer/
│   └── src/
│       ├── components/search/
│       │   ├── command-palette.tsx      # MODIFY: multi-type grouped results
│       │   ├── search-result-group.tsx  # NEW: grouped section component
│       │   ├── type-filter-bar.tsx      # NEW: type filter chips
│       │   ├── search-modal.tsx         # DELETE: dead code
│       │   └── search-result-item.tsx   # DELETE: dead code
│       ├── hooks/
│       │   ├── use-search.ts           # MODIFY: updated types, fuzzy fallback
│       │   └── use-search-shortcut.ts  # MODIFY: Cmd+P → Cmd+K
│       ├── lib/
│       │   └── fuzzy-search.ts         # NEW: fuzzysort wrapper
│       └── App.tsx                     # MODIFY: multi-type navigation dispatch
└── preload/
    └── index.ts                        # MODIFY: new channels
```

**Structure Decision**: Electron app with main/renderer/preload/shared architecture. All new code follows existing directory conventions. FTS engine code stays in `src/main/database/`, UI in `src/renderer/src/components/search/`.

## Implementation Phases

### Phase 1: Unified FTS Index (Backend Foundation)

**Goal**: Replace `fts_notes` with `fts_content` and index all content types.

**Why**: This is the foundation — nothing else works without cross-type indexing.

| Step | What                                                             | Why                                                    | Files                    |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------ | ------------------------ |
| 1.1  | Create `fts_content` FTS5 table, drop `fts_notes` + old triggers | Unified table enables single-query cross-type search   | `fts.ts`                 |
| 1.2  | Create new `note_cache` triggers with `type` logic               | Journal vs note distinction via `date IS NOT NULL`     | `fts.ts`                 |
| 1.3  | Update `fts-queue.ts` to accept `type` parameter                 | Queue must know content type for inserts               | `fts-queue.ts`           |
| 1.4  | Add FTS insert/update/delete hooks in `tasks-handlers.ts`        | Tasks must be searchable — hook after primary mutation | `tasks-handlers.ts`      |
| 1.5  | Add FTS insert/update/delete hooks in `inbox-crud-handlers.ts`   | Inbox items must be searchable                         | `inbox-crud-handlers.ts` |
| 1.6  | Implement `rebuildFtsIndex()` in new `fts-rebuild.ts`            | Replace stub — iterate all sources, bulk insert        | `fts-rebuild.ts`         |
| 1.7  | Fix duplicate filter clauses in `advancedSearch()`               | Bug: lines ~467-476 duplicate ~456-464                 | `search.ts`              |
| 1.8  | Unit tests: FTS CRUD for all 4 types + rebuild                   | Verify indexing works before building queries          | `fts.test.ts`            |

**Dependencies**: None — this phase is self-contained.

### Phase 2: Cross-Type Search Queries (Backend)

**Goal**: Single search query returns ranked results from all content types with metadata.

**Why**: The UI needs structured, typed results to render grouped sections.

| Step | What                                                                   | Why                                          | Files                           |
| ---- | ---------------------------------------------------------------------- | -------------------------------------------- | ------------------------------- |
| 2.1  | Add `SearchResultInbox` to contract types                              | Missing from union — inbox not representable | `search-api.ts`                 |
| 2.2  | Update `SearchQuerySchema`, `QuickSearchResponse`, `SearchStats`       | Contracts must support inbox + real counts   | `search-api.ts`                 |
| 2.3  | Create `searchAll()` query function                                    | Unified FTS5 MATCH + metadata JOINs per type | `search.ts`                     |
| 2.4  | Update `search:query` handler to use `searchAll()`                     | Handler currently only searches notes        | `search-handlers.ts`            |
| 2.5  | Update `search:quick` handler to return all types                      | Currently hardcodes `tasks: []`              | `search-handlers.ts`            |
| 2.6  | Implement `search:tasks` handler (currently unimplemented)             | Channel defined but not wired                | `search-handlers.ts`            |
| 2.7  | Fix `SearchStats` to return real counts                                | `totalTasks`/`totalJournals` hardcoded to 0  | `search-handlers.ts`            |
| 2.8  | Update preload bridge + renderer service types                         | New channels + updated return types          | `index.ts`, `search-service.ts` |
| 2.9  | Integration tests: cross-type search, type filtering, compound filters | Verify ranking and metadata correctness      | `search.integration.test.ts`    |

**Dependencies**: Phase 1 complete.

**Cross-database metadata strategy**: FTS query runs against `fts_content` (index.db). For task/inbox metadata, run a secondary query against data.db using the IDs from FTS results. This avoids ATTACH complexity and keeps the databases independent.

### Phase 3: Fuzzy Search

**Goal**: Typo-tolerant search via client-side fuzzy matching on titles.

**Why**: FTS5 handles prefix/phrase/stemmed matches but not typos (spec FR-007).

| Step | What                                                    | Why                                         | Files                  |
| ---- | ------------------------------------------------------- | ------------------------------------------- | ---------------------- |
| 3.1  | Install `fuzzysort` package                             | Lightweight (~4KB), fast, TypeScript-native | `package.json`         |
| 3.2  | Create `fuzzy-search.ts` wrapper                        | Encapsulate fuzzysort config + scoring      | `fuzzy-search.ts`      |
| 3.3  | Build title cache in `useSearch` hook                   | Fuzzy needs in-memory array of titles       | `use-search.ts`        |
| 3.4  | Implement fuzzy fallback: if FTS < 5 results, run fuzzy | Transparent to user — just "better results" | `use-search.ts`        |
| 3.5  | Merge + deduplicate FTS + fuzzy results                 | Exact > prefix > fuzzy ranking              | `use-search.ts`        |
| 3.6  | Unit tests: typo detection, threshold, ranking order    | Verify 70% similarity threshold (SC-007)    | `fuzzy-search.test.ts` |

**Dependencies**: Phase 2 complete (need typed results to merge with fuzzy).

### Phase 4: UI — Multi-Type Results & Filtering

**Goal**: Redesign command palette to display grouped, filterable, cross-type results.

**Why**: Current UI only shows notes. Spec requires grouped sections (FR-010) + type filters (FR-016).

| Step | What                                                               | Why                                                             | Files                                    |
| ---- | ------------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------- |
| 4.1  | Create `SearchResultGroup` component                               | Reusable section: icon + header + count + items + "View all"    | `search-result-group.tsx`                |
| 4.2  | Create `TypeFilterBar` component                                   | Filter chips: All / Notes / Tasks / Journal / Inbox             | `type-filter-bar.tsx`                    |
| 4.3  | Refactor `command-palette.tsx` for grouped rendering               | Replace flat date-grouped list with type-grouped sections       | `command-palette.tsx`                    |
| 4.4  | Add type-specific result rows                                      | Note: icon+title+path; Task: checkbox+title+project+due; etc.   | `command-palette.tsx`                    |
| 4.5  | Add tag filter with autocomplete (FR-017)                          | Reuse existing `getSuggestions()` for tag completion            | `command-palette.tsx`                    |
| 4.6  | Add date range presets (FR-018)                                    | Today, This Week, This Month, Custom — already partially exists | `command-palette.tsx`                    |
| 4.7  | Add Cmd+1–4 type filter shortcuts (FR-026)                         | Power user keyboard shortcuts                                   | `command-palette.tsx`                    |
| 4.8  | Change Cmd+P → Cmd+K (FR-001)                                      | Spec requirement, industry standard                             | `use-search-shortcut.ts`                 |
| 4.9  | Delete `search-modal.tsx` + `search-result-item.tsx` + their tests | Dead code — `CommandPalette` replaced them                      | `search-modal.*`, `search-result-item.*` |
| 4.10 | Extract `command-palette.tsx` if > 500 LOC                         | Keep files manageable per CLAUDE.md convention                  | `command-palette.tsx`                    |

**Dependencies**: Phase 2 complete (UI needs typed cross-type results).

### Phase 5: Navigation for All Types

**Goal**: Clicking any search result navigates to the correct view.

**Why**: Search is useless without navigation. Spec stories 3.1–3.4.

| Step | What                                                           | Why                                                 | Files     |
| ---- | -------------------------------------------------------------- | --------------------------------------------------- | --------- |
| 5.1  | Extend `handleSelectSearchResult` to dispatch by `result.type` | Currently only handles notes/journals               | `App.tsx` |
| 5.2  | Task result → open tasks tab with task selected                | New tab type or existing tasks view with `entityId` | `App.tsx` |
| 5.3  | Inbox result → open inbox tab with item highlighted            | Similar to task — open inbox view, scroll to item   | `App.tsx` |
| 5.4  | Journal result → already works via path regex                  | Verify existing behavior, no changes expected       | —         |
| 5.5  | Cmd+Enter opens in new permanent tab (existing behavior)       | Verify works for all types                          | `App.tsx` |

**Dependencies**: Phase 4 complete (UI passes typed results to handlers).

### Phase 6: Recent Searches Persistence

**Goal**: Recent searches survive app restart.

**Why**: Currently in-memory — lost on restart (violates FR-032).

| Step | What                                                                     | Why                                                  | Files                     |
| ---- | ------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------- |
| 6.1  | Create `recent_searches` Drizzle schema                                  | Table: id, query (unique), result_count, searched_at | `recent-searches.ts`      |
| 6.2  | Run Drizzle migration                                                    | Add table to data.db                                 | migration SQL             |
| 6.3  | Replace in-memory array in `search-handlers.ts`                          | UPSERT on search, DELETE oldest when > 20            | `search-handlers.ts`      |
| 6.4  | Update `search:get-recent` / `search:add-recent` / `search:clear-recent` | Read/write from SQLite instead of array              | `search-handlers.ts`      |
| 6.5  | Unit tests: persistence, deduplication, 20-item limit                    | Verify FR-029, FR-030, FR-032, FR-033                | `recent-searches.test.ts` |

**Dependencies**: None — can run in parallel with Phase 3–5.

### Phase 7: Polish & Performance

**Goal**: Meet all success criteria, harden edge cases, ensure accessibility.

**Why**: Production readiness.

| Step | What                                                         | Why                                                       | Files                 |
| ---- | ------------------------------------------------------------ | --------------------------------------------------------- | --------------------- |
| 7.1  | Performance benchmark: 10k items, all types                  | SC-002 (< 100ms), SC-003 (< 200ms)                        | benchmark script      |
| 7.2  | Verify FTS update doesn't block UI                           | Non-blocking index updates                                | `fts-queue.ts`        |
| 7.3  | Index rebuild progress reporting                             | Emit events during rebuild (scanning/indexing/optimizing) | `fts-rebuild.ts`      |
| 7.4  | Implement `onSearchIndexCorrupt` recovery                    | Detect corrupt FTS table, trigger auto-rebuild            | `search-handlers.ts`  |
| 7.5  | Accessibility: ARIA labels, focus indicators, screen reader  | Keyboard-only users must navigate fully                   | `command-palette.tsx` |
| 7.6  | Edge cases: special chars, long queries (> 500), empty state | FR edge cases from spec                                   | various               |
| 7.7  | Fix tag filtering perf: SQL JOIN instead of JS post-filter   | Current `searchNotes()` applies tag filter after LIMIT    | `search.ts`           |

**Dependencies**: All other phases complete.

## Key Decisions

| Decision                | Choice                  | Rationale                                             |
| ----------------------- | ----------------------- | ----------------------------------------------------- |
| FTS architecture        | Unified `fts_content`   | Consistent BM25 ranking, single query, simpler code   |
| Fuzzy search            | fuzzysort (client-side) | 4KB, fast, TypeScript-native, no native deps          |
| Recent searches storage | SQLite (data.db)        | Persists across restarts, Drizzle migration pipeline  |
| Keyboard shortcut       | Cmd+K                   | Spec requirement, industry standard                   |
| Legacy search-modal.tsx | Delete                  | Dead code, never imported at runtime                  |
| Cross-DB metadata       | Secondary query by IDs  | Avoids ATTACH complexity, keeps DBs independent       |
| Journal indexing        | Already done            | Journals are notes with `date` column in `note_cache` |
| Semantic search         | Out of scope            | FTS5 + fuzzy covers all spec requirements             |

## Risk Register

| Risk                                        | Impact | Mitigation                                                          |
| ------------------------------------------- | ------ | ------------------------------------------------------------------- |
| FTS migration corrupts existing note search | High   | Rebuild is idempotent; test migration on copy of index.db first     |
| BM25 ranking inconsistent across types      | Medium | Tune weights per content type; content column normalization         |
| fuzzysort memory usage with 10k titles      | Low    | ~2MB for 10k short strings; lazy-load on first search               |
| Cmd+K conflicts with existing shortcuts     | Medium | Audit all registered shortcuts before changing                      |
| `command-palette.tsx` exceeds 500 LOC       | Low    | Extract `SearchResultGroup`, `TypeFilterBar` as separate components |

## Complexity Tracking

No constitution violations requiring justification.

## Testing Strategy

### Unit Tests (Vitest)

- FTS: insert/update/delete for each content type
- FTS rebuild: produces same results as incremental indexing
- Fuzzy: typo detection at 70% threshold, ranking order
- Recent searches: CRUD, dedup, 20-item limit, persistence
- Query builder: operator parsing, filter combination

### Integration Tests

- Cross-type search returns results from all 4 types
- Type filters narrow correctly
- Compound filters (type + tag + date) apply AND logic
- BM25 ranking: exact match > prefix > fuzzy

### E2E Tests (Playwright)

- Cmd+K → type → results appear → click → navigates
- Type filter Cmd+1–4
- Keyboard nav: Arrow Down/Up, Enter, Escape
- Recent searches persist across app restart
- Fuzzy: "meetng" finds "meeting"
