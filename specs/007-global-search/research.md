# Research: Global Search System

**Branch**: `007-global-search` | **Date**: 2026-03-03 | **Spec**: [spec.md](./spec.md)

## Resolved Questions

### Q1: Unified FTS vs. Per-Type Tables

**Decision**: Unified `fts_content` table in `index.db`

**Rationale**:

- Single FTS5 MATCH query returns cross-type results with consistent BM25 ranking
- Per-type UNION queries produce incomparable BM25 scores (different corpus statistics per table)
- `type` UNINDEXED column supports WHERE filtering without affecting text search
- Single rebuild operation; index.db is a rebuildable cache anyway
- Simpler query code: one query vs. 4-way UNION

**Alternatives Rejected**:

- Per-type tables (`fts_notes`, `fts_tasks`, `fts_journal`, `fts_inbox`): BM25 scores not comparable across tables; UNION queries complex; independent rebuild not worth the tradeoff since total rebuild < 30s for 10k items

**Migration Path**: Create `fts_content` → populate from `note_cache` + `tasks` + `inbox_items` → drop `fts_notes` + triggers → create new triggers on `note_cache` → add FTS hooks in task/inbox CRUD handlers

### Q2: Keyboard Shortcut — Cmd+K vs Cmd+P

**Decision**: Cmd+K (macOS) / Ctrl+K (Windows/Linux)

**Rationale**:

- Spec explicitly requires Cmd+K (FR-001)
- Cmd+K is industry standard for search/command palettes (Linear, Notion, Slack)
- Cmd+P is file-picker convention (VS Code file open)
- Current code uses Cmd+P — must update `use-search-shortcut.ts`

### Q3: Journal Indexing — Already Covered?

**Decision**: Yes — journals are already indexed. No additional indexing pipeline needed.

**Findings**:

- Journal entries live in `note_cache` table with `date` column set (`YYYY-MM-DD`)
- Regular notes have `date = NULL`
- Same `syncNoteToCache()` pipeline → same FTS triggers → already in `fts_notes`
- Path pattern: `journal/YYYY-MM-DD.md`, detected by `isJournalPath()` in watcher
- ID convention: `j${date}` (e.g., `j2026-03-03`)
- **Distinction in search results**: Filter on `date IS NOT NULL` or match path against `JOURNAL_DATE_PATTERN`

**Impact**: When migrating to `fts_content`, journal entries will be inserted with `type = 'journal'` based on `note_cache.date IS NOT NULL`. No separate indexing pipeline needed.

### Q4: Task Description Format

**Decision**: Plain text — can be indexed directly.

**Findings**:

- Task descriptions rendered via raw `<textarea>` in `task-description.tsx`
- Schema validation: `z.string().max(10000)`, no format constraints
- No rich text editor (no ProseMirror, BlockNote, TipTap involvement)
- Can insert directly into FTS without HTML stripping or markdown parsing

### Q5: Inbox Searchable Fields

**Decision**: Index `title`, `content`, and `transcription`.

**Findings from `inbox.ts` schema**:
| Field | Type | Searchable? |
|-------|------|-------------|
| `title` | text NOT NULL | Yes — always present |
| `content` | text nullable | Yes — text excerpt |
| `transcription` | text nullable | Yes — voice/audio items |
| `source_title` | text nullable | No — redundant with title |
| `source_url` | text nullable | No — URL, not prose |
| `type` | text NOT NULL | No — enum (link, note, image, voice, etc.) |

**Concatenation strategy for FTS content column**: `[content] [transcription]` (space-joined, nulls skipped)

### Q6: Semantic Search

**Decision**: Out of scope. No groundwork needed.

**Rationale**:

- FTS5 + fuzzy covers all 12 user stories and 36 FRs
- Embedding columns would require a vector extension (sqlite-vss) — complex in Electron
- Can be added later without schema changes (separate embedding table)

### Q7: Legacy search-modal.tsx

**Decision**: Delete entirely, along with `search-result-item.tsx`.

**Findings**:

- `SearchModal` is exported but never imported by any page/layout component
- `App.tsx` renders `CommandPalette`, not `SearchModal`
- `SearchResultItem` is only used by `SearchModal`
- Both are dead code with orphaned tests
- `CommandPalette` renders its own inline result JSX

## Additional Findings

### Contract Types — Existing but Incomplete

`src/shared/contracts/search-api.ts` already defines:

- `SearchResultNote`, `SearchResultTask`, `SearchResultJournal` — discriminated union
- **Missing**: `SearchResultInbox` type
- `SearchQuerySchema.types` enum: `['note', 'task', 'journal']` — missing `'inbox'`
- `QuickSearchResponse`: only `notes` + `tasks` — missing `journals` + `inbox`
- `SEARCH_TASKS` channel defined but not implemented in handlers

### Cross-Database FTS Sync

- `fts_content` will live in `index.db` (rebuildable cache)
- Tasks/inbox live in `data.db` — SQLite triggers can't span databases
- **Solution**: Application-level hooks in task/inbox CRUD handlers → call FTS update
- Same pattern as note content sync (triggers only handle title; content goes through explicit `queueFtsUpdate()`)
- Extend FTS queue to accept `type` parameter: `queueFtsUpdate(id, type, title, content, tags)`

### Inbox CRUD Events

IPC handlers at `src/main/ipc/inbox-crud-handlers.ts` + `inbox-handlers.ts`:

- `inbox:create`, `inbox:update`, `inbox:delete`, `inbox:archive`
- Can hook FTS updates into these handlers post-mutation

### Task CRUD Events

IPC handlers at `src/main/ipc/tasks-handlers.ts`:

- `tasks:create` → emits `CREATED`
- `tasks:update` → emits `UPDATED`
- `tasks:delete` → emits `DELETED`
- `tasks:complete` / `tasks:uncomplete` → emits `COMPLETED` / `UPDATED`
- All dispatch through `TaskSyncService` — FTS hooks go after sync service calls

### Fuzzy Search — fuzzysort Validation

- fuzzysort: ~4KB gzipped, zero dependencies, TypeScript types included
- Benchmarks: ~1ms for 10k items on title matching
- Returns `score` (negative, lower = better), `highlight()` function, `indexes` for match positions
- Threshold configurable: `threshold: -1000` default, can tune for 70% similarity
- **Integration point**: Renderer-side fallback when FTS5 returns < 5 results for short queries

### Duplicate Filter Bug Details

In `advancedSearch()` (search.ts lines ~456-476):

- `operators.file` and `folder` filter clauses are appended twice
- Produces `AND path LIKE ? AND path LIKE ?` with duplicate params
- Functionally correct (redundant) but wastes query plan
- **Fix**: Delete the duplicate block (lines ~467-476)

### Tag Filtering Performance Issue

`searchNotes()` applies tag filtering **in JavaScript post-query**, not in SQL:

- `LIMIT 50` applies before tag filtering
- Result: may return fewer than 50 results when tag filter is active
- **Fix**: Move tag filter into SQL JOIN with `note_tags` table (or subquery)
