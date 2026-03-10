import { ipcMain } from 'electron'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  InboxListSchema,
  ListArchivedSchema,
  GetFilingHistorySchema,
  type InboxListResponse,
  type InboxItemListItem,
  type InboxStats,
  type ArchivedListResponse,
  type FilingHistoryResponse,
  type FilingHistoryEntry,
  type CapturePattern
} from '@memry/contracts/inbox-api'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import { eq, desc, asc, and, isNull, sql } from 'drizzle-orm'
import {
  getStaleThreshold as getStaleThresholdDays,
  setStaleThreshold as setStaleThresholdDays,
  countStaleItems,
  getTodayActivity,
  getAverageTimeToProcess,
  getInboxHealthMetrics
} from '../inbox/stats'
import type { DrizzleDb } from '../database'

export interface InboxQueryHandlerDeps {
  requireDatabase: () => DrizzleDb
  getItemTags: (db: DrizzleDb, itemId: string) => string[]
  toListItem: (row: typeof inboxItems.$inferSelect, tags: string[]) => InboxItemListItem
}

export interface InboxQueryHandlers {
  handleList: (input: unknown) => Promise<InboxListResponse>
  handleGetTags: () => Promise<Array<{ tag: string; count: number }>>
  handleGetStats: () => Promise<InboxStats>
  handleGetStaleThreshold: () => Promise<number>
  handleSetStaleThreshold: (days: number) => Promise<{ success: boolean }>
  handleListArchived: (input: unknown) => Promise<ArchivedListResponse>
  handleGetFilingHistory: (input: unknown) => Promise<FilingHistoryResponse>
  handleGetPatterns: () => Promise<CapturePattern>
}

export function createInboxQueryHandlers(deps: InboxQueryHandlerDeps): InboxQueryHandlers {
  async function handleList(input: unknown): Promise<InboxListResponse> {
    const options = InboxListSchema.parse(input || {})
    const db = deps.requireDatabase()

    const conditions: ReturnType<typeof eq>[] = []

    if (options.type) {
      conditions.push(eq(inboxItems.type, options.type))
    }

    conditions.push(isNull(inboxItems.filedAt))

    if (!options.includeSnoozed) {
      conditions.push(isNull(inboxItems.snoozedUntil))
    }

    conditions.push(isNull(inboxItems.archivedAt))

    let query = db.select().from(inboxItems)

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query
    }

    const sortColumn =
      options.sortBy === 'modified'
        ? inboxItems.modifiedAt
        : options.sortBy === 'title'
          ? inboxItems.title
          : inboxItems.createdAt

    query = query.orderBy(
      options.sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn)
    ) as typeof query

    const countResult = db
      .select({ count: sql<number>`count(*)` })
      .from(inboxItems)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .get()
    const total = countResult?.count || 0

    query = query.limit(options.limit).offset(options.offset) as typeof query

    const rows = query.all()

    const items: InboxItemListItem[] = rows.map((row) => {
      const tags = deps.getItemTags(db, row.id)
      return deps.toListItem(row, tags)
    })

    return {
      items,
      total,
      hasMore: options.offset + items.length < total
    }
  }

  async function handleGetTags(): Promise<Array<{ tag: string; count: number }>> {
    const db = deps.requireDatabase()

    const result = db
      .select({
        tag: inboxItemTags.tag,
        count: sql<number>`count(*)`
      })
      .from(inboxItemTags)
      .groupBy(inboxItemTags.tag)
      .orderBy(desc(sql`count(*)`))
      .all()

    return result
  }

  async function handleGetStats(): Promise<InboxStats> {
    const db = deps.requireDatabase()

    const totalResult = db
      .select({ count: sql<number>`count(*)` })
      .from(inboxItems)
      .where(
        and(
          isNull(inboxItems.filedAt),
          isNull(inboxItems.snoozedUntil),
          isNull(inboxItems.archivedAt)
        )
      )
      .get()

    const typeResult = db
      .select({
        type: inboxItems.type,
        count: sql<number>`count(*)`
      })
      .from(inboxItems)
      .where(
        and(
          isNull(inboxItems.filedAt),
          isNull(inboxItems.snoozedUntil),
          isNull(inboxItems.archivedAt)
        )
      )
      .groupBy(inboxItems.type)
      .all()

    const itemsByType: Record<string, number> = {
      link: 0,
      note: 0,
      image: 0,
      voice: 0,
      clip: 0,
      pdf: 0,
      social: 0
    }

    for (const row of typeResult) {
      itemsByType[row.type] = row.count
    }

    const staleCount = countStaleItems()

    const snoozedResult = db
      .select({ count: sql<number>`count(*)` })
      .from(inboxItems)
      .where(and(sql`${inboxItems.snoozedUntil} IS NOT NULL`, isNull(inboxItems.archivedAt)))
      .get()

    const { capturedToday, processedToday } = getTodayActivity()
    const avgTimeToProcess = getAverageTimeToProcess()
    const health = getInboxHealthMetrics()

    return {
      totalItems: totalResult?.count || 0,
      itemsByType: itemsByType as InboxStats['itemsByType'],
      staleCount,
      snoozedCount: snoozedResult?.count || 0,
      processedToday,
      capturedToday,
      avgTimeToProcess,
      capturedThisWeek: health.capturedThisWeek,
      processedThisWeek: health.processedThisWeek,
      captureProcessRatio: health.captureProcessRatio,
      ageDistribution: health.ageDistribution,
      oldestItemDays: health.oldestItemDays,
      currentStreak: health.currentStreak
    }
  }

  async function handleGetStaleThreshold(): Promise<number> {
    return getStaleThresholdDays()
  }

  async function handleSetStaleThreshold(days: number): Promise<{ success: boolean }> {
    setStaleThresholdDays(days)
    return { success: true }
  }

  async function handleListArchived(input: unknown): Promise<ArchivedListResponse> {
    const options = ListArchivedSchema.parse(input || {})
    const db = deps.requireDatabase()

    const conditions: ReturnType<typeof sql>[] = []
    conditions.push(sql`${inboxItems.archivedAt} IS NOT NULL`)

    if (options.search) {
      conditions.push(
        sql`(${inboxItems.title} LIKE ${'%' + options.search + '%'} OR ${inboxItems.content} LIKE ${'%' + options.search + '%'})`
      )
    }

    const countResult = db
      .select({ count: sql<number>`count(*)` })
      .from(inboxItems)
      .where(and(...conditions))
      .get()

    const total = countResult?.count || 0

    const rows = db
      .select()
      .from(inboxItems)
      .where(and(...conditions))
      .orderBy(desc(inboxItems.archivedAt))
      .limit(options.limit)
      .offset(options.offset)
      .all()

    const items: InboxItemListItem[] = rows.map((row) => {
      const tags = deps.getItemTags(db, row.id)
      return deps.toListItem(row, tags)
    })

    return {
      items,
      total,
      hasMore: options.offset + items.length < total
    }
  }

  async function handleGetFilingHistory(input: unknown): Promise<FilingHistoryResponse> {
    const options = GetFilingHistorySchema.parse(input || {})
    const db = deps.requireDatabase()

    const rows = db
      .select()
      .from(inboxItems)
      .where(sql`${inboxItems.filedAt} IS NOT NULL`)
      .orderBy(desc(inboxItems.filedAt))
      .limit(options.limit)
      .all()

    const entries: FilingHistoryEntry[] = rows.map((row) => {
      const tags = deps.getItemTags(db, row.id)
      return {
        id: row.id,
        itemId: row.id,
        itemType: row.type as FilingHistoryEntry['itemType'],
        itemTitle: row.title,
        filedTo: row.filedTo || '',
        filedAction: (row.filedAction || 'folder') as FilingHistoryEntry['filedAction'],
        filedAt: new Date(row.filedAt!),
        tags
      }
    })

    return { entries }
  }

  async function handleGetPatterns(): Promise<CapturePattern> {
    return {
      timeHeatmap: [],
      typeDistribution: [],
      topDomains: [],
      topTags: []
    }
  }

  return {
    handleList,
    handleGetTags,
    handleGetStats,
    handleGetStaleThreshold,
    handleSetStaleThreshold,
    handleListArchived,
    handleGetFilingHistory,
    handleGetPatterns
  }
}

export function registerInboxQueryHandlers(handlers: InboxQueryHandlers): void {
  ipcMain.handle(InboxChannels.invoke.LIST, (_, input) => handlers.handleList(input))
  ipcMain.handle(InboxChannels.invoke.GET_TAGS, () => handlers.handleGetTags())
  ipcMain.handle(InboxChannels.invoke.GET_STATS, () => handlers.handleGetStats())
  ipcMain.handle(InboxChannels.invoke.GET_PATTERNS, () => handlers.handleGetPatterns())
  ipcMain.handle(InboxChannels.invoke.GET_STALE_THRESHOLD, () => handlers.handleGetStaleThreshold())
  ipcMain.handle(InboxChannels.invoke.SET_STALE_THRESHOLD, (_, days) =>
    handlers.handleSetStaleThreshold(days)
  )
  ipcMain.handle(InboxChannels.invoke.LIST_ARCHIVED, (_, input) =>
    handlers.handleListArchived(input)
  )
  ipcMain.handle(InboxChannels.invoke.GET_FILING_HISTORY, (_, input) =>
    handlers.handleGetFilingHistory(input)
  )
}

export function unregisterInboxQueryHandlers(): void {
  ipcMain.removeHandler(InboxChannels.invoke.LIST)
  ipcMain.removeHandler(InboxChannels.invoke.GET_TAGS)
  ipcMain.removeHandler(InboxChannels.invoke.GET_STATS)
  ipcMain.removeHandler(InboxChannels.invoke.GET_PATTERNS)
  ipcMain.removeHandler(InboxChannels.invoke.GET_STALE_THRESHOLD)
  ipcMain.removeHandler(InboxChannels.invoke.SET_STALE_THRESHOLD)
  ipcMain.removeHandler(InboxChannels.invoke.LIST_ARCHIVED)
  ipcMain.removeHandler(InboxChannels.invoke.GET_FILING_HISTORY)
}
