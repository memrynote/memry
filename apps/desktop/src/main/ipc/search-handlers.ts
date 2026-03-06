/**
 * Search IPC handlers.
 * Handles all search-related IPC communication from renderer.
 *
 * @module ipc/search-handlers
 */

import { ipcMain } from 'electron'
import {
  SearchChannels,
  SearchQuerySchema,
  QuickSearchSchema,
  SuggestionsSchema,
  AdvancedSearchSchema,
  type SearchResponse,
  type QuickSearchResponse,
  type SuggestionsResponse,
  type SearchStats
} from '@memry/contracts/search-api'
import { createLogger } from '../lib/logger'
import { createValidatedHandler, createHandler, createStringHandler } from './validate'
import {
  searchNotes,
  quickSearch,
  getSuggestions,
  findNotesByTag,
  findBacklinks,
  getSearchableCount,
  isFtsHealthy,
  advancedSearch
} from '@main/database/queries/search'
import { getIndexDatabase, getRawIndexDatabase } from '../database'

// ============================================================================
// Recent Searches (in-memory store)
// ============================================================================

const logger = createLogger('IPC:Search')

const MAX_RECENT_SEARCHES = 20
let recentSearches: string[] = []

function addRecentSearch(query: string): void {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return

  // Remove if already exists
  recentSearches = recentSearches.filter((s) => s !== normalized)

  // Add to front
  recentSearches.unshift(normalized)

  // Trim to max size
  if (recentSearches.length > MAX_RECENT_SEARCHES) {
    recentSearches = recentSearches.slice(0, MAX_RECENT_SEARCHES)
  }
}

// ============================================================================
// Handler Registration
// ============================================================================

/**
 * Register all search-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerSearchHandlers(): void {
  // search:query - Full search with all options
  ipcMain.handle(
    SearchChannels.invoke.SEARCH,
    createValidatedHandler(SearchQuerySchema, (input) => {
      const startTime = performance.now()
      const db = getIndexDatabase()

      try {
        addRecentSearch(input.query)

        const results = searchNotes(db, input.query, {
          limit: input.limit,
          offset: input.offset,
          tags: input.tags,
          folder: undefined
        })

        const queryTime = Math.round(performance.now() - startTime)

        const response: SearchResponse = {
          results: results.map((r) => ({
            type: 'note' as const,
            id: r.id,
            path: r.path,
            title: r.title,
            snippet: r.snippet,
            score: r.score,
            matchedIn: r.matchedIn,
            created: r.createdAt,
            modified: r.modifiedAt,
            tags: r.tags
          })),
          total: results.length,
          hasMore: results.length === input.limit,
          queryTime
        }

        return response
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Search failed'
        logger.error('Query error:', message)
        return {
          results: [],
          total: 0,
          hasMore: false,
          queryTime: Math.round(performance.now() - startTime),
          error: message
        }
      }
    })
  )

  // search:quick - Quick search for command palette
  ipcMain.handle(
    SearchChannels.invoke.QUICK_SEARCH,
    createValidatedHandler(QuickSearchSchema, (input) => {
      const db = getIndexDatabase()

      try {
        const result = quickSearch(db, input.query, input.limit)

        const response: QuickSearchResponse = {
          notes: result.notes.map((r) => ({
            type: 'note' as const,
            id: r.id,
            path: r.path,
            title: r.title,
            snippet: r.snippet,
            score: r.score,
            matchedIn: r.matchedIn,
            created: r.createdAt,
            modified: r.modifiedAt,
            tags: r.tags
          })),
          tasks: [] // Tasks not implemented yet
        }

        return response
      } catch (error) {
        logger.error('Quick search error:', error)
        return { notes: [], tasks: [] }
      }
    })
  )

  // search:suggestions - Get search suggestions
  ipcMain.handle(
    SearchChannels.invoke.SUGGESTIONS,
    createValidatedHandler(SuggestionsSchema, (input) => {
      const db = getIndexDatabase()

      try {
        const suggestions = getSuggestions(db, input.prefix, input.limit)

        const response: SuggestionsResponse = {
          suggestions
        }

        return response
      } catch (error) {
        logger.error('Suggestions error:', error)
        return { suggestions: [] }
      }
    })
  )

  // search:get-recent - Get recent searches
  ipcMain.handle(
    SearchChannels.invoke.GET_RECENT,
    createHandler(() => {
      return recentSearches
    })
  )

  // search:clear-recent - Clear recent searches
  ipcMain.handle(
    SearchChannels.invoke.CLEAR_RECENT,
    createHandler(() => {
      recentSearches = []
    })
  )

  // search:add-recent - Add to recent searches
  ipcMain.handle(
    SearchChannels.invoke.ADD_RECENT,
    createStringHandler((query) => {
      addRecentSearch(query)
    })
  )

  // search:get-stats - Get search index stats
  ipcMain.handle(
    SearchChannels.invoke.GET_STATS,
    createHandler(() => {
      const db = getIndexDatabase()

      const totalNotes = getSearchableCount(db)
      const healthy = isFtsHealthy(db)

      const stats: SearchStats = {
        totalNotes,
        totalTasks: 0, // Tasks not implemented yet
        totalJournals: 0, // Journals not implemented yet
        lastIndexed: new Date().toISOString(),
        indexHealth: healthy ? 'healthy' : 'corrupt'
      }

      return stats
    })
  )

  // search:rebuild-index - Force rebuild search index
  ipcMain.handle(
    SearchChannels.invoke.REBUILD_INDEX,
    createHandler(() => {
      // TODO: Implement full index rebuild
      // This would clear FTS and re-index all notes from files
      logger.info('Index rebuild requested - not yet implemented')
    })
  )

  // search:notes - Search notes only (optimized)
  ipcMain.handle(
    SearchChannels.invoke.SEARCH_NOTES,
    createValidatedHandler(
      QuickSearchSchema, // Reuse quick search schema
      (input) => {
        const db = getIndexDatabase()
        const results = searchNotes(db, input.query, { limit: input.limit })

        return results.map((r) => ({
          type: 'note' as const,
          id: r.id,
          path: r.path,
          title: r.title,
          snippet: r.snippet,
          score: r.score,
          matchedIn: r.matchedIn,
          created: r.createdAt,
          modified: r.modifiedAt,
          tags: r.tags
        }))
      }
    )
  )

  // search:find-by-tag - Find notes by tag
  ipcMain.handle(
    SearchChannels.invoke.FIND_BY_TAG,
    createStringHandler((tag) => {
      const db = getIndexDatabase()
      const results = findNotesByTag(db, tag)

      return results.map((r) => ({
        type: 'note' as const,
        id: r.id,
        path: r.path,
        title: r.title,
        snippet: r.snippet,
        score: r.score,
        matchedIn: r.matchedIn,
        created: r.createdAt,
        modified: r.modifiedAt,
        tags: r.tags
      }))
    })
  )

  // search:find-backlinks - Find notes linking to a note
  ipcMain.handle(
    SearchChannels.invoke.FIND_BACKLINKS,
    createStringHandler((noteId) => {
      const db = getIndexDatabase()
      const results = findBacklinks(db, noteId)

      return results.map((r) => ({
        type: 'note' as const,
        id: r.id,
        path: r.path,
        title: r.title,
        snippet: r.snippet,
        score: r.score,
        matchedIn: r.matchedIn,
        created: r.createdAt,
        modified: r.modifiedAt,
        tags: r.tags
      }))
    })
  )

  // search:advanced - Advanced search with operators, filters, and sorting
  ipcMain.handle(
    SearchChannels.invoke.ADVANCED_SEARCH,
    createValidatedHandler(AdvancedSearchSchema, (input) => {
      const startTime = performance.now()
      const db = getIndexDatabase()
      const rawDb = getRawIndexDatabase()

      try {
        const results = advancedSearch(db, rawDb, {
          text: input.text,
          operators: input.operators,
          titleOnly: input.titleOnly,
          sortBy: input.sortBy,
          sortDirection: input.sortDirection,
          folder: input.folder,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          limit: input.limit,
          offset: input.offset
        })

        const queryTime = Math.round(performance.now() - startTime)
        logger.debug(`Advanced search completed in ${queryTime}ms, found ${results.length} results`)

        return results.map((r) => ({
          type: 'note' as const,
          id: r.id,
          path: r.path,
          title: r.title,
          emoji: r.emoji,
          snippet: r.snippet,
          score: r.score,
          matchedIn: r.matchedIn,
          created: r.createdAt,
          modified: r.modifiedAt,
          tags: r.tags
        }))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Advanced search failed'
        logger.error('Advanced search error:', message)
        return []
      }
    })
  )

  logger.info('Search handlers registered')
}

/**
 * Unregister all search-related IPC handlers.
 * Useful for cleanup during testing.
 */
export function unregisterSearchHandlers(): void {
  Object.values(SearchChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
}
