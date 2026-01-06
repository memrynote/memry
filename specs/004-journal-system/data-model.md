# Data Model: Journal System

**Feature**: 004-journal-system
**Date**: 2025-12-25
**Status**: Complete

## Overview

The journal system uses a dual-storage approach:

1. **Markdown files** in `vault/journal/` as the source of truth
2. **SQLite cache** in `index.db` for fast queries and heatmap calculations

This follows the same pattern as the notes system (003-notes) but with date-based organization.

---

## File Storage Format

### Journal Entry File

**Path Pattern**: `vault/journal/YYYY-MM-DD.md`

**Example**: `vault/journal/2025-12-25.md`

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
  - gratitude
---

Today was a productive day. I managed to finish the project proposal and got positive feedback from the team.

## Key Highlights

- Completed the [[Project Alpha]] proposal
- Had a great #meeting with the design team
- Started planning for next quarter

## Gratitude

- Grateful for supportive teammates
- Grateful for morning coffee rituals
```

### Frontmatter Fields

| Field            | Type     | Required | Description                                 |
| ---------------- | -------- | -------- | ------------------------------------------- |
| `id`             | string   | Yes      | Unique identifier in format `j{YYYY-MM-DD}` |
| `date`           | string   | Yes      | ISO date string `YYYY-MM-DD`                |
| `created`        | string   | Yes      | ISO timestamp of first save                 |
| `modified`       | string   | Yes      | ISO timestamp of last save                  |
| `wordCount`      | number   | Yes      | Auto-computed word count                    |
| `characterCount` | number   | Yes      | Auto-computed character count               |
| `tags`           | string[] | No       | User-defined tags                           |

---

## Database Schema

### Table: journalCache

Stores metadata for fast queries. Rebuildable from files.

```typescript
// src/shared/db/schema/journal-cache.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const journalCache = sqliteTable('journal_cache', {
  // Unique identifier: j{YYYY-MM-DD}
  id: text('id').primaryKey(),

  // Date in YYYY-MM-DD format for queries
  date: text('date').notNull(),

  // Relative path from vault root
  path: text('path').notNull(),

  // Content statistics
  wordCount: integer('word_count').notNull().default(0),
  characterCount: integer('character_count').notNull().default(0),

  // Computed activity level (0-4) for heatmap
  activityLevel: integer('activity_level').notNull().default(0),

  // Timestamps
  createdAt: text('created_at').notNull(),
  modifiedAt: text('modified_at').notNull(),
  indexedAt: text('indexed_at').notNull()
})

export type JournalCache = typeof journalCache.$inferSelect
export type InsertJournalCache = typeof journalCache.$inferInsert
```

### Table: journalTags

Many-to-many relationship for journal entry tags.

```typescript
// src/shared/db/schema/journal-cache.ts (continued)
export const journalTags = sqliteTable(
  'journal_tags',
  {
    entryId: text('entry_id')
      .notNull()
      .references(() => journalCache.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.entryId, table.tag] })
  })
)

export type JournalTag = typeof journalTags.$inferSelect
export type InsertJournalTag = typeof journalTags.$inferInsert
```

### Indexes

```sql
-- Fast date-based queries (calendar, navigation)
CREATE INDEX idx_journal_date ON journal_cache(date);

-- Fast year-month queries (month/year views)
CREATE INDEX idx_journal_year_month ON journal_cache(substr(date, 1, 7));

-- Fast activity queries (heatmap)
CREATE INDEX idx_journal_activity ON journal_cache(activity_level);

-- Tag lookups
CREATE INDEX idx_journal_tags_tag ON journal_tags(tag);
CREATE INDEX idx_journal_tags_entry ON journal_tags(entry_id);
```

---

## TypeScript Types

### JournalEntry (Full Entry with Content)

```typescript
// src/shared/contracts/journal-api.ts
import { z } from 'zod'

export const JournalEntrySchema = z.object({
  id: z.string(), // j{YYYY-MM-DD}
  date: z.string(), // YYYY-MM-DD
  content: z.string(), // Markdown content
  wordCount: z.number(),
  characterCount: z.number(),
  tags: z.array(z.string()),
  createdAt: z.string(), // ISO timestamp
  modifiedAt: z.string() // ISO timestamp
})

export type JournalEntry = z.infer<typeof JournalEntrySchema>
```

### JournalMetadata (Cache Entry Without Content)

```typescript
export const JournalMetadataSchema = z.object({
  id: z.string(),
  date: z.string(),
  path: z.string(),
  wordCount: z.number(),
  characterCount: z.number(),
  activityLevel: z.number().min(0).max(4),
  tags: z.array(z.string()),
  createdAt: z.string(),
  modifiedAt: z.string()
})

export type JournalMetadata = z.infer<typeof JournalMetadataSchema>
```

### HeatmapEntry (Calendar Display)

```typescript
export const HeatmapEntrySchema = z.object({
  date: z.string(), // YYYY-MM-DD
  characterCount: z.number(),
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
})

export type HeatmapEntry = z.infer<typeof HeatmapEntrySchema>
```

### MonthStats (Year View)

```typescript
export const MonthStatsSchema = z.object({
  year: z.number(),
  month: z.number(), // 1-12
  entryCount: z.number(),
  totalWordCount: z.number(),
  totalCharacterCount: z.number(),
  averageLevel: z.number() // Average activity level
})

export type MonthStats = z.infer<typeof MonthStatsSchema>
```

### DayContext (Sidebar Data)

```typescript
export const DayContextSchema = z.object({
  date: z.string(),
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      completed: z.boolean(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      isOverdue: z.boolean().optional()
    })
  ),
  events: z.array(
    z.object({
      id: z.string(),
      time: z.string(),
      title: z.string(),
      type: z.enum(['meeting', 'focus', 'event']),
      attendeeCount: z.number().optional()
    })
  ),
  overdueCount: z.number()
})

export type DayContext = z.infer<typeof DayContextSchema>
```

---

## Entity Relationships

```
+-------------------+
|   JournalEntry    |
|   (Markdown File) |
+--------+----------+
         |
         | 1:1 (source of truth)
         v
+-------------------+       +-------------------+
|   journalCache    |<----->|   journalTags     |
|   (index.db)      |  1:N  |   (index.db)      |
+-------------------+       +-------------------+
         |
         | 1:N (links in content)
         v
+-------------------+
|    noteLinks      |
|  (existing table) |
+-------------------+
```

---

## Activity Level Calculation

Activity level is computed from character count on each save:

```typescript
function calculateActivityLevel(characterCount: number): 0 | 1 | 2 | 3 | 4 {
  if (characterCount === 0) return 0
  if (characterCount <= 100) return 1
  if (characterCount <= 500) return 2
  if (characterCount <= 1000) return 3
  return 4
}
```

This is stored in the cache for fast heatmap rendering.

---

## ID Generation

Journal entries use a predictable ID format based on date:

```typescript
// src/main/lib/id.ts
export function generateJournalId(date: string): string {
  // date should be YYYY-MM-DD format
  return `j${date}`
}

export function isJournalId(id: string): boolean {
  return /^j\d{4}-\d{2}-\d{2}$/.test(id)
}

export function dateFromJournalId(id: string): string | null {
  if (!isJournalId(id)) return null
  return id.slice(1) // Remove 'j' prefix
}
```

---

## Validation Rules

### Date Validation

```typescript
export function isValidJournalDate(date: string): boolean {
  // Must be YYYY-MM-DD format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false

  // Must parse to valid date
  const parsed = new Date(date + 'T00:00:00.000Z')
  if (isNaN(parsed.getTime())) return false

  // Reasonable date range (1970 to 2100)
  const year = parsed.getFullYear()
  return year >= 1970 && year <= 2100
}
```

### Content Validation

```typescript
export function validateJournalContent(content: string): {
  valid: boolean
  error?: string
} {
  // Max size: 1MB of text
  const MAX_SIZE = 1024 * 1024
  if (content.length > MAX_SIZE) {
    return { valid: false, error: 'Content exceeds 1MB limit' }
  }

  return { valid: true }
}
```

---

## State Transitions

Journal entries have simple state transitions:

```
                    +-------------------+
                    |     NOT EXISTS    |
                    +--------+----------+
                             |
                             | Create (first keystroke)
                             v
                    +-------------------+
                    |      DRAFT        |
                    | (wordCount = 0)   |
                    +--------+----------+
                             |
                             | Save (content added)
                             v
                    +-------------------+
                    |     ACTIVE        |
                    | (wordCount > 0)   |
                    +--------+----------+
                             |
                             | Delete (manual action)
                             v
                    +-------------------+
                    |     DELETED       |
                    | (file removed)    |
                    +-------------------+
```

---

## Migration Strategy

### From 003-notes (No Migration Needed)

Journal uses separate tables and files. No migration from notes schema.

### Initial Cache Build

On vault open with empty journalCache:

1. Scan `vault/journal/*.md` files
2. Parse each file's frontmatter
3. Insert into journalCache and journalTags
4. Compute activity levels

```typescript
async function buildJournalCache(vaultPath: string): Promise<void> {
  const journalDir = path.join(vaultPath, 'journal')
  const files = await fs.readdir(journalDir)

  for (const file of files) {
    if (!file.endsWith('.md')) continue

    const filePath = path.join(journalDir, file)
    const content = await fs.readFile(filePath, 'utf-8')
    const { data: frontmatter, content: body } = matter(content)

    await insertJournalCache({
      id: frontmatter.id,
      date: frontmatter.date,
      path: `journal/${file}`,
      wordCount: frontmatter.wordCount || countWords(body),
      characterCount: frontmatter.characterCount || body.length,
      activityLevel: calculateActivityLevel(frontmatter.characterCount || body.length),
      createdAt: frontmatter.created,
      modifiedAt: frontmatter.modified,
      indexedAt: new Date().toISOString()
    })

    for (const tag of frontmatter.tags || []) {
      await insertJournalTag({ entryId: frontmatter.id, tag })
    }
  }
}
```

---

## Performance Considerations

### Query Patterns

| Query              | Expected Frequency | Target Performance |
| ------------------ | ------------------ | ------------------ |
| Get entry by date  | Every navigation   | <50ms              |
| Get heatmap (year) | On calendar render | <50ms              |
| Get month entries  | On month view      | <100ms             |
| Get year stats     | On year view       | <100ms             |
| Full-text search   | User-initiated     | <200ms             |

### Indexing Strategy

- Pre-compute activity levels on save
- Store tags in separate table for efficient tag queries
- Use date-based primary key for natural ordering
- Batch FTS updates for large imports
