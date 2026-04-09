import { ipcMain } from 'electron'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  InboxListSchema,
  InboxJobListSchema,
  ListArchivedSchema,
  GetFilingHistorySchema,
  type InboxListResponse,
  type InboxItemListItem,
  type InboxStats,
  type InboxJob,
  type InboxJobsResponse,
  type ArchivedListResponse,
  type FilingHistoryResponse,
  type FilingHistoryEntry,
  type CapturePattern,
  type InboxItemType
} from '@memry/contracts/inbox-api'
import { inboxItems, inboxItemTags, inboxJobs } from '@memry/db-schema/schema/inbox'
import { eq, desc, asc, and, inArray, isNull, sql, gte, type SQL } from 'drizzle-orm'
import { createLogger } from '../lib/logger'

const logger = createLogger('IPC:InboxQuery')
import {
  getStaleThreshold as getStaleThresholdDays,
  setStaleThreshold as setStaleThresholdDays,
  countStaleItems,
  getTodayActivity,
  getAverageTimeToProcess,
  getInboxHealthMetrics
} from '../inbox/stats'
import type { DataDb } from '../database'

export interface InboxQueryHandlerDeps {
  requireDatabase: () => DataDb
  getItemTags: (db: DataDb, itemId: string) => string[]
  toListItem: (row: typeof inboxItems.$inferSelect, tags: string[]) => InboxItemListItem
}

export interface InboxQueryHandlers {
  handleList: (input: unknown) => Promise<InboxListResponse>
  handleGetJobs: (input: unknown) => Promise<InboxJobsResponse>
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

  async function handleGetJobs(input: unknown): Promise<InboxJobsResponse> {
    const options = InboxJobListSchema.parse(input || {})
    const db = deps.requireDatabase()

    const conditions: SQL<unknown>[] = []
    if (options.itemIds?.length) {
      conditions.push(inArray(inboxJobs.itemId, options.itemIds))
    }

    if (options.statuses?.length) {
      conditions.push(inArray(inboxJobs.status, options.statuses))
    }

    const rows = db
      .select()
      .from(inboxJobs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(inboxJobs.updatedAt))
      .all()

    const jobs: InboxJob[] = rows.map((row) => ({
      id: row.id,
      itemId: row.itemId,
      type: row.type as InboxJob['type'],
      status: row.status as InboxJob['status'],
      runAt: new Date(row.runAt),
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      payload: (row.payload ?? null) as InboxJob['payload'],
      result: (row.result ?? null) as InboxJob['result'],
      lastError: row.lastError,
      startedAt: row.startedAt ? new Date(row.startedAt) : null,
      completedAt: row.completedAt ? new Date(row.completedAt) : null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    }))

    return { jobs }
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
    const emptyResult: CapturePattern = {
      timeHeatmap: Array.from({ length: 24 }, () => new Array<number>(7).fill(0)),
      typeDistribution: [],
      topDomains: [],
      topTags: []
    }

    let db: ReturnType<typeof deps.requireDatabase>
    try {
      db = deps.requireDatabase()
    } catch (err) {
      logger.warn('Database not ready for patterns query', err)
      return emptyResult
    }

    try {
      const twelveWeeksAgo = new Date()
      twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84)
      const cutoff = twelveWeeksAgo.toISOString()

      const heatmapRows = db
        .select({
          hour: sql<number>`cast(strftime('%H', ${inboxItems.createdAt}) as integer)`,
          dow: sql<number>`cast(strftime('%w', ${inboxItems.createdAt}) as integer)`,
          count: sql<number>`count(*)`
        })
        .from(inboxItems)
        .where(gte(inboxItems.createdAt, cutoff))
        .groupBy(
          sql`strftime('%H', ${inboxItems.createdAt})`,
          sql`strftime('%w', ${inboxItems.createdAt})`
        )
        .all()

      const timeHeatmap: number[][] = Array.from({ length: 24 }, () => new Array<number>(7).fill(0))
      for (const row of heatmapRows) {
        const dayIdx = (row.dow + 6) % 7
        if (row.hour >= 0 && row.hour < 24 && dayIdx >= 0 && dayIdx < 7) {
          timeHeatmap[row.hour][dayIdx] = row.count
        }
      }

      const typeRows = db
        .select({
          type: inboxItems.type,
          count: sql<number>`count(*)`
        })
        .from(inboxItems)
        .where(gte(inboxItems.createdAt, cutoff))
        .groupBy(inboxItems.type)
        .orderBy(desc(sql`count(*)`))
        .all()

      const totalForTypes = typeRows.reduce((sum, r) => sum + r.count, 0)
      const typeDistribution = typeRows.map((r) => ({
        type: r.type as InboxItemType,
        count: r.count,
        percentage: totalForTypes > 0 ? Math.round((r.count / totalForTypes) * 100) : 0,
        trend: 'stable' as const
      }))

      const tagRows = db
        .select({
          tag: inboxItemTags.tag,
          count: sql<number>`count(*)`
        })
        .from(inboxItemTags)
        .groupBy(inboxItemTags.tag)
        .orderBy(desc(sql`count(*)`))
        .limit(10)
        .all()

      const linkRows = db
        .select({ sourceUrl: inboxItems.sourceUrl })
        .from(inboxItems)
        .where(
          and(
            sql`${inboxItems.sourceUrl} IS NOT NULL`,
            sql`${inboxItems.sourceUrl} != ''`,
            gte(inboxItems.createdAt, cutoff)
          )
        )
        .all()

      const domainCounts = new Map<string, number>()
      for (const row of linkRows) {
        try {
          const hostname = new URL(row.sourceUrl!).hostname.replace(/^www\./, '')
          domainCounts.set(hostname, (domainCounts.get(hostname) ?? 0) + 1)
        } catch {
          // skip malformed URLs
        }
      }
      const topDomains = [...domainCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([domain, count]) => ({ domain, count }))

      return {
        timeHeatmap,
        typeDistribution,
        topDomains,
        topTags: tagRows
      }
    } catch (err) {
      logger.error('Failed to compute capture patterns', err)
      return emptyResult
    }
  }

  return {
    handleList,
    handleGetJobs,
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
  ipcMain.handle(InboxChannels.invoke.GET_JOBS, (_, input) => handlers.handleGetJobs(input))
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
  ipcMain.removeHandler(InboxChannels.invoke.GET_JOBS)
  ipcMain.removeHandler(InboxChannels.invoke.GET_TAGS)
  ipcMain.removeHandler(InboxChannels.invoke.GET_STATS)
  ipcMain.removeHandler(InboxChannels.invoke.GET_PATTERNS)
  ipcMain.removeHandler(InboxChannels.invoke.GET_STALE_THRESHOLD)
  ipcMain.removeHandler(InboxChannels.invoke.SET_STALE_THRESHOLD)
  ipcMain.removeHandler(InboxChannels.invoke.LIST_ARCHIVED)
  ipcMain.removeHandler(InboxChannels.invoke.GET_FILING_HISTORY)
}
