import { ipcMain } from 'electron'
import { SearchChannels } from '@memry/contracts/ipc-channels'
import {
  SearchQuerySchema,
  AddReasonSchema,
  QuickSearchInputSchema
} from '@memry/contracts/search-api'
import type { SearchReason } from '@memry/contracts/search-api'
import { createLogger } from '../lib/logger'
import { createValidatedHandler, createHandler } from './validate'
import { getDatabase, getIndexDatabase } from '../database'
import { generateId } from '../lib/id'
import { searchQueries } from '../search/store'
import { rebuildAllIndexes } from '@main/database/fts-rebuild'
import { searchReasons } from '@memry/db-schema/schema/search-reasons'
import { eq, desc, sql, and } from 'drizzle-orm'
import { trackMainEvent } from '../telemetry/track'
import { getMainI18n } from '../lib/main-i18n'

const logger = createLogger('IPC:Search')

const resultBucket = (count: number): string => {
  if (count === 0) return 'zero'
  if (count <= 5) return 'one_to_five'
  return 'six_plus'
}

export function registerSearchHandlers(): void {
  ipcMain.handle(
    SearchChannels.invoke.QUERY,
    createValidatedHandler(SearchQuerySchema, async (input) => {
      try {
        const indexDb = getIndexDatabase()
        const dataDb = getDatabase()
        const result = searchQueries.searchAll(indexDb, dataDb, input)
        trackMainEvent('search_performed', {
          surface: 'search',
          action: 'queried',
          result: 'success',
          metrics: {
            durationMs: result.queryTimeMs,
            resultCount: result.totalCount
          },
          source: 'global',
          dimensions: {
            result_bucket: resultBucket(result.totalCount)
          }
        })
        return result
      } catch (error) {
        logger.error('search:query failed:', error)
        trackMainEvent('search_performed', {
          surface: 'search',
          action: 'queried',
          result: 'failed'
        })
        return { groups: [], totalCount: 0, queryTimeMs: 0 }
      }
    })
  )

  ipcMain.handle(
    SearchChannels.invoke.QUICK,
    createValidatedHandler(QuickSearchInputSchema, async (input) => {
      try {
        const indexDb = getIndexDatabase()
        const dataDb = getDatabase()
        const result = searchQueries.quickSearch(indexDb, dataDb, input)
        const totalCount = result.results?.length ?? 0
        trackMainEvent('search_performed', {
          surface: 'search',
          action: 'queried',
          result: 'success',
          metrics: {
            durationMs: result.queryTimeMs,
            resultCount: totalCount
          },
          source: 'quick',
          dimensions: {
            result_bucket: resultBucket(totalCount)
          }
        })
        return result
      } catch (error) {
        logger.error('search:quick failed:', error)
        trackMainEvent('search_performed', {
          surface: 'search',
          action: 'queried',
          result: 'failed'
        })
        return { results: [], queryTimeMs: 0 }
      }
    })
  )

  ipcMain.handle(
    SearchChannels.invoke.GET_STATS,
    createHandler(async () => {
      try {
        const indexDb = getIndexDatabase()
        const dataDb = getDatabase()
        return searchQueries.getSearchStats(indexDb, dataDb)
      } catch (error) {
        logger.error('search:get-stats failed:', error)
        return {
          totalNotes: 0,
          totalJournals: 0,
          totalTasks: 0,
          totalInboxItems: 0,
          totalIndexed: 0,
          lastIndexedAt: null
        }
      }
    })
  )

  ipcMain.handle(
    SearchChannels.invoke.REBUILD_INDEX,
    createHandler(async () => {
      try {
        const indexDb = getIndexDatabase()
        const dataDb = getDatabase()
        const result = await rebuildAllIndexes(indexDb, dataDb)
        return { started: true as const, ...result }
      } catch (error) {
        logger.error('search:rebuild-index failed:', error)
        return { started: false as const, error: getMainI18n().t('errors:search.rebuildFailed') }
      }
    })
  )

  ipcMain.handle(
    SearchChannels.invoke.GET_REASONS,
    createHandler(async () => {
      try {
        const db = getDatabase()
        const rows = db
          .select()
          .from(searchReasons)
          .orderBy(desc(searchReasons.visitedAt))
          .limit(20)
          .all()

        return rows.map((row): SearchReason => ({
          id: row.id,
          itemId: row.itemId,
          itemType: row.itemType as SearchReason['itemType'],
          itemTitle: row.itemTitle,
          itemIcon: row.itemIcon ?? null,
          searchQuery: row.searchQuery,
          visitedAt: row.visitedAt
        }))
      } catch (error) {
        logger.error('search:get-reasons failed:', error)
        return []
      }
    })
  )

  ipcMain.handle(
    SearchChannels.invoke.ADD_REASON,
    createValidatedHandler(AddReasonSchema, async (input) => {
      try {
        const db = getDatabase()
        const now = new Date().toISOString()
        const id = generateId()

        db.insert(searchReasons)
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

        const count = db
          .select({ count: sql<number>`count(*)` })
          .from(searchReasons)
          .get()

        if (count && count.count > 20) {
          const oldest = db
            .select({ id: searchReasons.id })
            .from(searchReasons)
            .orderBy(searchReasons.visitedAt)
            .limit(1)
            .get()

          if (oldest) {
            db.delete(searchReasons).where(eq(searchReasons.id, oldest.id)).run()
          }
        }

        const inserted = db
          .select()
          .from(searchReasons)
          .where(
            and(eq(searchReasons.itemType, input.itemType), eq(searchReasons.itemId, input.itemId))
          )
          .get()

        return inserted as SearchReason
      } catch (error) {
        logger.error('search:add-reason failed:', error)
        throw error
      }
    })
  )

  ipcMain.handle(
    SearchChannels.invoke.CLEAR_REASONS,
    createHandler(async () => {
      try {
        const db = getDatabase()
        db.delete(searchReasons).run()
        return { cleared: true as const }
      } catch (error) {
        logger.error('search:clear-reasons failed:', error)
        throw error
      }
    })
  )

  ipcMain.handle(
    SearchChannels.invoke.GET_ALL_TAGS,
    createHandler(async () => {
      try {
        const indexDb = getIndexDatabase()
        const dataDb = getDatabase()

        const noteTags = indexDb.all<{ tag: string }>(
          sql`SELECT DISTINCT tag FROM note_tags ORDER BY tag`
        )
        const taskTagRows = dataDb.all<{ tag: string }>(
          sql`SELECT DISTINCT tag FROM task_tags ORDER BY tag`
        )
        const inboxTagRows = dataDb.all<{ tag: string }>(
          sql`SELECT DISTINCT tag FROM inbox_item_tags ORDER BY tag`
        )

        const allTags = new Set<string>()
        for (const row of noteTags) allTags.add(row.tag)
        for (const row of taskTagRows) allTags.add(row.tag)
        for (const row of inboxTagRows) allTags.add(row.tag)

        return [...allTags].sort()
      } catch (error) {
        logger.error('search:get-all-tags failed:', error)
        return []
      }
    })
  )
}

export function unregisterSearchHandlers(): void {
  ipcMain.removeHandler(SearchChannels.invoke.QUERY)
  ipcMain.removeHandler(SearchChannels.invoke.QUICK)
  ipcMain.removeHandler(SearchChannels.invoke.GET_STATS)
  ipcMain.removeHandler(SearchChannels.invoke.REBUILD_INDEX)
  ipcMain.removeHandler(SearchChannels.invoke.GET_REASONS)
  ipcMain.removeHandler(SearchChannels.invoke.ADD_REASON)
  ipcMain.removeHandler(SearchChannels.invoke.CLEAR_REASONS)
  ipcMain.removeHandler(SearchChannels.invoke.GET_ALL_TAGS)
}
