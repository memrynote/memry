# Quickstart: Global Search Implementation

**Branch**: `007-global-search` | **Date**: 2026-03-03

## Prerequisites

- Node.js, pnpm, Electron dev environment already set up
- Feature branch `007-global-search` checked out
- Existing FTS5 infrastructure in `src/main/database/fts.ts`

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Renderer Process                                             │
│                                                              │
│  CommandPalette ──▶ useSearch() ──▶ searchService ──▶ IPC    │
│    (cmdk)            (hook)          (typed client)    │     │
│                                                        │     │
│  Result Groups:                                        │     │
│    Notes | Tasks | Journal | Inbox                     │     │
│                                                        │     │
│  Fuzzy fallback: fuzzysort (client-side titles)        │     │
└────────────────────────────────────────────────────────┼─────┘
                                                         │
                                          window.api.search.*
                                                         │
┌────────────────────────────────────────────────────────┼─────┐
│ Main Process                                           │     │
│                                                        ▼     │
│  search-handlers.ts ──▶ search queries ──▶ fts_content       │
│    (IPC handlers)        (SQL builders)    (FTS5 table)      │
│                                                              │
│  FTS Queue ──▶ debounced updates (2s) ──▶ fts_content        │
│                                                              │
│  CRUD Hooks:                                                 │
│    task-handlers.ts ──▶ insertFtsEntry('task', ...)          │
│    inbox-handlers.ts ──▶ insertFtsEntry('inbox', ...)        │
│    note triggers ──▶ automatic via note_cache triggers       │
└──────────────────────────────────────────────────────────────┘

┌──────────────┐  ┌──────────────┐
│   index.db   │  │   data.db    │
│              │  │              │
│ fts_content  │  │ tasks        │
│ note_cache   │  │ inbox_items  │
│ note_tags    │  │ recent_      │
│              │  │   searches   │
└──────────────┘  └──────────────┘
```

## Implementation Order

### Phase 1: Unified FTS Index (Backend)

1. Migrate `fts_notes` → `fts_content` in `src/main/database/fts.ts`
2. Update triggers for `note_cache` (add `type` column logic)
3. Add FTS hooks in `tasks-handlers.ts` (create/update/delete)
4. Add FTS hooks in `inbox-crud-handlers.ts` (create/update/delete)
5. Implement `rebuildFtsIndex()` (replace stub)
6. Fix duplicate filter bug in `advancedSearch()`

### Phase 2: Cross-Type Queries (Backend)

1. Create unified `searchAll()` function using `fts_content`
2. Add metadata JOINs: note_cache, tasks (via data.db ATTACH or separate query), inbox_items
3. Update contract types (`SearchResultInbox`, updated unions)
4. Update IPC handlers to populate all result types
5. Fix `SearchStats` to return real counts

### Phase 3: Fuzzy Search

1. Install `fuzzysort` package
2. Create `src/renderer/src/lib/fuzzy-search.ts` — wrapper
3. In `useSearch` hook: if FTS returns < 5 results, run fuzzy on cached titles
4. Merge + deduplicate, rank: exact > prefix > fuzzy

### Phase 4: UI — Multi-Type Results

1. Refactor `command-palette.tsx` for grouped sections
2. Each section: icon + type header + count + results + "View all"
3. Type filter chips (Notes, Tasks, Journal, Inbox)
4. Cmd+1–4 keyboard shortcuts for type filtering
5. Update Cmd+P → Cmd+K
6. Delete `search-modal.tsx` + `search-result-item.tsx`

### Phase 5: Navigation

1. Extend `handleSelectSearchResult` for task/inbox dispatch
2. Task result → open tasks tab with task selected
3. Inbox result → open inbox tab with item highlighted
4. Journal result → already works (path regex detection)

### Phase 6: Recent Searches Persistence

1. Drizzle migration: `recent_searches` table in data.db
2. Replace in-memory array in `search-handlers.ts`
3. UPSERT on search, DELETE oldest when > 20

### Phase 7: Polish

1. Performance benchmarks (10k items)
2. Accessibility audit
3. Edge case hardening

## Key Files to Modify

| File                                                     | Changes                                               |
| -------------------------------------------------------- | ----------------------------------------------------- |
| `src/main/database/fts.ts`                               | Migrate to `fts_content`, new triggers, new functions |
| `src/main/database/fts-queue.ts`                         | Add `type` parameter to queue entries                 |
| `src/shared/db/queries/search.ts`                        | New `searchAll()`, fix bugs                           |
| `src/shared/contracts/search-api.ts`                     | Add inbox type, update unions                         |
| `src/main/ipc/search-handlers.ts`                        | Implement task/inbox/journal search, fix rebuild      |
| `src/main/ipc/tasks-handlers.ts`                         | Add FTS hooks on CRUD                                 |
| `src/main/ipc/inbox-crud-handlers.ts`                    | Add FTS hooks on CRUD                                 |
| `src/renderer/src/components/search/command-palette.tsx` | Multi-type UI                                         |
| `src/renderer/src/hooks/use-search.ts`                   | Updated types, fuzzy fallback                         |
| `src/renderer/src/hooks/use-search-shortcut.ts`          | Cmd+P → Cmd+K                                         |
| `src/renderer/src/App.tsx`                               | Multi-type navigation dispatch                        |
| `src/preload/index.ts`                                   | New channels for inbox search                         |

## New Files to Create

| File                                                         | Purpose                                    |
| ------------------------------------------------------------ | ------------------------------------------ |
| `src/renderer/src/lib/fuzzy-search.ts`                       | fuzzysort wrapper                          |
| `src/shared/db/schema/recent-searches.ts`                    | Drizzle schema                             |
| `src/main/database/fts-rebuild.ts`                           | Full rebuild logic (extracted from fts.ts) |
| `src/renderer/src/components/search/search-result-group.tsx` | Grouped result section component           |
| `src/renderer/src/components/search/type-filter-bar.tsx`     | Type filter chips                          |

## Testing Approach

- **Unit**: FTS CRUD per type, search query building, fuzzy matching, recent searches
- **Integration**: Cross-type search, compound filters, rebuild consistency
- **E2E**: Full search workflow (Cmd+K → type → click → navigate)
