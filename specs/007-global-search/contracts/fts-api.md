# FTS Engine API Contract

**Target files**: `src/main/database/fts.ts`, `src/main/database/fts-queue.ts`

## Unified FTS Functions

### Entry Management

```typescript
type ContentType = 'note' | 'task' | 'journal' | 'inbox'

function insertFtsEntry(
  db: Database,
  id: string,
  type: ContentType,
  title: string,
  content: string,
  tags: string
): void

function updateFtsEntry(
  db: Database,
  id: string,
  title: string,
  content: string,
  tags: string
): void

function deleteFtsEntry(db: Database, id: string): void
```

### Search

```typescript
interface FtsSearchOptions {
  query: string
  types?: ContentType[]
  limit?: number
  offset?: number
}

interface FtsSearchResult {
  id: string
  type: ContentType
  title: string
  snippet: string
  score: number
}

function searchFts(db: Database, options: FtsSearchOptions): FtsSearchResult[]
```

**SQL Template**:

```sql
SELECT
  id, type,
  highlight(fts_content, 2, '<mark>', '</mark>') as title,
  snippet(fts_content, 3, '<mark>', '</mark>', '...', 30) as snippet,
  bm25(fts_content, 2.0, 1.0, 1.0) as score
FROM fts_content
WHERE fts_content MATCH :query
  [AND type IN (:types)]
ORDER BY score
LIMIT :limit OFFSET :offset
```

Note: `bm25()` returns negative values (lower = better match). Negate in application layer.

### Rebuild

```typescript
interface RebuildProgress {
  phase: 'scanning' | 'indexing' | 'optimizing'
  current: number
  total: number
}

interface RebuildResult {
  notesIndexed: number
  tasksIndexed: number
  journalsIndexed: number
  inboxIndexed: number
  duration: number
}

function rebuildFtsIndex(
  indexDb: Database,
  dataDb: Database,
  onProgress?: (progress: RebuildProgress) => void
): Promise<RebuildResult>
```

### Queue — Updated

```typescript
function queueFtsUpdate(
  id: string,
  type: ContentType,
  title: string,
  content: string,
  tags: string
): void

function flushFtsUpdates(db: Database): number
function cancelPendingFtsUpdates(): void
function getPendingCount(): number
```

## Migration — Drop fts_notes, Create fts_content

```sql
-- In initializeFts() or a migration function
DROP TABLE IF EXISTS fts_notes;
DROP TRIGGER IF EXISTS note_cache_ai;
DROP TRIGGER IF EXISTS note_cache_ad;
DROP TRIGGER IF EXISTS note_cache_au;

CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts5(
  id UNINDEXED,
  type UNINDEXED,
  title,
  content,
  tags,
  tokenize='porter unicode61'
);

-- New triggers for note_cache
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
