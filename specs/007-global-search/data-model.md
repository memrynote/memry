# Data Model: Global Search System

**Branch**: `007-global-search` | **Date**: 2026-03-03

## Entity Overview

```
fts_content (index.db)          SearchResult (contract)
┌─────────────────────┐         ┌──────────────────────┐
│ id        UNINDEXED │────────▶│ SearchResultNote      │
│ type      UNINDEXED │         │ SearchResultTask      │
│ title     INDEXED   │         │ SearchResultJournal   │
│ content   INDEXED   │         │ SearchResultInbox     │
│ tags      INDEXED   │         └──────────────────────┘
└─────────────────────┘                   │
        ▲                                 ▼
        │ sync                    SearchResponse
   ┌────┴──────┐                ┌──────────────────────┐
   │           │                │ results: SearchResult[]│
note_cache  tasks  inbox_items  │ total: number         │
(index.db)  (data.db)(data.db)  │ groups: TypeGroup[]   │
                                └──────────────────────┘
```

## FTS Virtual Table — `fts_content`

Replaces existing `fts_notes`. Lives in `index.db`.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts5(
  id UNINDEXED,
  type UNINDEXED,
  title,
  content,
  tags,
  tokenize='porter unicode61'
);
```

| Column    | FTS5 Role            | Source by Type                                                            |
| --------- | -------------------- | ------------------------------------------------------------------------- |
| `id`      | UNINDEXED (join key) | `note_cache.id` / `tasks.id` / `inbox_items.id`                           |
| `type`    | UNINDEXED (filter)   | `'note'` / `'task'` / `'journal'` / `'inbox'`                             |
| `title`   | INDEXED (weight 2.0) | note title / task title / journal date / inbox title                      |
| `content` | INDEXED (weight 1.0) | note body / task description / journal body / inbox content+transcription |
| `tags`    | INDEXED (weight 1.0) | note_tags / (empty for tasks) / (empty for journals) / (empty for inbox)  |

**BM25 weights**: `bm25(fts_content, 10.0, 10.0, 2.0, 1.0, 1.0)` — id and type get high weights (unused since UNINDEXED), title 2x content, tags 1x.

Actually, UNINDEXED columns are excluded from bm25 weighting. So: `bm25(fts_content, 2.0, 1.0, 1.0)` — same as current `fts_notes`.

**Type Determination (on index/rebuild)**:

- `note_cache.date IS NOT NULL` → `type = 'journal'`
- `note_cache.date IS NULL` → `type = 'note'`
- Row from `tasks` table → `type = 'task'`
- Row from `inbox_items` table → `type = 'inbox'`

## Triggers — `note_cache` Only

```sql
CREATE TRIGGER IF NOT EXISTS note_cache_fts_ai AFTER INSERT ON note_cache
BEGIN
  INSERT INTO fts_content (id, type, title, content, tags)
  VALUES (
    NEW.id,
    CASE WHEN NEW.date IS NOT NULL THEN 'journal' ELSE 'note' END,
    NEW.title, '', ''
  );
END;

CREATE TRIGGER IF NOT EXISTS note_cache_fts_ad AFTER DELETE ON note_cache
BEGIN
  DELETE FROM fts_content WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS note_cache_fts_au AFTER UPDATE OF title ON note_cache
BEGIN
  UPDATE fts_content SET title = NEW.title WHERE id = NEW.id;
END;
```

Tasks/inbox don't live in index.db — their FTS sync is application-level (see below).

## Application-Level FTS Sync

### Task FTS Hooks

Inserted in task CRUD handlers after the primary mutation:

| Event               | FTS Action                                                          |
| ------------------- | ------------------------------------------------------------------- |
| `tasks:create`      | `insertFtsEntry(task.id, 'task', task.title, task.description, '')` |
| `tasks:update`      | `updateFtsEntry(task.id, 'task', task.title, task.description, '')` |
| `tasks:delete`      | `deleteFtsEntry(task.id)`                                           |
| `tasks:bulk-delete` | `deleteFtsEntry(id)` per task                                       |

### Inbox FTS Hooks

| Event          | FTS Action                                                              |
| -------------- | ----------------------------------------------------------------------- |
| `inbox:create` | `insertFtsEntry(item.id, 'inbox', item.title, concatContent(item), '')` |
| `inbox:update` | `updateFtsEntry(item.id, 'inbox', item.title, concatContent(item), '')` |
| `inbox:delete` | `deleteFtsEntry(item.id)`                                               |

```typescript
function concatInboxContent(item: InboxItem): string {
  return [item.content, item.transcription].filter(Boolean).join(' ')
}
```

### Note/Journal FTS Hooks (Existing — Adapted)

Current `queueFtsUpdate(noteId, content, tags)` continues to work through the debounce queue. The only change is that `insertFtsNote` becomes `insertFtsEntry` with `type` parameter.

## Recent Searches Table — `recent_searches`

New table in `data.db` via Drizzle migration.

```typescript
export const recentSearches = sqliteTable('recent_searches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  query: text('query').notNull(),
  resultCount: integer('result_count').notNull().default(0),
  searchedAt: text('searched_at')
    .notNull()
    .default(sql`(datetime('now'))`)
})
```

**Constraints**:

- Max 20 entries (enforced in application — DELETE oldest when inserting 21st)
- Unique on `query` (UPSERT — update `searchedAt` + `resultCount` on conflict)
- Ordered by `searchedAt DESC`

## Contract Types — Updated

### SearchResultInbox (NEW)

```typescript
export interface SearchResultInbox {
  type: 'inbox'
  id: string
  title: string
  snippet: string | null
  score: number
  matchedIn: ('title' | 'content' | 'transcription')[]
  itemType: 'link' | 'note' | 'image' | 'voice' | 'video' | 'clip' | 'pdf' | 'social' | 'reminder'
  sourceUrl: string | null
  createdAt: string
  filedAt: string | null
}
```

### Updated SearchResult Union

```typescript
export type SearchResult =
  | SearchResultNote
  | SearchResultTask
  | SearchResultJournal
  | SearchResultInbox
```

### Updated SearchQuerySchema

```typescript
export const SearchQuerySchema = z.object({
  query: z.string().min(1).max(500),
  types: z
    .array(z.enum(['note', 'task', 'journal', 'inbox']))
    .default(['note', 'task', 'journal', 'inbox'])
  // ... rest unchanged
})
```

### Updated QuickSearchResponse

```typescript
export interface QuickSearchResponse {
  notes: SearchResultNote[]
  tasks: SearchResultTask[]
  journals: SearchResultJournal[]
  inbox: SearchResultInbox[]
}
```

### Updated SearchStats

```typescript
export interface SearchStats {
  totalNotes: number
  totalTasks: number
  totalJournals: number
  totalInbox: number // NEW
  lastIndexed: string
  indexHealth: 'healthy' | 'rebuilding' | 'corrupt'
}
```

## FTS Utility Functions — Updated Signatures

```typescript
// New unified entry management
function insertFtsEntry(
  id: string,
  type: ContentType,
  title: string,
  content: string,
  tags: string
): void
function updateFtsEntry(
  id: string,
  type: ContentType,
  title: string,
  content: string,
  tags: string
): void
function deleteFtsEntry(id: string): void

// Updated queue (adds type parameter)
function queueFtsUpdate(
  id: string,
  type: ContentType,
  title: string,
  content: string,
  tags: string
): void

// Rebuild — iterates all sources
function rebuildFtsIndex(indexDb: Database, dataDb: Database): Promise<RebuildResult>

type ContentType = 'note' | 'task' | 'journal' | 'inbox'
```

## Index Rebuild Procedure

```
1. DROP TABLE IF EXISTS fts_content
2. CREATE VIRTUAL TABLE fts_content ...
3. BEGIN TRANSACTION
4. For each note in note_cache WHERE date IS NULL:
     INSERT INTO fts_content (id, 'note', title, '', '')
5. For each journal in note_cache WHERE date IS NOT NULL:
     INSERT INTO fts_content (id, 'journal', title, '', '')
6. For each task in data.tasks:
     INSERT INTO fts_content (id, 'task', title, description, '')
7. For each inbox_item in data.inbox_items:
     INSERT INTO fts_content (id, 'inbox', title, content||transcription, '')
8. COMMIT
9. For each note/journal: queueFtsUpdate(id, type, title, fileContent, tags)
10. Emit INDEX_REBUILD_COMPLETED
```

Steps 1-8 give searchable titles immediately. Step 9 backfills full content asynchronously via the debounce queue.
