# Quickstart: Journal System

**Feature**: 004-journal-system
**Date**: 2025-12-25

This guide helps developers get started with implementing the journal system backend.

## Prerequisites

Before starting, ensure you have:

1. **Node.js 20+** installed
2. **pnpm** package manager
3. **Vault setup** - Run the app once and select a vault folder
4. **Core data layer** (001-core-data-layer) implemented
5. **Notes system** (003-notes) implemented (for shared components)

## Project Structure

```
src/
├── main/
│   ├── vault/
│   │   └── journal.ts          # Journal file operations (NEW)
│   ├── ipc/
│   │   └── journal-handlers.ts # Journal IPC handlers (NEW)
│   └── database/
│       └── drizzle-index/      # Migration for journalCache table (NEW)
│
├── shared/
│   ├── contracts/
│   │   └── journal-api.ts      # Journal API contracts (NEW)
│   └── db/
│       ├── schema/
│       │   └── journal-cache.ts # Journal schema (NEW)
│       └── queries/
│           └── journal.ts       # Journal queries (NEW)
│
├── renderer/src/
│   ├── services/
│   │   └── journal-service.ts  # Journal IPC client (NEW)
│   ├── hooks/
│   │   └── use-journal.ts      # Journal state hook (NEW)
│   └── components/journal/     # Already exists (UI complete)
│
└── preload/
    ├── index.ts                # Add journal API exposure
    └── index.d.ts              # Add journal types
```

## Step 1: Add Database Schema

Create the journal cache schema in `src/shared/db/schema/journal-cache.ts`:

```typescript
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

export const journalCache = sqliteTable('journal_cache', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),
  path: text('path').notNull(),
  wordCount: integer('word_count').notNull().default(0),
  characterCount: integer('character_count').notNull().default(0),
  activityLevel: integer('activity_level').notNull().default(0),
  createdAt: text('created_at').notNull(),
  modifiedAt: text('modified_at').notNull(),
  indexedAt: text('indexed_at').notNull()
})

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

export type JournalCache = typeof journalCache.$inferSelect
export type InsertJournalCache = typeof journalCache.$inferInsert
export type JournalTag = typeof journalTags.$inferSelect
export type InsertJournalTag = typeof journalTags.$inferInsert
```

Export from schema index:

```typescript
// src/shared/db/schema/index.ts
export * from './journal-cache'
```

## Step 2: Generate Migration

Run drizzle-kit to generate the migration:

```bash
pnpm db:generate:index
```

This creates a migration file in `src/main/database/drizzle-index/`.

## Step 3: Add Query Functions

Create journal queries in `src/shared/db/queries/journal.ts`:

```typescript
import { eq, and, like, desc, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { journalCache, journalTags } from '../schema/journal-cache'
import type { InsertJournalCache, JournalCache } from '../schema/journal-cache'

export function insertJournalEntry(
  db: BetterSQLite3Database,
  entry: InsertJournalCache
): JournalCache {
  return db.insert(journalCache).values(entry).returning().get()
}

export function updateJournalEntry(
  db: BetterSQLite3Database,
  date: string,
  updates: Partial<InsertJournalCache>
): JournalCache | undefined {
  const id = `j${date}`
  return db
    .update(journalCache)
    .set({ ...updates, indexedAt: new Date().toISOString() })
    .where(eq(journalCache.id, id))
    .returning()
    .get()
}

export function getJournalEntry(db: BetterSQLite3Database, date: string): JournalCache | undefined {
  const id = `j${date}`
  return db.select().from(journalCache).where(eq(journalCache.id, id)).get()
}

export function getHeatmapData(
  db: BetterSQLite3Database,
  year: number
): { date: string; characterCount: number; level: number }[] {
  const yearPrefix = `${year}-`
  return db
    .select({
      date: journalCache.date,
      characterCount: journalCache.characterCount,
      level: journalCache.activityLevel
    })
    .from(journalCache)
    .where(like(journalCache.date, `${yearPrefix}%`))
    .all()
}

export function getMonthEntries(
  db: BetterSQLite3Database,
  year: number,
  month: number
): JournalCache[] {
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}-`
  return db
    .select()
    .from(journalCache)
    .where(like(journalCache.date, `${monthPrefix}%`))
    .orderBy(desc(journalCache.date))
    .all()
}

export function getYearStats(
  db: BetterSQLite3Database,
  year: number
): { month: number; entryCount: number; totalWordCount: number; totalCharacterCount: number }[] {
  const result = db
    .select({
      month: sql<number>`CAST(substr(${journalCache.date}, 6, 2) AS INTEGER)`,
      entryCount: sql<number>`COUNT(*)`,
      totalWordCount: sql<number>`SUM(${journalCache.wordCount})`,
      totalCharacterCount: sql<number>`SUM(${journalCache.characterCount})`
    })
    .from(journalCache)
    .where(like(journalCache.date, `${year}-%`))
    .groupBy(sql`substr(${journalCache.date}, 6, 2)`)
    .all()

  return result
}
```

## Step 4: Implement File Operations

Create journal file operations in `src/main/vault/journal.ts`:

```typescript
import path from 'node:path'
import fs from 'node:fs/promises'
import matter from 'gray-matter'
import { atomicWrite } from './file-ops'
import { calculateActivityLevel, countWords } from '@shared/contracts/journal-api'

export interface JournalFrontmatter {
  id: string
  date: string
  created: string
  modified: string
  wordCount: number
  characterCount: number
  tags: string[]
}

export async function readJournalEntry(
  vaultPath: string,
  date: string
): Promise<{ frontmatter: JournalFrontmatter; content: string } | null> {
  const filePath = path.join(vaultPath, 'journal', `${date}.md`)

  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const { data, content } = matter(raw)
    return {
      frontmatter: data as JournalFrontmatter,
      content: content.trim()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function writeJournalEntry(
  vaultPath: string,
  date: string,
  content: string,
  tags: string[] = []
): Promise<JournalFrontmatter> {
  const filePath = path.join(vaultPath, 'journal', `${date}.md`)
  const now = new Date().toISOString()

  // Check if entry exists
  const existing = await readJournalEntry(vaultPath, date)

  const frontmatter: JournalFrontmatter = {
    id: `j${date}`,
    date,
    created: existing?.frontmatter.created || now,
    modified: now,
    wordCount: countWords(content),
    characterCount: content.length,
    tags
  }

  const fileContent = matter.stringify(content, frontmatter)
  await atomicWrite(filePath, fileContent)

  return frontmatter
}

export async function deleteJournalEntry(vaultPath: string, date: string): Promise<boolean> {
  const filePath = path.join(vaultPath, 'journal', `${date}.md`)

  try {
    await fs.unlink(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}
```

## Step 5: Add IPC Handlers

Create journal handlers in `src/main/ipc/journal-handlers.ts`:

```typescript
import { ipcMain } from 'electron'
import { createValidatedHandler } from './validate'
import {
  GetEntryInputSchema,
  CreateEntryInputSchema,
  UpdateEntryInputSchema,
  DeleteEntryInputSchema,
  GetHeatmapInputSchema,
  GetMonthEntriesInputSchema,
  GetYearStatsInputSchema,
  JOURNAL_IPC_CHANNELS,
  calculateActivityLevel
} from '@shared/contracts/journal-api'
import * as journalOps from '../vault/journal'
import * as journalQueries from '@shared/db/queries/journal'
import { getIndexDb } from '../database/client'
import { getVaultPath } from '../vault'

export function registerJournalHandlers(): void {
  // Get entry
  ipcMain.handle(
    JOURNAL_IPC_CHANNELS.GET_ENTRY,
    createValidatedHandler(GetEntryInputSchema, async ({ date }) => {
      const vaultPath = getVaultPath()
      if (!vaultPath) throw new Error('No vault open')

      const entry = await journalOps.readJournalEntry(vaultPath, date)
      if (!entry) return null

      return {
        id: entry.frontmatter.id,
        date: entry.frontmatter.date,
        content: entry.content,
        wordCount: entry.frontmatter.wordCount,
        characterCount: entry.frontmatter.characterCount,
        tags: entry.frontmatter.tags,
        createdAt: entry.frontmatter.created,
        modifiedAt: entry.frontmatter.modified
      }
    })
  )

  // Create entry
  ipcMain.handle(
    JOURNAL_IPC_CHANNELS.CREATE_ENTRY,
    createValidatedHandler(CreateEntryInputSchema, async ({ date, content, tags }) => {
      const vaultPath = getVaultPath()
      if (!vaultPath) throw new Error('No vault open')

      const frontmatter = await journalOps.writeJournalEntry(vaultPath, date, content, tags)
      const db = getIndexDb()

      // Update cache
      journalQueries.insertJournalEntry(db, {
        id: frontmatter.id,
        date: frontmatter.date,
        path: `journal/${date}.md`,
        wordCount: frontmatter.wordCount,
        characterCount: frontmatter.characterCount,
        activityLevel: calculateActivityLevel(frontmatter.characterCount),
        createdAt: frontmatter.created,
        modifiedAt: frontmatter.modified,
        indexedAt: new Date().toISOString()
      })

      return {
        id: frontmatter.id,
        date: frontmatter.date,
        content,
        wordCount: frontmatter.wordCount,
        characterCount: frontmatter.characterCount,
        tags,
        createdAt: frontmatter.created,
        modifiedAt: frontmatter.modified
      }
    })
  )

  // Get heatmap
  ipcMain.handle(
    JOURNAL_IPC_CHANNELS.GET_HEATMAP,
    createValidatedHandler(GetHeatmapInputSchema, async ({ year }) => {
      const db = getIndexDb()
      return journalQueries.getHeatmapData(db, year)
    })
  )

  // ... more handlers
}
```

Register in `src/main/ipc/index.ts`:

```typescript
import { registerJournalHandlers } from './journal-handlers'

export function registerAllHandlers(): void {
  // ... existing handlers
  registerJournalHandlers()
}
```

## Step 6: Expose in Preload

Update `src/preload/index.ts`:

```typescript
const journalApi = {
  getEntry: (date: string) => ipcRenderer.invoke('journal:getEntry', { date }),
  createEntry: (date: string, content: string, tags: string[]) =>
    ipcRenderer.invoke('journal:createEntry', { date, content, tags }),
  updateEntry: (date: string, content?: string, tags?: string[]) =>
    ipcRenderer.invoke('journal:updateEntry', { date, content, tags }),
  deleteEntry: (date: string) => ipcRenderer.invoke('journal:deleteEntry', { date }),
  getHeatmap: (year: number) => ipcRenderer.invoke('journal:getHeatmap', { year }),
  getMonthEntries: (year: number, month: number) =>
    ipcRenderer.invoke('journal:getMonthEntries', { year, month }),
  getYearStats: (year: number) => ipcRenderer.invoke('journal:getYearStats', { year }),
  getDayContext: (date: string) => ipcRenderer.invoke('journal:getDayContext', { date })
}

contextBridge.exposeInMainWorld('api', {
  // ... existing APIs
  journal: journalApi
})
```

Update `src/preload/index.d.ts` with types.

## Step 7: Create Renderer Service

Create `src/renderer/src/services/journal-service.ts`:

```typescript
import type {
  JournalEntry,
  HeatmapEntry,
  MonthEntryPreview,
  MonthStats,
  DayContext
} from '@shared/contracts/journal-api'

export const journalService = {
  async getEntry(date: string): Promise<JournalEntry | null> {
    return window.api.journal.getEntry(date)
  },

  async createEntry(date: string, content = '', tags: string[] = []): Promise<JournalEntry> {
    return window.api.journal.createEntry(date, content, tags)
  },

  async updateEntry(date: string, content?: string, tags?: string[]): Promise<JournalEntry> {
    return window.api.journal.updateEntry(date, content, tags)
  },

  async deleteEntry(date: string): Promise<{ success: boolean }> {
    return window.api.journal.deleteEntry(date)
  },

  async getHeatmap(year: number): Promise<HeatmapEntry[]> {
    return window.api.journal.getHeatmap(year)
  },

  async getMonthEntries(year: number, month: number): Promise<MonthEntryPreview[]> {
    return window.api.journal.getMonthEntries(year, month)
  },

  async getYearStats(year: number): Promise<MonthStats[]> {
    return window.api.journal.getYearStats(year)
  },

  async getDayContext(date: string): Promise<DayContext> {
    return window.api.journal.getDayContext(date)
  }
}
```

## Step 8: Create Journal Hook

Create `src/renderer/src/hooks/use-journal.ts`:

```typescript
import { useState, useEffect, useCallback } from 'react'
import { useDebouncedCallback } from 'use-debounce'
import { journalService } from '@/services/journal-service'
import type { JournalEntry, HeatmapEntry } from '@shared/contracts/journal-api'

export function useJournalEntry(date: string) {
  const [entry, setEntry] = useState<JournalEntry | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Load entry
  useEffect(() => {
    let mounted = true
    setIsLoading(true)

    journalService
      .getEntry(date)
      .then((result) => {
        if (mounted) {
          setEntry(result)
          setIsLoading(false)
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err)
          setIsLoading(false)
        }
      })

    return () => {
      mounted = false
    }
  }, [date])

  // Debounced save (1 second per spec)
  const debouncedSave = useDebouncedCallback(async (content: string, tags?: string[]) => {
    setIsSaving(true)
    try {
      if (!entry) {
        const created = await journalService.createEntry(date, content, tags || [])
        setEntry(created)
      } else {
        const updated = await journalService.updateEntry(date, content, tags)
        setEntry(updated)
      }
    } catch (err) {
      setError(err as Error)
    } finally {
      setIsSaving(false)
    }
  }, 1000)

  const updateContent = useCallback(
    (content: string) => {
      debouncedSave(content)
    },
    [debouncedSave]
  )

  const updateTags = useCallback(
    (tags: string[]) => {
      debouncedSave(entry?.content || '', tags)
    },
    [debouncedSave, entry?.content]
  )

  return {
    entry,
    isLoading,
    isSaving,
    error,
    updateContent,
    updateTags
  }
}

export function useJournalHeatmap(year: number) {
  const [data, setData] = useState<HeatmapEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    journalService
      .getHeatmap(year)
      .then(setData)
      .finally(() => setIsLoading(false))
  }, [year])

  return { data, isLoading }
}
```

## Step 9: Wire Up JournalPage

Update `src/renderer/src/pages/journal.tsx` to use the hook:

```typescript
import { useJournalEntry, useJournalHeatmap } from '@/hooks/use-journal'

export function JournalPage() {
  const [selectedDate, setSelectedDate] = useState(getTodayString())
  const { entry, isLoading, isSaving, updateContent } = useJournalEntry(selectedDate)
  const { data: heatmapData } = useJournalHeatmap(new Date().getFullYear())

  const handleContentChange = useCallback(
    (blocks: Block[]) => {
      const markdown = blocksToMarkdown(blocks)
      updateContent(markdown)
    },
    [updateContent]
  )

  // ... rest of component
}
```

## Running Tests

```bash
# Type check
pnpm typecheck

# Run unit tests
pnpm test

# Run E2E tests
pnpm test:e2e
```

## Common Issues

### Migration Fails

If the migration fails, ensure:

1. The vault is closed (`pnpm db:push:index` requires no open connections)
2. Delete `index.db` and let it rebuild

### IPC Handler Not Found

If IPC calls fail with "handler not found":

1. Check `registerJournalHandlers()` is called in `src/main/ipc/index.ts`
2. Check channel names match between preload and handlers
3. Restart the Electron app after changes

### File Watcher Conflicts

If external edits aren't detected:

1. The watcher already monitors `journal/` folder
2. Check the debounce timing in `src/main/vault/watcher.ts`
3. Ensure the `source: 'external'` flag is used

## Next Steps

After completing the basic implementation:

1. **Add search integration** - Extend FTS5 index for journal entries
2. **Add backlinks** - Reuse note backlinks component with journal support
3. **Add AI connections** - Integrate with 006-ai phase for semantic search
4. **Add templates** - Implement P3 templates feature
5. **Add streaks** - Implement P3 streak tracking
