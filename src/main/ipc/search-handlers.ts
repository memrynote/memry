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
  type SearchResponse,
  type QuickSearchResponse,
  type SuggestionsResponse,
  type SearchStats
} from '@shared/contracts/search-api'
import { createValidatedHandler, createHandler, createStringHandler } from './validate'
import {
  searchNotes,
  quickSearch,
  getSuggestions,
  findNotesByTag,
  findBacklinks,
  getSearchableCount,
  isFtsHealthy
} from '@shared/db/queries/search'
import { getIndexDatabase } from '../database'

// ============================================================================
// Recent Searches (in-memory store)
// ============================================================================

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
    createValidatedHandler(SearchQuerySchema, async (input) => {
      const startTime = performance.now()
      const db = getIndexDatabase()

      try {
        const results = searchNotes(db, input.query, {
          limit: input.limit,
          offset: input.offset,
          tags: input.tags,
          folder: undefined // Could add folder filter if needed
        })

        // Add to recent searches
        addRecentSearch(input.query)

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
        console.error('[Search] Query error:', message)
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
    createValidatedHandler(QuickSearchSchema, async (input) => {
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
        console.error('[Search] Quick search error:', error)
        return { notes: [], tasks: [] }
      }
    })
  )

  // search:suggestions - Get search suggestions
  ipcMain.handle(
    SearchChannels.invoke.SUGGESTIONS,
    createValidatedHandler(SuggestionsSchema, async (input) => {
      const db = getIndexDatabase()

      try {
        const suggestions = getSuggestions(db, input.prefix, input.limit)

        const response: SuggestionsResponse = {
          suggestions
        }

        return response
      } catch (error) {
        console.error('[Search] Suggestions error:', error)
        return { suggestions: [] }
      }
    })
  )

  // search:get-recent - Get recent searches
  ipcMain.handle(
    SearchChannels.invoke.GET_RECENT,
    createHandler(async () => {
      return recentSearches
    })
  )

  // search:clear-recent - Clear recent searches
  ipcMain.handle(
    SearchChannels.invoke.CLEAR_RECENT,
    createHandler(async () => {
      recentSearches = []
    })
  )

  // search:add-recent - Add to recent searches
  ipcMain.handle(
    SearchChannels.invoke.ADD_RECENT,
    createStringHandler(async (query) => {
      addRecentSearch(query)
    })
  )

  // search:get-stats - Get search index stats
  ipcMain.handle(
    SearchChannels.invoke.GET_STATS,
    createHandler(async () => {
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
    createHandler(async () => {
      // TODO: Implement full index rebuild
      // This would clear FTS and re-index all notes from files
      console.log('[Search] Index rebuild requested - not yet implemented')
    })
  )

  // search:notes - Search notes only (optimized)
  ipcMain.handle(
    SearchChannels.invoke.SEARCH_NOTES,
    createValidatedHandler(
      QuickSearchSchema, // Reuse quick search schema
      async (input) => {
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
    createStringHandler(async (tag) => {
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
    createStringHandler(async (noteId) => {
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

  console.log('[IPC] Search handlers registered')
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
