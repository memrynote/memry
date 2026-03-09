/* eslint-disable @typescript-eslint/require-await */

import { ipcMain } from 'electron'
import { SearchChannels } from '@memry/contracts/ipc-channels'
import { SearchQuerySchema, AddRecentSchema } from '@memry/contracts/search-api'
import type { RecentSearch } from '@memry/contracts/search-api'
import { createLogger } from '../lib/logger'
import { createValidatedHandler, createHandler, createStringHandler } from './validate'
import { getDatabase, getIndexDatabase } from '../database'
import { generateId } from '../lib/id'
import * as searchQueries from '@main/database/queries/search'
import { rebuildAllIndexes } from '@main/database/fts-rebuild'
import { recentSearches } from '@memry/db-schema/schema/recent-searches'
import { eq, desc, sql } from 'drizzle-orm'

const logger = createLogger('IPC:Search')

export function registerSearchHandlers(): void {
  ipcMain.handle(
    SearchChannels.invoke.QUERY,
    createValidatedHandler(SearchQuerySchema, async (input) => {
      try {
        const indexDb = getIndexDatabase()
        const dataDb = getDatabase()
        return searchQueries.searchAll(indexDb, dataDb, input)
      } catch (error) {
        logger.error('search:query failed:', error)
        return { groups: [], totalCount: 0, queryTimeMs: 0 }
      }
    })
  )

  ipcMain.handle(
    SearchChannels.invoke.QUICK,
    createStringHandler(async (text) => {
      try {
        const indexDb = getIndexDatabase()
        const dataDb = getDatabase()
        return searchQueries.quickSearch(indexDb, dataDb, text)
      } catch (error) {
        logger.error('search:quick failed:', error)
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
        const result = rebuildAllIndexes(indexDb, dataDb)
        return { started: true as const, ...result }
      } catch (error) {
        logger.error('search:rebuild-index failed:', error)
        return { started: false as const, error: 'Rebuild failed' }
      }
    })
  )

  ipcMain.handle(
    SearchChannels.invoke.GET_RECENT,
    createHandler(async () => {
      try {
        const db = getDatabase()
        const rows = db
          .select()
          .from(recentSearches)
          .orderBy(desc(recentSearches.searchedAt))
          .limit(5)
          .all()

        return rows.map(
          (row): RecentSearch => ({
            id: row.id,
            query: row.query,
            resultCount: row.resultCount,
            searchedAt: row.searchedAt
          })
        )
      } catch (error) {
        logger.error('search:get-recent failed:', error)
        return []
      }
    })
  )

  ipcMain.handle(
    SearchChannels.invoke.ADD_RECENT,
    createValidatedHandler(AddRecentSchema, async (input) => {
      try {
        const db = getDatabase()

        const count = db
          .select({ count: sql<number>`count(*)` })
          .from(recentSearches)
          .get()

        if (count && count.count >= 5) {
          const oldest = db
            .select({ id: recentSearches.id })
            .from(recentSearches)
            .orderBy(recentSearches.searchedAt)
            .limit(1)
            .get()

          if (oldest) {
            db.delete(recentSearches).where(eq(recentSearches.id, oldest.id)).run()
          }
        }

        const newEntry = {
          id: generateId(),
          query: input.query,
          resultCount: input.resultCount
        }

        db.insert(recentSearches).values(newEntry).run()

        const inserted = db
          .select()
          .from(recentSearches)
          .where(eq(recentSearches.id, newEntry.id))
          .get()

        return inserted as RecentSearch
      } catch (error) {
        logger.error('search:add-recent failed:', error)
        throw error
      }
    })
  )

  ipcMain.handle(
    SearchChannels.invoke.CLEAR_RECENT,
    createHandler(async () => {
      try {
        const db = getDatabase()
        db.delete(recentSearches).run()
        return { cleared: true as const }
      } catch (error) {
        logger.error('search:clear-recent failed:', error)
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
  ipcMain.removeHandler(SearchChannels.invoke.GET_RECENT)
  ipcMain.removeHandler(SearchChannels.invoke.ADD_RECENT)
  ipcMain.removeHandler(SearchChannels.invoke.CLEAR_RECENT)
  ipcMain.removeHandler(SearchChannels.invoke.GET_ALL_TAGS)
}
