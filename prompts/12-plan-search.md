# Global Search Implementation Plan

Technical architecture, technology decisions, and implementation strategy for cross-content search and discovery.

````
/speckit.plan @specs/007-global-search/spec.md

Plan the implementation of Memry's Global Search System with these technology decisions and constraints:

## REFERENCE DOCUMENTS

- **Specification**: specs/007-global-search/spec.md (12 user stories, 36 functional requirements, 10 success criteria)
- **Feature Prompt**: prompts/07-specify-search.md (data models, UI wireframes, acceptance criteria)
- **Constitution**: prompts/00-constitution.md (governing principles: local-first, offline-first, performance targets)
- **Existing Architecture**: CLAUDE.md (current codebase patterns and conventions)

## EXISTING CODEBASE — WHAT'S ALREADY BUILT

Search is partially implemented. The plan must build on what exists, fix known issues, and close gaps.

### FTS5 Infrastructure (Notes Only) ✅
- **`src/main/database/fts.ts`**: `fts_notes` virtual table with `tokenize='porter unicode61'`
  - BM25 ranking: `bm25(fts_notes, 2.0, 1.0, 1.0)` — title weight 2x
  - Snippet generation: `snippet(fts_notes, 2, '<mark>', '</mark>', '...', 30)`
  - Three SQLite triggers on `note_cache` for INSERT/DELETE/UPDATE(title)
  - Content and tags are NOT auto-synced by triggers — must use `updateFtsContent()` / `insertFtsNote()`
- **`src/main/database/fts-queue.ts`**: In-memory debounce queue (2-second flush), per-noteId deduplication

### Search Queries ✅ (Notes) / ❌ (Tasks, Journal, Inbox)
- **`src/shared/db/queries/search.ts`**:
  - `searchNotes()` — FTS5 + BM25, joins `note_cache`, tag/folder filters
  - `quickSearch()` — same FTS path, limit 5
  - `advancedSearch()` — full operator support: `path:`, `file:`, `tags:`, `[property]:value`, date range, sort
  - `getSuggestions()` — prefix matches from `note_tags` + `note_cache` titles
  - `findNotesByTag()` / `findBacklinks()`
  - ⚠️ **Known bug**: duplicate filter clauses in `advancedSearch()` (lines ~456–476)

### IPC Handlers ✅
- **`src/main/ipc/search-handlers.ts`**: 12 channels registered
  - `search:query`, `search:quick`, `search:suggestions`, `search:advanced`
  - `search:get-recent`, `search:clear-recent`, `search:add-recent` (in-memory only — lost on restart)
  - `search:get-stats`, `search:rebuild-index` (TODO stub — no actual rebuild)
  - `search:notes`, `search:find-by-tag`, `search:find-backlinks`
- All handlers use `createValidatedHandler()` / `createHandler()` with Zod schemas

### Preload Bridge ✅
- **`src/preload/index.ts`**: `window.api.search` exposes all 12 channels
- Event listeners: `onSearchIndexRebuildStarted/Progress/Completed/Corrupt`

### Renderer Layer ✅ (Partial)
- **`src/renderer/src/services/search-service.ts`**: Typed wrapper + `highlightTerms()`, `safeHighlight()`
- **`src/renderer/src/hooks/use-search.ts`**: `useSearch()`, `useQuickSearch()`, `useSearchStats()`, `useRecentSearches()`
- **`src/renderer/src/hooks/use-search-shortcut.ts`**: Registers Cmd+P globally
- **`src/renderer/src/lib/search-query-parser.ts`**: Client-side operator parser

### UI Components ✅ (Notes) / ❌ (Multi-type results)
- **`src/renderer/src/components/search/command-palette.tsx`**: Primary search UI
  - `cmdk`-based Dialog, 65vh height
  - Filters toolbar: sort, title-only toggle, folder, date range
  - Operator suggestions, grouped-by-date results
  - Default: `titleOnly=true`, `sortBy='modified'`
  - Opens via `useSearchShortcut` (Cmd+P)
- **`src/renderer/src/components/search/search-modal.tsx`**: Legacy modal (likely superseded)
- **`src/renderer/src/components/search/search-result-item.tsx`**: Note-only result row

### App Integration ✅
- **`src/renderer/src/App.tsx`**: `searchOpen` state lifted to App, CommandPalette rendered at root
- `handleSelectSearchResult` / `handleSelectSearchResultNewTab` for tab navigation

### Database Schemas (Drizzle ORM)
- **`src/shared/db/schema/notes-cache.ts`**: `note_cache`, `note_tags`, `note_links`, `note_properties`
- **`src/shared/db/schema/data-schema.ts`**: Tasks, projects, statuses, settings (in `data.db`)
- **`src/shared/db/schema/index-schema.ts`**: Re-exports notes-cache; `fts_notes` created outside Drizzle

## KNOWN GAPS & ISSUES TO ADDRESS

### Critical Gaps
1. **Tasks not searchable** — `tasks: []` hardcoded in quick search response; no FTS index for tasks
2. **Journal entries not searchable** — no indexing or search queries for journal content
3. **Inbox items not searchable** — no indexing or search queries for inbox items
4. **Recent searches not persisted** — in-memory array, lost on app restart (violates FR-032)
5. **`search:rebuild-index` is a stub** — logger only, no actual rebuild logic

### Bugs to Fix
6. **Duplicate filter clauses** in `advancedSearch()` (lines ~456–476 in queries/search.ts)
7. **`SearchStats.totalTasks`** and **`totalJournals`** always return `0`
8. **Legacy `search-modal.tsx`** coexists with `command-palette.tsx` — decide which to keep

### Missing Features
9. **Fuzzy search** — spec requires 70% similarity threshold; current FTS5 is prefix-only, no fuzzy
10. **Cross-type result grouping** — UI shows only notes; needs grouped sections per FR-010
11. **Type filter shortcuts** — Cmd+1 through Cmd+4 not implemented (FR-026)
12. **Keyboard shortcut mismatch** — code uses Cmd+P, spec says Cmd+K (FR-001)

## TECHNOLOGY STACK DECISIONS

### Full-Text Search Engine

**Choice: SQLite FTS5 (already in use)**
- Porter stemmer + unicode61 tokenizer (already configured)
- BM25 ranking algorithm (already configured)
- Runs in Electron main process alongside better-sqlite3
- Zero external dependencies

**Architecture Decision: Single unified FTS table vs. per-type tables**

Option A — **Single `fts_content` table** (Recommended):
```sql
CREATE VIRTUAL TABLE fts_content USING fts5(
  id UNINDEXED,
  type UNINDEXED,        -- 'note' | 'task' | 'journal' | 'inbox'
  title,
  content,
  tags,
  tokenize='porter unicode61'
);
````

- Pros: Single query returns cross-type results; simpler ranking; natural grouping
- Cons: Larger table; need to manage heterogeneous content

Option B — **Per-type FTS tables** (`fts_notes`, `fts_tasks`, `fts_journal`, `fts_inbox`):

- Pros: Each table optimized for its content shape; independent rebuild
- Cons: Need UNION queries for cross-type search; separate ranking curves; more complex

**Recommendation**: Migrate from current `fts_notes` to unified `fts_content`. A single table simplifies the cross-type search query and produces consistent BM25 rankings. The `type` column (UNINDEXED) enables efficient filtering without affecting text search.

### Fuzzy Search

**Choice: fuzzysort (client-side, for title matching)**

- FTS5 handles prefix/phrase/stemmed matches (the heavy lifting)
- `fuzzysort` provides typo tolerance on titles/short strings in the renderer
- Combine: FTS5 results + fuzzysort fallback for near-misses
- No additional native dependencies

**Alternatives Considered:**

- sqlite-vss / fts5-trigram: Requires custom SQLite extension build — complex in Electron
- Fuse.js: Heavier, slower on large datasets than fuzzysort
- Levenshtein in SQL: Too slow for real-time search at scale

### Recent Searches Persistence

**Choice: SQLite (data.db)**

- Add `recent_searches` table in data.db (survives restarts)
- Already have Drizzle ORM + migration pipeline
- Consistent with how settings and other user state is stored

### Result Highlighting

**Choice: FTS5 `snippet()` + custom renderer highlighting**

- Server-side: `snippet()` extracts context around matches with `<mark>` tags
- Client-side: `safeHighlight()` (already exists) for additional rendering
- Safe against XSS via `escapeHtml()` (already exists)

## ARCHITECTURE CONSTRAINTS

### Electron Process Model (Non-Negotiable)

- All SQLite operations in main process
- Renderer accesses data exclusively via IPC (`window.api.search.*`)
- No direct database access from renderer
- Preload bridge must expose all new channels

### IPC Pattern (Must Follow)

```typescript
// Handler pattern (src/main/ipc/validate.ts)
createValidatedHandler(schema, async (validated) => { ... })
createHandler(async () => { ... })
createStringHandler(async (str) => { ... })
```

- All inputs validated with Zod schemas
- Error extraction via `extractErrorMessage(err, fallback)`
- Logging via `createLogger('Search')`

### Database Architecture

- **index.db**: FTS index, note cache — rebuildable from files (search index lives here)
- **data.db**: Tasks, projects, statuses, settings, recent searches — source of truth
- Both managed by Drizzle ORM with migration pipeline
- FTS virtual tables created outside Drizzle (raw better-sqlite3)

### Performance Targets (from spec + constitution)

| Operation                 | Target       | Notes                      |
| ------------------------- | ------------ | -------------------------- |
| Search modal open         | < 50ms       | SC-006                     |
| First results appear      | < 100ms      | SC-002, after typing stops |
| Full search complete      | < 200ms      | SC-003, up to 10,000 items |
| FTS index update          | Non-blocking | Must not freeze UI         |
| Index rebuild (10k items) | < 30s        | Background with progress   |

### Offline Requirement

- 100% feature parity offline (SC-010)
- All search data is local (SQLite)
- No network calls for any search operation

## INTEGRATION REQUIREMENTS

### With Existing Notes System

- Notes already indexed in `fts_notes` — migrate to `fts_content` or keep + add new tables
- `note_cache` table has title, snippet, tags, path, timestamps
- File watcher triggers → FTS queue → debounced index update (already works)

### With Task System

- Tasks stored in `data.db`: `tasks` table via Drizzle schema
- Fields to index: `title`, `description`
- Must listen for task CRUD events to update FTS index
- Navigation: clicking task result → open tasks view with task selected

### With Journal System

- Journal entries are markdown files in `vault/journal/YYYY-MM-DD.md`
- Content stored in `note_cache` (journal entries are a note subtype with `fileType`)
- If already in note_cache, may already be partially indexed — verify
- Navigation: clicking journal result → open journal view at that date

### With Inbox System

- Inbox items stored in `data.db`: `inbox_items` table
- Fields to index: `title`, `content/description`
- Must listen for inbox CRUD events to update FTS index
- Navigation: clicking inbox result → open inbox with item highlighted

### With Tab System

- `App.tsx` already has `handleSelectSearchResult` and `handleSelectSearchResultNewTab`
- Must extend to handle non-note result types (tasks, journal, inbox)
- Each type needs its own navigation strategy

## PHASED IMPLEMENTATION APPROACH

### Phase 1: Unified FTS Index

- [ ] Design unified FTS table schema (single vs. per-type — decide)
- [ ] Create migration to add new FTS tables/modify existing
- [ ] Build indexing pipeline for tasks (listen to CRUD, update FTS)
- [ ] Build indexing pipeline for journal entries (verify note_cache coverage)
- [ ] Build indexing pipeline for inbox items (listen to CRUD, update FTS)
- [ ] Implement `search:rebuild-index` (currently a stub)
- [ ] Fix duplicate filter clauses bug in `advancedSearch()`
- [ ] Unit tests for all indexing pipelines

### Phase 2: Cross-Type Search Queries

- [ ] Create unified search query that returns results from all types
- [ ] Implement cross-type BM25 ranking with type-aware weighting
- [ ] Add type-specific metadata to search results (project, due date, journal date, etc.)
- [ ] Update `SearchResult` types to support all content types
- [ ] Update IPC handlers to use unified search
- [ ] Update Zod schemas for new query/result shapes
- [ ] Fix `SearchStats` to return real counts for tasks/journals

### Phase 3: Fuzzy Search

- [ ] Integrate fuzzysort (or chosen library) for title matching
- [ ] Combine FTS5 results with fuzzy fallback
- [ ] Implement 70% similarity threshold (configurable)
- [ ] Ensure exact matches rank above fuzzy matches (FR-035)
- [ ] Performance test: fuzzy search within 200ms on 10k items

### Phase 4: UI — Multi-Type Results & Filtering

- [ ] Refactor `command-palette.tsx` for grouped multi-type results
- [ ] Add type section headers with result counts (FR-010, FR-011)
- [ ] Add "View all" expand per section (FR-013)
- [ ] Add type filter chips/checkboxes (FR-016)
- [ ] Add tag filter with autocomplete (FR-017)
- [ ] Add date range filter with presets (FR-018)
- [ ] Add project/folder filter dropdowns (FR-019, FR-020)
- [ ] Add "Clear all filters" action (FR-022)
- [ ] Keyboard shortcut Cmd+1–4 for type filters (FR-026)
- [ ] Resolve Cmd+P vs Cmd+K shortcut (FR-001)
- [ ] Remove or archive legacy `search-modal.tsx`

### Phase 5: Navigation for All Types

- [ ] Implement task result click → open task view
- [ ] Implement journal result click → navigate to date
- [ ] Implement inbox result click → highlight inbox item
- [ ] Extend `handleSelectSearchResult` for multi-type dispatch
- [ ] Support Cmd+Enter / Shift+Enter for new-tab navigation

### Phase 6: Recent Searches Persistence

- [ ] Add `recent_searches` table to data.db (Drizzle migration)
- [ ] Migrate from in-memory array to SQLite-backed storage
- [ ] Persist across app sessions (FR-032)
- [ ] Limit to 20 unique entries (FR-029)
- [ ] Display on empty search input (FR-030)
- [ ] Clear history function (FR-033)

### Phase 7: Polish & Performance

- [ ] Performance benchmark: 10k items, all types indexed
- [ ] Optimize FTS index update to never block UI
- [ ] Add progress reporting for index rebuild
- [ ] Implement `onSearchIndexCorrupt` handler (recovery)
- [ ] Accessibility audit: keyboard nav, focus indicators, ARIA labels
- [ ] Edge case hardening: special chars, long queries, empty states

## TESTING STRATEGY

### Unit Tests (Vitest)

- [ ] FTS indexing: insert, update, delete for each content type
- [ ] Search query builder: operator parsing, filter combination
- [ ] BM25 ranking: exact > prefix > fuzzy ordering
- [ ] Fuzzy matching: typo detection at 70% threshold
- [ ] Recent searches: CRUD, deduplication, limit enforcement
- [ ] `escapeSearchQuery()` and `buildPrefixQuery()` edge cases

### Integration Tests

- [ ] Cross-type search returns results from all types
- [ ] Type filters correctly narrow results
- [ ] Date range filters produce correct date boundaries
- [ ] Tag + type + date compound filters apply AND logic
- [ ] Index rebuild from scratch produces identical results
- [ ] FTS queue debouncing under rapid updates

### E2E Tests (Playwright)

- [ ] Cmd+K opens search modal within 50ms
- [ ] Type query → results appear → click → item opens
- [ ] Apply type filter → results narrow → clear → results restore
- [ ] Keyboard: Arrow Down/Up through results → Enter to open
- [ ] Recent searches appear on empty input, persist across restart
- [ ] Fuzzy match: "meetng" → finds "meeting"

### Performance Tests

- [ ] Benchmark: 10k items indexed, search < 200ms
- [ ] Benchmark: FTS index update < 50ms per item
- [ ] Benchmark: Index rebuild < 30s for 10k items
- [ ] Memory profile: FTS index size reasonable at scale

## OPEN QUESTIONS FOR PLANNING

1. **Unified FTS vs. per-type tables**: Single `fts_content` is simpler, but per-type tables allow independent rebuild and type-specific tokenization. Which approach?
2. **Keyboard shortcut**: Spec says Cmd+K, code uses Cmd+P. Which to standardize on? (Cmd+K is more common for search; Cmd+P is file-palette convention)
3. **Journal indexing**: Are journal entries already in `note_cache` (as fileType=journal)? If so, they may already be partially in `fts_notes`
4. **Task description format**: Are task descriptions plain text or rich text? Affects how we extract searchable content
5. **Inbox content**: What fields on inbox items are searchable? Is there a `content` field or just `title`?
6. **Semantic search (P3)**: Out of scope for this plan? Or lay groundwork (embedding column in FTS table)?
7. **Legacy search-modal.tsx**: Delete entirely, or keep as a simpler "quick open" for notes only?

## SUCCESS METRICS

- [ ] All 12 user stories have passing acceptance tests
- [ ] All 36 functional requirements implemented
- [ ] All 10 success criteria measurable and verified
- [ ] Search across notes + tasks + journal + inbox from single input
- [ ] < 200ms for full cross-type search on 10k items
- [ ] Fuzzy matching catches 90% of single-character typos (SC-007)
- [ ] 100% offline feature parity (SC-010)
- [ ] Recent searches persist across sessions (FR-032)
- [ ] Zero regressions in existing notes search

```

```
