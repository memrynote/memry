import { desc, eq, sql, and } from 'drizzle-orm'
import { searchReasons } from '@memry/db-schema/data-schema'
import type { DrizzleDb as DataDb } from '@memry/db-schema/drizzle-db'
import { createId } from './ids.ts'
import type { InboxService } from './service-types.ts'
import type { NotesService } from './service-types.ts'
import type { TagsService } from './tags.ts'
import type { TasksService } from './tasks.ts'
import type { TemplatesService } from './service-types.ts'

export interface SearchStats {
  totalNotes: number
  totalJournals: number
  totalTasks: number
  totalInboxItems: number
  totalIndexed: number
  lastIndexedAt: string | null
}

export type SearchReasonItemType = 'note' | 'journal' | 'task' | 'inbox'

export interface SearchReasonRecord {
  id: string
  itemId: string
  itemType: SearchReasonItemType
  itemTitle: string
  itemIcon: string | null
  searchQuery: string
  visitedAt: string
}

export interface AddSearchReasonInput {
  itemId: string
  itemType: SearchReasonItemType
  itemTitle: string
  itemIcon?: string | null
  searchQuery: string
}

export interface SearchReasonsService {
  list(): Promise<SearchReasonRecord[]>
  add(input: AddSearchReasonInput): Promise<SearchReasonRecord>
  clear(): Promise<{ cleared: true }>
}

function newest(values: Array<string | null | undefined>): string | null {
  return (
    values
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null
  )
}

function toSearchReason(row: typeof searchReasons.$inferSelect): SearchReasonRecord {
  return {
    id: row.id,
    itemId: row.itemId,
    itemType: row.itemType as SearchReasonItemType,
    itemTitle: row.itemTitle,
    itemIcon: row.itemIcon,
    searchQuery: row.searchQuery,
    visitedAt: row.visitedAt
  }
}

export function createSearchStatsService({
  notes,
  tasks,
  inbox
}: {
  notes: NotesService
  tasks: TasksService
  inbox: InboxService
}): () => Promise<SearchStats> {
  return async () => {
    const noteRows = await notes.list({ limit: 10000 })
    const journalRows = await notes.list({ journalOnly: true, limit: 10000 })
    const taskRows = await tasks.list({ includeCompleted: true, includeArchived: true })
    const inboxRows = (await inbox.list({ includeArchived: true })).items

    return {
      totalNotes: noteRows.length,
      totalJournals: journalRows.length,
      totalTasks: taskRows.length,
      totalInboxItems: inboxRows.length,
      totalIndexed: noteRows.length + journalRows.length + taskRows.length + inboxRows.length,
      lastIndexedAt: newest([
        ...noteRows.map((note) => note.modifiedAt),
        ...journalRows.map((journal) => journal.modifiedAt),
        ...taskRows.map((task) => task.modifiedAt),
        ...inboxRows.map((item) => item.modifiedAt)
      ])
    }
  }
}

export function createSearchReasonsService(dataDb: DataDb): SearchReasonsService {
  return {
    async list() {
      return dataDb
        .select()
        .from(searchReasons)
        .orderBy(desc(searchReasons.visitedAt))
        .limit(20)
        .all()
        .map(toSearchReason)
    },

    async add(input) {
      const now = new Date().toISOString()
      const id = createId('search_reason')
      dataDb
        .insert(searchReasons)
        .values({
          id,
          itemId: input.itemId,
          itemType: input.itemType,
          itemTitle: input.itemTitle,
          itemIcon: input.itemIcon ?? null,
          searchQuery: input.searchQuery,
          visitedAt: now
        })
        .onConflictDoUpdate({
          target: [searchReasons.itemType, searchReasons.itemId],
          set: {
            itemTitle: input.itemTitle,
            itemIcon: input.itemIcon ?? null,
            searchQuery: input.searchQuery,
            visitedAt: now
          }
        })
        .run()

      const count = dataDb
        .select({ count: sql<number>`count(*)` })
        .from(searchReasons)
        .get()
      if (count && count.count > 20) {
        const oldest = dataDb
          .select({ id: searchReasons.id })
          .from(searchReasons)
          .orderBy(searchReasons.visitedAt)
          .limit(1)
          .get()
        if (oldest) dataDb.delete(searchReasons).where(eq(searchReasons.id, oldest.id)).run()
      }

      const row = dataDb
        .select()
        .from(searchReasons)
        .where(
          and(eq(searchReasons.itemType, input.itemType), eq(searchReasons.itemId, input.itemId))
        )
        .get()
      if (!row) throw new Error('Search reason not found after write')
      return toSearchReason(row)
    },

    async clear() {
      dataDb.delete(searchReasons).run()
      return { cleared: true }
    }
  }
}

export function createSearchTagsService({
  tags,
  templates
}: {
  tags: TagsService
  templates: TemplatesService
}): () => Promise<string[]> {
  return async () => {
    const values = new Set<string>()
    for (const tag of await tags.list()) values.add(tag.name)
    for (const template of await templates.list()) {
      for (const tag of template.tags) values.add(tag)
    }
    return [...values].sort()
  }
}
