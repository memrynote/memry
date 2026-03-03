# Research: Journal System

**Feature**: 004-journal-system
**Date**: 2025-12-25
**Status**: Complete

## Executive Summary

The journal system builds on the existing notes infrastructure, reusing the vault file operations, file watcher, and BlockNote editor. Key decisions focus on leveraging existing patterns (from 003-notes) while adding journal-specific features like date-based file naming, heatmap activity tracking, and day context integration.

---

## 1. Journal Entry Storage

### Decision: Markdown Files with Date-Based Naming

**Rationale**: Constitution principle VI mandates file system as source of truth. Using `YYYY-MM-DD.md` naming follows the same patterns as notes but with predictable date-based paths.

**Storage Pattern**:

```markdown
---
id: 'j2025-12-25'
date: '2025-12-25'
created: '2025-12-25T10:00:00.000Z'
modified: '2025-12-25T14:30:00.000Z'
wordCount: 342
characterCount: 1847
tags:
  - reflection
  - work
---

# December 25, 2025

Journal content here with [[wiki links]] and #tags.
```

**File Path**: `vault/journal/2025-12-25.md`

**Alternatives Considered**:
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| `YYYY-MM-DD.md` | Simple, predictable, sortable | One file per day | **SELECTED** |
| `YYYY/MM/DD.md` | Grouped by month/year | Deeper nesting, harder to scan | Rejected |
| UUID-based | Consistent with notes | Loses date-based predictability | Rejected |

---

## 2. Rich Text Editor

### Decision: BlockNote (Reuse from Notes)

**Rationale**: BlockNote is already integrated for the notes system (003-notes). Reusing it provides consistency and avoids maintaining two editors.

**Existing Implementation**:

- `@blocknote/core` v0.44.2
- `@blocknote/react` v0.44.2
- `@blocknote/shadcn` v0.44.2

**Current Journal-Specific Components** (already exist in `src/renderer/src/components/journal/`):

- `journal-editor.tsx` - Wrapper around Tiptap (needs migration to BlockNote)
- `extensions/wiki-link/` - Wiki link extension
- `extensions/tag/` - Tag autocomplete extension

**Enhancement Needed**:

- Migrate `journal-editor.tsx` from Tiptap to BlockNote
- OR reuse `ContentArea` component from notes directly

**Recommendation**: Reuse `ContentArea` from notes (already using BlockNote) as shown in current `journal.tsx` implementation.

---

## 3. Database Schema

### Decision: Extend Existing index.db with Journal Cache Table

**Rationale**: Journal entries are markdown files (source of truth) with SQLite cache for fast queries (same pattern as notes). Add a dedicated `journalCache` table optimized for date-based queries and heatmap calculations.

**Schema Design**:

```typescript
// journalCache - metadata cache for journal entries
{
  id: text (j{YYYY-MM-DD}),
  date: text (YYYY-MM-DD),
  path: text,
  wordCount: integer,
  characterCount: integer,
  createdAt: text,
  modifiedAt: text,
  indexedAt: text
}

// journalTags - many-to-many for journal entry tags
{
  entryId: text,
  tag: text
}
```

**Key Indexes**:

- `idx_journal_date` on `date` for calendar queries
- `idx_journal_year_month` on `substr(date, 1, 7)` for month view
- `idx_journal_activity` on `characterCount` for heatmap

**Alternatives Considered**:
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Dedicated journalCache table | Optimized queries, clear separation | Slight duplication | **SELECTED** |
| Reuse noteCache with type field | No new tables | Complicates queries | Rejected |
| No cache (parse files directly) | Simpler | Slow heatmap/calendar | Rejected |

---

## 4. Heatmap Activity Levels

### Decision: Character-Count-Based Levels (Per Spec)

**Rationale**: Spec FR-014 through FR-018 define exact thresholds.

**Level Calculation**:
| Level | Character Count | Visual |
|-------|-----------------|--------|
| 0 | 0 | Empty/no dot |
| 1 | 1-100 | Light green |
| 2 | 101-500 | Medium green |
| 3 | 501-1000 | Dark green |
| 4 | 1001+ | Darkest green |

**Implementation**:

```typescript
function getActivityLevel(charCount: number): 0 | 1 | 2 | 3 | 4 {
  if (charCount === 0) return 0
  if (charCount <= 100) return 1
  if (charCount <= 500) return 2
  if (charCount <= 1000) return 3
  return 4
}
```

---

## 5. Auto-Save Strategy

### Decision: Debounced Save (1000ms per spec)

**Rationale**: Spec FR-004 requires "save automatically 1 second after user stops typing."

**Implementation Pattern** (same as notes):

```typescript
const debouncedSave = useDebouncedCallback(async (content: string) => {
  await journalService.updateEntry(date, { content })
}, 1000)
```

**Save Indicators**:

- Idle: No indicator
- Saving: "Saving..." with spinner
- Saved: "Saved" with checkmark (fade after 2s)
- Error: "Error saving" with retry button

---

## 6. File Watching

### Decision: Reuse Existing chokidar Watcher

**Rationale**: The vault watcher already monitors `journal/` folder (see `src/main/vault/watcher.ts` line 146).

**Current Implementation**:

- Watches `vault/journal/` directory
- 100ms debounce per file
- Emits events with `source: 'external'` flag
- Rename detection via filename pattern matching

**No Changes Needed**: Current implementation supports journal files.

---

## 7. Calendar Navigation

### Decision: Client-Side State with Cached Heatmap Data

**Rationale**: Calendar widget needs fast response (<50ms per SC-002). Cache heatmap data on vault open.

**Data Flow**:

1. On vault open: Load all journal cache entries (date, characterCount)
2. Compute heatmap entries client-side
3. On day navigation: Load full entry content from IPC
4. On save: Update local cache + trigger IPC save

**Caching Strategy**:

- `getHeatmapData(year)` - Returns all entries for year as `{ date, level }[]`
- `getMonthEntries(year, month)` - Returns entries with previews for month view
- `getYearStats(year)` - Returns monthly summaries for year view

---

## 8. Focus Mode

### Decision: CSS-Based with localStorage Persistence

**Rationale**: Already implemented in `journal.tsx`. Uses sidebar context + localStorage.

**Current Implementation**:

- Toggle: Cmd+\ (macOS) / Ctrl+\ (Windows/Linux)
- Exit: Escape key
- Persists via `localStorage.setItem('memry_journal_focus_mode')`
- Hides left sidebar via `useSidebar().setOpen(false)`
- Hides right context sidebar via conditional rendering

**No Changes Needed**: Current implementation matches spec.

---

## 9. Day Context Integration

### Decision: IPC Calls to Tasks System

**Rationale**: Spec FR-023-026 require showing tasks for the viewed date from the task system.

**Implementation**:

```typescript
// New IPC handler
ipcMain.handle('tasks:getByDate', async (_, date: string) => {
  return taskQueries.getTasksByDueDate(db, date)
})
```

**Task Display**:

- Completed tasks: Show with strikethrough
- Overdue tasks: Highlight with warning styling
- Toggle completion: Call existing `tasks:update` IPC handler

**Calendar Events**: Mock data initially per spec assumption.

---

## 10. AI Connections

### Decision: Defer to AI Phase (006-ai)

**Rationale**: Per spec assumptions, "AI connections feature requires a semantic search backend (can be mocked initially)".

**Current State**: Mock data in `DUMMY_AI_CONNECTIONS`

**Future Implementation** (006-ai):

- Trigger semantic search 2s after typing pause
- Query embeddings for similar journal entries + notes
- Return top 3-5 matches with relevance scores

---

## 11. Wiki Links

### Decision: Reuse Notes Wiki Link Resolution

**Rationale**: Same wiki link syntax `[[Note Title]]` should work in journal entries, linking to notes.

**Existing Implementation** (from 003-notes):

- `noteLinks` table tracks links
- `getIncomingLinks()` returns backlinks
- Resolution: exact title match → case-insensitive fallback

**Enhancement for Journal**:

- Add `[[2025-12-25]]` syntax to link to journal dates
- Resolve journal date links to journal entries

---

## 12. Month/Year Views

### Decision: Virtualized Lists for Performance

**Rationale**: Spec SC-002 requires rendering 365 days in <50ms.

**Implementation**:

- Month view: Simple list (max 31 items) - no virtualization needed
- Year view: 12 month cards - no virtualization needed
- Heatmap: Pre-computed data from cache

**Existing Components**:

- `JournalMonthView` - Already implemented
- `JournalYearView` - Already implemented
- `JournalCalendar` with heatmap - Already implemented

---

## 13. Templates (P3)

### Decision: Defer to P3 Phase

**Rationale**: Spec User Story 9 is Priority 3. Basic journaling works without templates.

**Future Implementation**:

- Store templates in `vault/.memry/templates/journal/`
- Template YAML: `{ id, name, content, prompts }`
- Apply template: Populate editor with template content

---

## 14. Streaks (P3)

### Decision: Defer to P3 Phase

**Rationale**: Spec User Story 10 is Priority 3. Core journaling doesn't depend on streaks.

**Future Implementation**:

- Calculate from journal cache on demand
- Store computed streak in settings for fast display
- Update on each journal save

---

## 15. Journal Search (P3)

### Decision: Extend FTS5 Index

**Rationale**: Spec User Story 11 is Priority 3. Reuse existing FTS5 infrastructure from notes.

**Enhancement Needed**:

```sql
-- Add journal entries to FTS index
CREATE TRIGGER IF NOT EXISTS fts_journal_insert
AFTER INSERT ON journalCache
BEGIN
  INSERT INTO fts_notes (id, title, content, tags)
  VALUES (NEW.id, NEW.date, '', '');
END;
```

---

## Resolved Questions

| Question                       | Resolution                                          |
| ------------------------------ | --------------------------------------------------- |
| Separate editor for journal?   | **No** - reuse `ContentArea` from notes             |
| Separate cache table?          | **Yes** - `journalCache` optimized for date queries |
| How to handle date navigation? | Client-side state with cached heatmap data          |
| External file edit detection?  | Existing chokidar watcher covers journal folder     |
| Focus mode implementation?     | Already implemented in current `journal.tsx`        |
| AI connections integration?    | Mock data now, implement in 006-ai phase            |

---

## Dependencies (Already Installed)

All dependencies are already available from the notes system:

```json
{
  "@blocknote/core": "^0.44.2",
  "@blocknote/react": "^0.44.2",
  "@blocknote/shadcn": "^0.44.2",
  "gray-matter": "^4.0.3",
  "drizzle-orm": "^0.38.3",
  "better-sqlite3": "^11.7.0",
  "chokidar": "^4.0.3",
  "use-debounce": "^10.0.0",
  "date-fns": "^4.x"
}
```

---

## Existing UI Components Inventory

These components already exist and provide the UI foundation:

| Component          | Location                                      | Status                         |
| ------------------ | --------------------------------------------- | ------------------------------ |
| JournalPage        | `pages/journal.tsx`                           | ✅ Complete (uses ContentArea) |
| JournalCalendar    | `components/journal/calendar-heatmap.tsx`     | ✅ Complete                    |
| DateBreadcrumb     | `components/journal/date-breadcrumb.tsx`      | ✅ Complete                    |
| JournalMonthView   | `components/journal/journal-month-view.tsx`   | ✅ Complete                    |
| JournalYearView    | `components/journal/journal-year-view.tsx`    | ✅ Complete                    |
| DayContextSidebar  | `components/journal/day-context-sidebar.tsx`  | ✅ Complete                    |
| AIConnectionsPanel | `components/journal/ai-connections-panel.tsx` | ⚠️ Demo data                   |
| BacklinksSection   | `components/note/backlinks/`                  | ⚠️ Demo data                   |

---

## Future Considerations (Deferred)

| Feature         | Phase  | Notes                               |
| --------------- | ------ | ----------------------------------- |
| AI Connections  | 006-ai | Semantic search integration         |
| Templates       | P3     | Basic implementation possible later |
| Streaks         | P3     | Gamification feature                |
| Journal Search  | P3     | Extend FTS5 index                   |
| Calendar Events | Future | System calendar integration         |
