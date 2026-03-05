# Tasks: Global Search System

**Input**: Design documents from `/specs/007-global-search/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included where critical for correctness (FTS indexing, search ranking, persistence). Not every task has a test — tests focus on backend correctness and integration.

**Organization**: Tasks grouped by user story. P1 stories share a foundational phase; P2/P3 stories are independently implementable after foundation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Exact file paths included for each task

---

## Phase 1: Setup

**Purpose**: Install dependencies, remove dead code, prepare workspace

- [ ] T001 Install `fuzzysort` package via `pnpm add fuzzysort` in project root
- [ ] T002 [P] Delete dead code `src/renderer/src/components/search/search-modal.tsx` and its test file
- [ ] T003 [P] Delete dead code `src/renderer/src/components/search/search-result-item.tsx` and its test file
- [ ] T004 [P] Remove `SearchModal` and `SearchResultItem` exports from `src/renderer/src/components/search/index.ts` barrel file

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Unified FTS table, contract types, CRUD hooks, query engine — ALL user stories depend on this

**CRITICAL**: No user story work can begin until this phase is complete

### FTS Engine Migration

- [ ] T005 Migrate `fts_notes` → `fts_content` FTS5 virtual table in `src/main/database/fts.ts`: drop old table + triggers, create unified table with `id UNINDEXED, type UNINDEXED, title, content, tags` columns, create new `note_cache` triggers with `CASE WHEN NEW.date IS NOT NULL THEN 'journal' ELSE 'note' END` type logic per `contracts/fts-api.md`
- [ ] T006 Add unified FTS entry functions (`insertFtsEntry`, `updateFtsEntry`, `deleteFtsEntry`, `searchFts`) in `src/main/database/fts.ts` per `contracts/fts-api.md` signatures
- [ ] T007 Update `src/main/database/fts-queue.ts` to accept `type: ContentType` parameter — change `queueFtsUpdate(id, content, tags)` to `queueFtsUpdate(id, type, title, content, tags)`, update `FtsUpdate` type and `flushFtsUpdates()` to call `updateFtsEntry()`
- [ ] T008 Update all existing callers of `queueFtsUpdate()` / `insertFtsNote()` / `updateFtsContent()` across the codebase to use new signatures (search in `src/main/` for old function names)

### CRUD FTS Hooks

- [ ] T009 [P] Add FTS hooks in `src/main/ipc/tasks-handlers.ts`: after `tasks:create` → `insertFtsEntry(task.id, 'task', task.title, task.description ?? '', '')`, after `tasks:update` → `updateFtsEntry(...)`, after `tasks:delete` → `deleteFtsEntry(task.id)`, after `tasks:bulk-delete` → `deleteFtsEntry()` per task
- [ ] T010 [P] Add FTS hooks in `src/main/ipc/inbox-crud-handlers.ts`: after create → `insertFtsEntry(item.id, 'inbox', item.title, concatInboxContent(item), '')`, after update → `updateFtsEntry(...)`, after delete → `deleteFtsEntry(item.id)`. Add `concatInboxContent()` helper that joins `content` + `transcription`

### FTS Rebuild

- [ ] T011 Create `src/main/database/fts-rebuild.ts` with `rebuildFtsIndex(indexDb, dataDb, onProgress?)` — drops and recreates `fts_content`, iterates `note_cache` (type='note'/'journal' by date column), `tasks`, `inbox_items`, bulk inserts in transaction, queues content backfill via `queueFtsUpdate()`, emits progress events per `contracts/fts-api.md` RebuildProgress interface
- [ ] T012 Wire `search:rebuild-index` handler in `src/main/ipc/search-handlers.ts` to call `rebuildFtsIndex()` instead of the current stub (line ~220), emit `INDEX_REBUILD_STARTED/PROGRESS/COMPLETED` events via `webContents.send()`

### Contract Types

- [ ] T013 [P] Update `src/shared/contracts/search-api.ts`: add `SearchResultInbox` interface, add `'inbox'` to `SearchResult` union, add `'inbox'` to `SearchQuerySchema.types` enum, add `journals` + `inbox` to `QuickSearchResponse`, add `totalInbox` to `SearchStats`, add `types` + `projectId` to `AdvancedSearchSchema`, change `ADVANCED_SEARCH` handler return type to `SearchResponse`, add `SEARCH_INBOX` channel per `contracts/search-api-changes.md`

### Unified Search Query

- [ ] T014 Create `searchAll()` function in `src/shared/db/queries/search.ts`: single FTS5 MATCH against `fts_content` with optional type filter via WHERE `type IN (...)`, BM25 ranking `bm25(fts_content, 2.0, 1.0, 1.0)`, snippet generation, returns `FtsSearchResult[]` with `{id, type, title, snippet, score}`, then enriches with metadata via secondary queries against `note_cache` (for notes/journals) and `data.db` (for tasks/inbox)
- [ ] T015 Fix duplicate filter clauses bug in `advancedSearch()` at `src/shared/db/queries/search.ts` lines ~467-476 — delete the second copy of `operators.file` and `folder` filter blocks
- [ ] T016 Fix `SearchStats` in `src/main/ipc/search-handlers.ts` — replace hardcoded `totalTasks: 0` / `totalJournals: 0` with real counts from `SELECT COUNT(*) FROM fts_content WHERE type = ?` grouped by type

### IPC + Preload + Service Updates

- [ ] T017 Update `src/main/ipc/search-handlers.ts`: wire `search:query` to use `searchAll()`, update `search:quick` to return results for all 4 types (remove hardcoded `tasks: []`), implement `search:tasks` handler, add `search:inbox` handler
- [ ] T018 [P] Update `src/preload/index.ts` to expose new channels (`search:inbox`) and update return types for `search:quick` (add `journals` + `inbox` arrays)
- [ ] T019 [P] Update `src/renderer/src/services/search-service.ts` with updated types, add `searchInbox()` method, update `quickSearch()` return type to include `journals` + `inbox`

### Foundational Tests

- [ ] T020 Write unit tests for FTS CRUD in `src/main/database/__tests__/fts.test.ts`: test `insertFtsEntry`/`updateFtsEntry`/`deleteFtsEntry` for each content type (note, task, journal, inbox), test `searchFts` returns correct types with type filter, test BM25 ranking (title match scores higher than content match)
- [ ] T021 [P] Write unit tests for FTS rebuild in `src/main/database/__tests__/fts-rebuild.test.ts`: test full rebuild produces same results as incremental indexing, test progress callbacks fire, test rebuild handles empty tables

**Checkpoint**: Foundation ready — unified FTS index serving all 4 content types, all handlers returning multi-type results

---

## Phase 3: User Story 1 — Unified Cross-Content Search (P1) MVP

**Goal**: Search across all content types from a single search bar, results grouped by type

**Independent Test**: Open search modal (Cmd+K), type query matching content in multiple types, verify results from all types appear in grouped sections with counts

### Implementation

- [ ] T022 [US1] Create `src/renderer/src/components/search/search-result-group.tsx` — reusable grouped section component: type icon + section header (e.g., "Notes (5)") + list of result items + "View all N results" expand link when > 10 results (FR-010, FR-011, FR-012, FR-013)
- [ ] T023 [US1] Add type-specific result row rendering inside `search-result-group.tsx`: Note row (FileText icon + title + folder path + modified date), Task row (CheckSquare icon + title + project name + due date + completion badge), Journal row (BookOpen icon + date + snippet), Inbox row (Inbox icon + title + item type badge + snippet) per FR-015
- [ ] T024 [US1] Refactor `src/renderer/src/components/search/command-palette.tsx` to use `SearchResultGroup` — replace flat date-grouped note-only list with type-grouped sections, call `searchAll()` via search service, group results by `result.type`, render one `SearchResultGroup` per type
- [ ] T025 [US1] Change keyboard shortcut from Cmd+P to Cmd+K in `src/renderer/src/hooks/use-search-shortcut.ts` — update key check from `'p'` to `'k'` per FR-001
- [ ] T026 [US1] Update `src/renderer/src/hooks/use-search.ts` — update hook to call unified search service, return results typed as `SearchResult[]`, update debounce to 150ms (FR-009)

**Checkpoint**: Cmd+K opens modal → type query → results from notes, tasks, journal, inbox appear grouped by type. This is the MVP.

---

## Phase 4: User Story 2 — Instant Search Results (P1)

**Goal**: Results appear as user types with smooth updates and debouncing

**Independent Test**: Type progressively longer queries, verify results update within 100ms without flickering

### Implementation

- [ ] T027 [US2] Verify 150ms debounce in `src/renderer/src/components/search/command-palette.tsx` uses `useDeferredValue` or debounced state to prevent layout jumps — existing implementation likely covers this, may only need tuning
- [ ] T028 [US2] Add loading skeleton / transition state in `src/renderer/src/components/search/command-palette.tsx` to prevent flash of empty content between result updates (FR: results update without flickering)
- [ ] T029 [US2] Verify search performance meets SC-002 (< 100ms) by adding `performance.now()` timing in `useSearch` hook and logging when threshold exceeded in dev mode

**Checkpoint**: Typing produces smooth, debounced, flicker-free results

---

## Phase 5: User Story 3 — Navigate to Search Result (P1)

**Goal**: Clicking any search result opens the correct view/tab

**Independent Test**: Search for known content, click each result type, verify correct view opens

### Implementation

- [ ] T030 [US3] Extend `handleSelectSearchResult` in `src/renderer/src/App.tsx` to dispatch by `result.type`: keep existing note/journal logic, add task dispatch (open tasks tab with `entityId: task.id`), add inbox dispatch (open inbox tab with `entityId: item.id`)
- [ ] T031 [US3] Update `CommandPalette` props in `src/renderer/src/components/search/command-palette.tsx` — change `onSelectNote(noteId, path)` to `onSelectResult(result: SearchResult)` so the full typed result is passed to App.tsx for dispatch
- [ ] T032 [US3] Ensure `Cmd+Enter` opens result in new permanent tab for all types in `src/renderer/src/components/search/command-palette.tsx` — extend existing `onSelectNoteNewTab` to `onSelectResultNewTab(result: SearchResult)` with same type dispatch
- [ ] T033 [US3] Verify journal navigation still works — journal results should pass through existing `openNoteOrJournalTab()` path regex detection in `src/renderer/src/App.tsx`

**Checkpoint**: Click note → note tab. Click task → tasks view. Click journal → journal date. Click inbox → inbox view.

---

## Phase 6: User Story 4 — Filter Results by Content Type (P1)

**Goal**: Filter results to specific content type via UI chips or keyboard shortcuts

**Independent Test**: Search with results in multiple types, apply "Notes" filter, verify only notes shown, clear filter, verify all types return

### Implementation

- [ ] T034 [US4] Create `src/renderer/src/components/search/type-filter-bar.tsx` — horizontal chip bar with All / Notes / Tasks / Journal / Inbox toggle buttons, active state styling, controlled by `activeTypes: ContentType[]` prop, emits `onTypesChange` (FR-016)
- [ ] T035 [US4] Integrate `TypeFilterBar` into `src/renderer/src/components/search/command-palette.tsx` — wire `activeTypes` state to `searchAll()` types parameter, add "Clear all filters" button when any filter is active (FR-022)
- [ ] T036 [US4] Add Cmd+1 through Cmd+4 keyboard shortcuts in `src/renderer/src/components/search/command-palette.tsx` — Cmd+1=Notes, Cmd+2=Tasks, Cmd+3=Journal, Cmd+4=Inbox, toggle filter on/off (FR-026)
- [ ] T037 [US4] Ensure type filter state resets when search modal closes and reopens in `src/renderer/src/components/search/command-palette.tsx`

**Checkpoint**: Type filter chips work, Cmd+1-4 toggles types, clear restores all

---

## Phase 7: User Story 5 — Fuzzy Search with Typo Tolerance (P1)

**Goal**: Search finds results even with typos via client-side fuzzy matching

**Independent Test**: Search "meetng" (typo), verify "Team Meeting Notes" appears; verify exact matches rank above fuzzy

### Implementation

- [ ] T038 [US5] Create `src/renderer/src/lib/fuzzy-search.ts` — wrapper around `fuzzysort`: export `fuzzySearch(query, items, options)` that takes `{id, type, title}[]` array, returns scored results, configure threshold for ~70% similarity (FR-007)
- [ ] T039 [US5] Build in-memory title cache in `src/renderer/src/hooks/use-search.ts` — on search mount or periodic refresh, fetch all titles via `search:get-stats` or new lightweight endpoint, store as `{id, type, title}[]` for fuzzy fallback
- [ ] T040 [US5] Implement fuzzy fallback in `src/renderer/src/hooks/use-search.ts` — when FTS returns < 5 results for queries >= 3 chars, run `fuzzySearch()` on title cache, merge with FTS results, deduplicate by id, rank: FTS exact > FTS prefix > fuzzy (FR-035)
- [ ] T041 [US5] Write unit tests for fuzzy search in `src/renderer/src/lib/__tests__/fuzzy-search.test.ts`: test single-char typo detection ("meetng" → "meeting"), test threshold rejects dissimilar strings, test scoring order (exact > fuzzy)

**Checkpoint**: "meetng" finds "meeting", "quaterly" finds "quarterly", exact matches rank first

---

## Phase 8: User Story 6 — Keyboard Navigation (P2)

**Goal**: Full keyboard-driven navigation through search results

**Independent Test**: Open search, type query, Arrow Down/Up through results, Enter to open, Tab between sections, Escape to close

### Implementation

- [ ] T042 [US6] Verify Arrow Up/Down navigation works across type-grouped sections in `src/renderer/src/components/search/command-palette.tsx` — cmdk handles this natively with `loop` prop, but verify it crosses `Command.Group` boundaries (FR-024)
- [ ] T043 [US6] Implement Tab key to move focus between result sections in `src/renderer/src/components/search/command-palette.tsx` — add `onKeyDown` handler for Tab that jumps to first item of next `Command.Group` (FR-025)
- [ ] T044 [US6] Verify selection wrap at list boundaries in `src/renderer/src/components/search/command-palette.tsx` — last result Arrow Down → first result, first result Arrow Up → last result (FR-027, already `loop` prop)
- [ ] T045 [US6] Ensure visible focus indicator on selected result via CSS in `src/renderer/src/components/search/command-palette.tsx` — `aria-selected` styling with clear highlight ring/background (FR-028)

**Checkpoint**: Full keyboard-only workflow: Cmd+K → type → Arrow Down × N → Enter → item opens

---

## Phase 9: User Story 7 — Highlighted Matches in Results (P2)

**Goal**: Matching text visually highlighted in result snippets

**Independent Test**: Search for a term, verify `<mark>` highlighting in snippets with context

### Implementation

- [ ] T046 [US7] Ensure FTS5 `snippet()` output renders correctly in `src/renderer/src/components/search/search-result-group.tsx` — `<mark>` tags from server-side snippet should render with highlight styling, use `dangerouslySetInnerHTML` with `escapeHtml` pre-processing (existing `safeHighlight()` pattern from search-service.ts) (FR-014)
- [ ] T047 [US7] Verify snippet context length shows ~50 chars before/after match with `...` separators in FTS5 snippet config (already `snippet(fts_content, 3, '<mark>', '</mark>', '...', 30)` — may need to increase token window to ~50) in `src/main/database/fts.ts` or `src/shared/db/queries/search.ts` (FR-014)
- [ ] T048 [US7] Style `<mark>` elements in search results CSS — background highlight color consistent with app theme, in `src/renderer/src/components/search/search-result-group.tsx` or global styles

**Checkpoint**: Search terms visually highlighted in snippets with surrounding context

---

## Phase 10: User Story 8 — Recent Searches (P2)

**Goal**: Recent searches persist across app sessions

**Independent Test**: Perform searches, close app, reopen, verify recent searches appear on empty search input

### Implementation

- [ ] T049 [P] [US8] Create Drizzle schema `src/shared/db/schema/recent-searches.ts` — `recent_searches` table with `id` (autoincrement PK), `query` (text NOT NULL unique), `result_count` (integer), `searched_at` (text, default now) per `data-model.md`
- [ ] T050 [US8] Generate Drizzle migration for `recent_searches` table in `data.db` — run `pnpm drizzle-kit generate` for data schema, verify migration SQL
- [ ] T051 [US8] Replace in-memory `recentSearches` array in `src/main/ipc/search-handlers.ts` with SQLite queries — `search:add-recent` does UPSERT (update `searched_at` + `result_count` on conflict), `search:get-recent` does SELECT ordered by `searched_at` DESC LIMIT 20, `search:clear-recent` does DELETE all
- [ ] T052 [US8] Enforce 20-entry limit in `search:add-recent` handler — after UPSERT, DELETE entries where rowid not in top 20 by `searched_at` (FR-029)
- [ ] T053 [US8] Verify recent searches display on empty input in `src/renderer/src/components/search/command-palette.tsx` — existing UI shows recent searches when query is empty (FR-030), verify it uses updated `search:get-recent` IPC
- [ ] T054 [US8] Add "Clear history" button in `src/renderer/src/components/search/command-palette.tsx` recent searches section — calls `search:clear-recent` (FR-033)

**Checkpoint**: Search → close app → reopen → recent searches persist. Clear works. Max 20.

---

## Phase 11: User Story 9 — Search by Tags (P2)

**Goal**: Filter search results by tags with autocomplete

**Independent Test**: Search for a term, apply tag filter, verify only tagged content appears

### Implementation

- [ ] T055 [US9] Add tag filter combobox in `src/renderer/src/components/search/command-palette.tsx` filter bar — multi-select with autocomplete via existing `search:suggestions` IPC, displays selected tags as chips, emits `tags: string[]` to search query (FR-017)
- [ ] T056 [US9] Wire tag filter to `searchAll()` in `src/shared/db/queries/search.ts` — add `tags?: string[]` parameter, JOIN with `note_tags` for notes, apply OR logic across selected tags (FR: results matching ANY selected tag) (FR-017)
- [ ] T057 [US9] Fix tag filtering performance in `src/shared/db/queries/search.ts` — move existing post-query JavaScript tag filtering into SQL JOIN with `note_tags` table so LIMIT applies after tag filter, not before (fixes known bug from research.md)

**Checkpoint**: Tag filter narrows results, autocomplete suggests tags, OR logic for multi-tag

---

## Phase 12: User Story 10 — Date Range Filtering (P2)

**Goal**: Filter search results by date range with presets

**Independent Test**: Apply "This Week" preset, verify only content from current week appears

### Implementation

- [ ] T058 [US10] Ensure date range filter in `src/renderer/src/components/search/command-palette.tsx` includes all spec presets: Today, This Week, This Month, Custom date picker (FR-018) — date filter already partially exists, verify preset options match spec
- [ ] T059 [US10] Wire date range to `searchAll()` in `src/shared/db/queries/search.ts` — add `dateFrom/dateTo` WHERE clause: for notes/journals use `note_cache.modified_at`, for tasks use `tasks.modified_at`, for inbox use `inbox_items.created_at`, combine with AND logic against other filters (FR-021)
- [ ] T060 [US10] Verify compound filtering works: type + tag + date all apply together with AND logic in `src/shared/db/queries/search.ts` (FR-021)

**Checkpoint**: Date presets filter correctly, combine with text search via AND logic

---

## Phase 13: User Story 11 — Prefix and Phrase Search (P3)

**Goal**: Support partial word matches and exact phrase matching with quotes

**Independent Test**: Search "meet" → finds "meeting" (prefix). Search `"project alpha"` → only exact phrase matches.

### Implementation

- [ ] T061 [US11] Verify prefix matching works in `searchFts()` query builder in `src/shared/db/queries/search.ts` — FTS5 already supports `meet*` prefix syntax, ensure `buildPrefixQuery()` appends `*` for prefix matching (FR-006)
- [ ] T062 [US11] Implement exact phrase matching when query is enclosed in double quotes in `src/shared/db/queries/search.ts` — detect `"quoted phrase"` in query, pass as FTS5 phrase query without prefix expansion (FR-008)
- [ ] T063 [US11] Verify case-insensitive matching in `src/shared/db/queries/search.ts` — FTS5 with `unicode61` tokenizer is case-insensitive by default, add unit test confirming "MEETING" matches "meeting" (FR-005)

**Checkpoint**: "meet" → finds "meeting", `"project alpha"` → exact phrase only, case-insensitive

---

## Phase 14: User Story 12 — Filter by Project/Folder (P3)

**Goal**: Narrow search results to specific projects (tasks) or folders (notes)

**Independent Test**: Select a project filter, verify only tasks from that project appear; select folder filter, verify only notes from that folder appear

### Implementation

- [ ] T064 [US12] Add project filter dropdown in `src/renderer/src/components/search/command-palette.tsx` filter bar — fetch projects via existing `projects:list` IPC, display as select/combobox, wire to `searchAll()` projectId parameter (FR-019)
- [ ] T065 [US12] Add folder filter to `searchAll()` in `src/shared/db/queries/search.ts` — for notes, filter by `note_cache.path LIKE :folder%`, reuse existing folder filter logic from `advancedSearch()` (FR-020)
- [ ] T066 [US12] Wire project filter in `searchAll()` in `src/shared/db/queries/search.ts` — for tasks, filter by `tasks.project_id = :projectId`, no-op for non-task types (FR-019)
- [ ] T067 [US12] Verify all filters combine with AND logic — type + tag + date + project + folder + text all composable in `src/shared/db/queries/search.ts` (FR-021)

**Checkpoint**: Project filter scopes tasks, folder filter scopes notes, all filters AND together

---

## Phase 15: Polish & Cross-Cutting Concerns

**Purpose**: Performance, accessibility, edge cases, production readiness

- [ ] T068 Performance benchmark: create test script that indexes 10k items (mixed types) and measures search latency — verify SC-002 (< 100ms) and SC-003 (< 200ms)
- [ ] T069 [P] Add index rebuild progress reporting in `src/main/database/fts-rebuild.ts` — emit `INDEX_REBUILD_PROGRESS` events with `{phase, current, total, percentage}` via BrowserWindow.webContents
- [ ] T070 [P] Implement `onSearchIndexCorrupt` recovery in `src/main/ipc/search-handlers.ts` — wrap FTS queries in try/catch, detect "database disk image is malformed" errors, trigger auto-rebuild, emit `INDEX_CORRUPT` event
- [ ] T071 Accessibility audit on `src/renderer/src/components/search/command-palette.tsx` — verify ARIA labels on groups/items, `role="listbox"` on results, `aria-selected` on focused item, screen reader announces section headers (FR-028)
- [ ] T072 [P] Edge case hardening in `src/shared/db/queries/search.ts` — handle special characters in queries (escape FTS5 syntax chars), truncate queries > 500 chars with notification, handle empty results with helpful message
- [ ] T073 [P] Extract `command-palette.tsx` if > 500 LOC — split into `command-palette.tsx` (shell + state), `search-result-group.tsx` (already extracted), `type-filter-bar.tsx` (already extracted), `search-filters.tsx` (tag + date + project + folder bar)
- [ ] T074 Run `quickstart.md` validation — verify all documented file paths exist, architecture diagram matches implementation, all phases deliver independently

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on T001 (fuzzysort install) only for later phases; FTS migration is independent
- **US1 (Phase 3)**: Depends on Phase 2 complete — foundational backend must serve multi-type results
- **US2 (Phase 4)**: Depends on Phase 3 — needs multi-type results to verify smooth updates
- **US3 (Phase 5)**: Depends on Phase 3 — needs result type dispatch from grouped UI
- **US4 (Phase 6)**: Depends on Phase 3 — needs grouped UI to filter
- **US5 (Phase 7)**: Depends on Phase 2 — needs typed results but NOT the grouped UI
- **US6 (Phase 8)**: Depends on Phase 3 — needs grouped sections for Tab navigation
- **US7 (Phase 9)**: Depends on Phase 2 — snippet highlighting is backend + CSS
- **US8 (Phase 10)**: Depends on Phase 2 only — fully independent of UI phases
- **US9 (Phase 11)**: Depends on Phase 3 — needs filter bar in grouped UI
- **US10 (Phase 12)**: Depends on Phase 3 — needs filter bar in grouped UI
- **US11 (Phase 13)**: Depends on Phase 2 — FTS query-level changes only
- **US12 (Phase 14)**: Depends on Phase 3 — needs filter bar in grouped UI
- **Polish (Phase 15)**: Depends on all desired user stories complete

### User Story Dependencies

```
Phase 1 (Setup) ─────────────────────────────────────────────┐
    │                                                         │
Phase 2 (Foundational) ──────────────────────────────────────┤
    │                                                         │
    ├── Phase 3 (US1: Unified Search) ── MVP ────────────────┤
    │       │                                                 │
    │       ├── Phase 4 (US2: Instant Results)               │
    │       ├── Phase 5 (US3: Navigation)                    │
    │       ├── Phase 6 (US4: Type Filters)                  │
    │       ├── Phase 8 (US6: Keyboard Nav)                  │
    │       ├── Phase 11 (US9: Tags)                         │
    │       ├── Phase 12 (US10: Date Range)                  │
    │       └── Phase 14 (US12: Project/Folder)              │
    │                                                         │
    ├── Phase 7 (US5: Fuzzy) ── parallel with US1            │
    ├── Phase 9 (US7: Highlights) ── parallel with US1       │
    ├── Phase 10 (US8: Recent Searches) ── parallel with US1 │
    └── Phase 13 (US11: Prefix/Phrase) ── parallel with US1  │
                                                              │
Phase 15 (Polish) ◄───────────────────────────────────────────┘
```

### Within Each User Story

- Contract/schema changes before query logic
- Query logic before UI integration
- Core implementation before edge case handling

### Parallel Opportunities

**After Phase 2 completes — these can ALL run in parallel:**

- US1 (Unified Search UI) — different files than US5/US7/US8/US11
- US5 (Fuzzy Search) — renderer-only, `fuzzy-search.ts` + `use-search.ts`
- US7 (Highlights) — CSS + snippet config, no conflict
- US8 (Recent Searches) — data.db schema + handlers, fully independent
- US11 (Prefix/Phrase) — query builder in `search.ts`, minimal overlap

**After Phase 3 (US1) completes — these can ALL run in parallel:**

- US2 (Instant Results) — performance tuning
- US3 (Navigation) — `App.tsx` only
- US4 (Type Filters) — `type-filter-bar.tsx` + `command-palette.tsx`
- US6 (Keyboard Nav) — `command-palette.tsx` keyboard handlers
- US9 (Tags) — filter bar addition
- US10 (Date Range) — filter bar addition
- US12 (Project/Folder) — filter bar addition

---

## Parallel Example: Foundational Phase

```
# These can all run in parallel (different files):
Agent A: T009 — FTS hooks in tasks-handlers.ts
Agent B: T010 — FTS hooks in inbox-crud-handlers.ts
Agent C: T013 — Contract type updates in search-api.ts
Agent D: T018 — Preload bridge updates in index.ts
Agent E: T019 — Renderer service updates in search-service.ts
```

## Parallel Example: After Phase 2

```
# These stories can run in parallel:
Agent A: Phase 3 (US1) — command-palette.tsx refactor
Agent B: Phase 7 (US5) — fuzzy-search.ts + use-search.ts
Agent C: Phase 10 (US8) — recent-searches schema + handlers
Agent D: Phase 13 (US11) — search.ts query builder
```

---

## Implementation Strategy

### MVP First (Phase 1 → 2 → 3 only)

1. Complete Phase 1: Setup (install deps, delete dead code)
2. Complete Phase 2: Foundational (FTS migration, hooks, contracts, queries)
3. Complete Phase 3: User Story 1 (grouped multi-type UI)
4. **STOP and VALIDATE**: Cmd+K → type query → results from all types → grouped display
5. This covers: FR-001 through FR-015, SC-001 through SC-003, SC-006, SC-010

### Incremental Delivery (P1 stories)

1. Setup + Foundational → backbone ready
2. US1 → MVP: unified cross-type search works
3. US3 → Navigation: results are actionable
4. US4 → Type filters: users can narrow results
5. US5 → Fuzzy: typo tolerance
6. US2 → Instant: verify performance targets

### Full Feature (all P1 + P2 + P3)

7. US6 → Keyboard nav polish
8. US7 → Highlight styling
9. US8 → Recent searches persistence
10. US9 → Tag filtering
11. US10 → Date range filtering
12. US11 → Prefix/phrase search
13. US12 → Project/folder scoping
14. Polish → benchmarks, a11y, edge cases

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story independently testable after its phase completes
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- FTS migration (T005) is the critical path — everything depends on it
- `command-palette.tsx` will likely need extraction (T073) after US1+US4+US9+US10+US12 add code
