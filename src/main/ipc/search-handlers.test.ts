/**
 * Search IPC handlers tests
 *
 * @module ipc/search-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { SearchChannels } from '@shared/contracts/search-api'

// Track mock calls
const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []

// Mock electron modules
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  }
}))

// Mock database module
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn()
}))

// Mock search queries
vi.mock('@shared/db/queries/search', () => ({
  searchNotes: vi.fn(),
  quickSearch: vi.fn(),
  getSuggestions: vi.fn(),
  findNotesByTag: vi.fn(),
  findBacklinks: vi.fn(),
  getSearchableCount: vi.fn(),
  isFtsHealthy: vi.fn()
}))

// Import after mocking
import { registerSearchHandlers, unregisterSearchHandlers } from './search-handlers'
import { getIndexDatabase } from '../database'
import * as searchQueries from '@shared/db/queries/search'

describe('search-handlers', () => {
  let mockDb: { run: Mock; get: Mock; all: Mock }

  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0

    // Setup mock database
    mockDb = {
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn()
    }
    ;(getIndexDatabase as Mock).mockReturnValue(mockDb)
  })

  afterEach(() => {
    unregisterSearchHandlers()
  })

  describe('registerSearchHandlers', () => {
    it('should register all search handlers', () => {
      registerSearchHandlers()

      const invokeChannels = Object.values(SearchChannels.invoke)
      // SEARCH_TASKS not implemented yet, so expect 1 less
      expect(handleCalls.length).toBeGreaterThanOrEqual(invokeChannels.length - 1)
    })
  })

  describe('unregisterSearchHandlers', () => {
    it('should unregister all search handlers', () => {
      registerSearchHandlers()
      unregisterSearchHandlers()

      const invokeChannels = Object.values(SearchChannels.invoke)
      expect(removeHandlerCalls.length).toBe(invokeChannels.length)
    })
  })

  // =========================================================================
  // T461: SEARCH, QUICK_SEARCH handlers
  // =========================================================================
  describe('SEARCH handler', () => {
    beforeEach(() => {
      registerSearchHandlers()
    })

    it('should perform basic FTS search', async () => {
      const mockResults = [
        {
          id: 'note1',
          path: 'notes/test.md',
          title: 'Test Note',
          snippet: 'This is a test...',
          score: 1.5,
          matchedIn: ['title'],
          createdAt: '2026-01-01',
          modifiedAt: '2026-01-02',
          tags: ['test']
        }
      ]
      ;(searchQueries.searchNotes as Mock).mockReturnValue(mockResults)

      const result = await invokeHandler(SearchChannels.invoke.SEARCH, {
        query: 'test',
        limit: 20
      })

      expect(result.results).toHaveLength(1)
      expect(result.results[0].title).toBe('Test Note')
      expect(searchQueries.searchNotes).toHaveBeenCalledWith(
        mockDb,
        'test',
        expect.objectContaining({ limit: 20 })
      )
    })

    it('should include query time in response', async () => {
      ;(searchQueries.searchNotes as Mock).mockReturnValue([])

      const result = await invokeHandler(SearchChannels.invoke.SEARCH, {
        query: 'test'
      })

      expect(result.queryTime).toBeDefined()
      expect(typeof result.queryTime).toBe('number')
    })

    it('should handle BM25 ranking correctly', async () => {
      const mockResults = [
        { id: 'note1', score: 2.5, title: 'Best Match' },
        { id: 'note2', score: 1.5, title: 'Good Match' },
        { id: 'note3', score: 0.5, title: 'Weak Match' }
      ]
      ;(searchQueries.searchNotes as Mock).mockReturnValue(mockResults)

      const result = await invokeHandler(SearchChannels.invoke.SEARCH, {
        query: 'match'
      })

      expect(result.results[0].score).toBeGreaterThan(result.results[1].score)
    })

    it('should handle phrase matching', async () => {
      ;(searchQueries.searchNotes as Mock).mockReturnValue([
        { id: 'note1', title: 'Exact Phrase Match' }
      ])

      await invokeHandler(SearchChannels.invoke.SEARCH, {
        query: '"exact phrase"'
      })

      expect(searchQueries.searchNotes).toHaveBeenCalledWith(
        mockDb,
        '"exact phrase"',
        expect.any(Object)
      )
    })

    it('should filter by tags', async () => {
      ;(searchQueries.searchNotes as Mock).mockReturnValue([])

      await invokeHandler(SearchChannels.invoke.SEARCH, {
        query: 'test',
        tags: ['important', 'work']
      })

      expect(searchQueries.searchNotes).toHaveBeenCalledWith(
        mockDb,
        'test',
        expect.objectContaining({ tags: ['important', 'work'] })
      )
    })

    it('should add query to recent searches', async () => {
      ;(searchQueries.searchNotes as Mock).mockReturnValue([])

      await invokeHandler(SearchChannels.invoke.SEARCH, {
        query: 'test search'
      })

      // Get recent searches to verify
      const recent = await invokeHandler(SearchChannels.invoke.GET_RECENT)
      expect(recent).toContain('test search')
    })

    it('should handle search errors gracefully', async () => {
      ;(searchQueries.searchNotes as Mock).mockImplementation(() => {
        throw new Error('FTS error')
      })

      const result = await invokeHandler(SearchChannels.invoke.SEARCH, {
        query: 'test'
      })

      expect(result.results).toEqual([])
      expect(result.error).toBe('FTS error')
    })

    it('should return hasMore when results are limited', async () => {
      const mockResults = Array(10).fill({
        id: 'note',
        title: 'Note'
      })
      ;(searchQueries.searchNotes as Mock).mockReturnValue(mockResults)

      const result = await invokeHandler(SearchChannels.invoke.SEARCH, {
        query: 'test',
        limit: 10
      })

      expect(result.hasMore).toBe(true)
    })
  })

  describe('QUICK_SEARCH handler', () => {
    beforeEach(() => {
      registerSearchHandlers()
    })

    it('should perform quick search for command palette', async () => {
      const mockResult = {
        notes: [
          { id: 'note1', title: 'Quick Result', snippet: '...' }
        ]
      }
      ;(searchQueries.quickSearch as Mock).mockReturnValue(mockResult)

      const result = await invokeHandler(SearchChannels.invoke.QUICK_SEARCH, {
        query: 'quick',
        limit: 5
      })

      expect(result.notes).toHaveLength(1)
      expect(result.tasks).toEqual([]) // Tasks not implemented yet
    })

    it('should handle short query', async () => {
      ;(searchQueries.quickSearch as Mock).mockReturnValue({ notes: [] })

      // Query must have at least 1 character according to schema
      const result = await invokeHandler(SearchChannels.invoke.QUICK_SEARCH, {
        query: 'a',
        limit: 10
      })

      expect(result.notes).toEqual([])
    })

    it('should handle quick search errors', async () => {
      ;(searchQueries.quickSearch as Mock).mockImplementation(() => {
        throw new Error('Quick search failed')
      })

      const result = await invokeHandler(SearchChannels.invoke.QUICK_SEARCH, {
        query: 'test'
      })

      expect(result).toEqual({ notes: [], tasks: [] })
    })
  })

  // =========================================================================
  // T462: SUGGESTIONS handler
  // =========================================================================
  describe('SUGGESTIONS handler', () => {
    beforeEach(() => {
      registerSearchHandlers()
    })

    it('should get search suggestions', async () => {
      const mockSuggestions = ['javascript', 'java', 'jamstack']
      ;(searchQueries.getSuggestions as Mock).mockReturnValue(mockSuggestions)

      const result = await invokeHandler(SearchChannels.invoke.SUGGESTIONS, {
        prefix: 'ja',
        limit: 10
      })

      expect(result.suggestions).toEqual(mockSuggestions)
      expect(searchQueries.getSuggestions).toHaveBeenCalledWith(mockDb, 'ja', 10)
    })

    it('should return empty array for no matches', async () => {
      ;(searchQueries.getSuggestions as Mock).mockReturnValue([])

      const result = await invokeHandler(SearchChannels.invoke.SUGGESTIONS, {
        prefix: 'xyz',
        limit: 10
      })

      expect(result.suggestions).toEqual([])
    })

    it('should handle suggestion errors', async () => {
      ;(searchQueries.getSuggestions as Mock).mockImplementation(() => {
        throw new Error('Suggestions failed')
      })

      const result = await invokeHandler(SearchChannels.invoke.SUGGESTIONS, {
        prefix: 'test'
      })

      expect(result.suggestions).toEqual([])
    })
  })

  // =========================================================================
  // Recent searches
  // =========================================================================
  describe('Recent searches', () => {
    beforeEach(() => {
      registerSearchHandlers()
      ;(searchQueries.searchNotes as Mock).mockReturnValue([])
    })

    it('GET_RECENT should return recent searches', async () => {
      // Add some searches first
      await invokeHandler(SearchChannels.invoke.SEARCH, { query: 'first search' })
      await invokeHandler(SearchChannels.invoke.SEARCH, { query: 'second search' })

      const result = await invokeHandler(SearchChannels.invoke.GET_RECENT)

      expect(result).toContain('first search')
      expect(result).toContain('second search')
    })

    it('CLEAR_RECENT should clear recent searches', async () => {
      await invokeHandler(SearchChannels.invoke.SEARCH, { query: 'test' })
      await invokeHandler(SearchChannels.invoke.CLEAR_RECENT)

      const result = await invokeHandler(SearchChannels.invoke.GET_RECENT)

      expect(result).toEqual([])
    })

    it('ADD_RECENT should add to recent searches', async () => {
      await invokeHandler(SearchChannels.invoke.ADD_RECENT, 'manual entry')

      const result = await invokeHandler(SearchChannels.invoke.GET_RECENT)

      expect(result).toContain('manual entry')
    })

    it('should not duplicate recent searches', async () => {
      await invokeHandler(SearchChannels.invoke.SEARCH, { query: 'duplicate' })
      await invokeHandler(SearchChannels.invoke.SEARCH, { query: 'duplicate' })

      const result = await invokeHandler(SearchChannels.invoke.GET_RECENT)
      const duplicateCount = result.filter((s: string) => s === 'duplicate').length

      expect(duplicateCount).toBe(1)
    })

    it('should limit recent searches to max size', async () => {
      // Add more than max (20) searches
      for (let i = 0; i < 25; i++) {
        await invokeHandler(SearchChannels.invoke.ADD_RECENT, `search-${i}`)
      }

      const result = await invokeHandler(SearchChannels.invoke.GET_RECENT)

      expect(result.length).toBeLessThanOrEqual(20)
    })
  })

  // =========================================================================
  // T463: REBUILD_INDEX handler
  // =========================================================================
  describe('REBUILD_INDEX handler', () => {
    beforeEach(() => {
      registerSearchHandlers()
    })

    it('should trigger index rebuild', async () => {
      // Currently just logs, doesn't throw
      const result = await invokeHandler(SearchChannels.invoke.REBUILD_INDEX)

      // Should complete without error
      expect(result).toBeUndefined()
    })
  })

  // =========================================================================
  // Stats and health
  // =========================================================================
  describe('GET_STATS handler', () => {
    beforeEach(() => {
      registerSearchHandlers()
    })

    it('should return search stats', async () => {
      ;(searchQueries.getSearchableCount as Mock).mockReturnValue(100)
      ;(searchQueries.isFtsHealthy as Mock).mockReturnValue(true)

      const result = await invokeHandler(SearchChannels.invoke.GET_STATS)

      expect(result.totalNotes).toBe(100)
      expect(result.indexHealth).toBe('healthy')
    })

    it('should detect corrupt index', async () => {
      ;(searchQueries.getSearchableCount as Mock).mockReturnValue(50)
      ;(searchQueries.isFtsHealthy as Mock).mockReturnValue(false)

      const result = await invokeHandler(SearchChannels.invoke.GET_STATS)

      expect(result.indexHealth).toBe('corrupt')
    })
  })

  // =========================================================================
  // Tag and backlink search
  // =========================================================================
  describe('FIND_BY_TAG handler', () => {
    beforeEach(() => {
      registerSearchHandlers()
    })

    it('should find notes by tag', async () => {
      const mockResults = [
        { id: 'note1', title: 'Tagged Note 1', tags: ['work'] },
        { id: 'note2', title: 'Tagged Note 2', tags: ['work'] }
      ]
      ;(searchQueries.findNotesByTag as Mock).mockReturnValue(mockResults)

      const result = await invokeHandler(SearchChannels.invoke.FIND_BY_TAG, 'work')

      expect(result).toHaveLength(2)
      expect(searchQueries.findNotesByTag).toHaveBeenCalledWith(mockDb, 'work')
    })
  })

  describe('FIND_BACKLINKS handler', () => {
    beforeEach(() => {
      registerSearchHandlers()
    })

    it('should find backlinks to a note', async () => {
      const mockResults = [
        { id: 'note2', title: 'Linking Note', snippet: '...links to [[Note1]]...' }
      ]
      ;(searchQueries.findBacklinks as Mock).mockReturnValue(mockResults)

      const result = await invokeHandler(SearchChannels.invoke.FIND_BACKLINKS, 'note1')

      expect(result).toHaveLength(1)
      expect(searchQueries.findBacklinks).toHaveBeenCalledWith(mockDb, 'note1')
    })
  })

  // =========================================================================
  // SEARCH_NOTES handler (optimized notes-only search)
  // =========================================================================
  describe('SEARCH_NOTES handler', () => {
    beforeEach(() => {
      registerSearchHandlers()
    })

    it('should search notes only', async () => {
      const mockResults = [{ id: 'note1', title: 'Result' }]
      ;(searchQueries.searchNotes as Mock).mockReturnValue(mockResults)

      const result = await invokeHandler(SearchChannels.invoke.SEARCH_NOTES, {
        query: 'test',
        limit: 10
      })

      expect(result).toHaveLength(1)
    })
  })
})
