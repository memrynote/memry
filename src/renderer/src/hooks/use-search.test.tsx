/**
 * useSearch Hook Tests (T500-T501)
 *
 * Tests for search hooks: useSearch, useQuickSearch, useSuggestions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import {
  useSearch,
  useQuickSearch,
  useSearchStats,
  useRecentSearches
} from './use-search'
import {
  createTestQueryClient,
  setupHookTestEnvironment,
  cleanupHookTestEnvironment
} from '@tests/utils/hook-test-wrapper'

// ============================================================================
// Test Setup
// ============================================================================

describe('useSearch', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  // ==========================================================================
  // T500: useSearch - basic search functionality
  // ==========================================================================

  describe('T500: basic search functionality', () => {
    it('should initialize with empty state', () => {
      const { result } = renderHook(() => useSearch(), { wrapper })

      expect(result.current.query).toBe('')
      expect(result.current.results).toEqual([])
      expect(result.current.total).toBe(0)
      expect(result.current.hasMore).toBe(false)
      expect(result.current.isLoading).toBe(false)
      expect(result.current.queryTime).toBeNull()
      expect(result.current.error).toBeNull()
    })

    it('should search when query is set (debounced)', async () => {
      const mockResults = [
        { id: 'note-1', title: 'Test Note', content: 'Content', path: 'notes/test.md' }
      ]

      ;(window.api.search.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: mockResults,
        total: 1,
        hasMore: false,
        queryTime: 15
      })

      const { result } = renderHook(() => useSearch({ debounceMs: 100 }), { wrapper })

      act(() => {
        result.current.setQuery('test')
      })

      expect(result.current.query).toBe('test')

      // Advance timers past the debounce delay
      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.results).toEqual(mockResults)
      expect(result.current.total).toBe(1)
      expect(result.current.queryTime).toBe(15)
      expect(window.api.search.query).toHaveBeenCalledWith({
        query: 'test',
        limit: 50,
        offset: 0
      })
    })

    it('should not search for empty query', async () => {
      const { result } = renderHook(() => useSearch({ debounceMs: 0 }), { wrapper })

      act(() => {
        result.current.setQuery('')
      })

      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      expect(window.api.search.query).not.toHaveBeenCalled()
      expect(result.current.results).toEqual([])
    })

    it('should not search for whitespace-only query', async () => {
      const { result } = renderHook(() => useSearch({ debounceMs: 0 }), { wrapper })

      act(() => {
        result.current.setQuery('   ')
      })

      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      expect(window.api.search.query).not.toHaveBeenCalled()
    })

    it('should support manual search', async () => {
      const mockResults = [{ id: 'note-1', title: 'Manual Search' }]

      ;(window.api.search.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: mockResults,
        total: 1,
        hasMore: false,
        queryTime: 10
      })

      const { result } = renderHook(() => useSearch({ autoSearch: false }), { wrapper })

      await act(async () => {
        await result.current.search('manual search')
      })

      expect(result.current.results).toEqual(mockResults)
      expect(window.api.search.query).toHaveBeenCalledWith({
        query: 'manual search',
        limit: 50,
        offset: 0
      })
    })

    it('should handle search errors', async () => {
      ;(window.api.search.query as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Search index unavailable')
      )

      const { result } = renderHook(() => useSearch({ debounceMs: 0 }), { wrapper })

      act(() => {
        result.current.setQuery('test')
      })

      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.error).toBe('Search index unavailable')
      expect(result.current.results).toEqual([])
    })
  })

  // ==========================================================================
  // T500: useSearch - pagination (loadMore)
  // ==========================================================================

  describe('T500: pagination', () => {
    it('should load more results when hasMore is true', async () => {
      const firstPage = [{ id: 'note-1', title: 'First' }]
      const secondPage = [{ id: 'note-2', title: 'Second' }]

      ;(window.api.search.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ results: firstPage, total: 2, hasMore: true, queryTime: 10 })
        .mockResolvedValueOnce({ results: secondPage, total: 2, hasMore: false, queryTime: 8 })

      const { result } = renderHook(() => useSearch({ debounceMs: 0, limit: 1 }), { wrapper })

      act(() => {
        result.current.setQuery('test')
      })

      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      await waitFor(() => {
        expect(result.current.results).toHaveLength(1)
      })

      expect(result.current.hasMore).toBe(true)

      await act(async () => {
        await result.current.loadMore()
      })

      expect(result.current.results).toHaveLength(2)
      expect(result.current.hasMore).toBe(false)
    })

    it('should not load more when hasMore is false', async () => {
      ;(window.api.search.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: [{ id: 'note-1' }],
        total: 1,
        hasMore: false,
        queryTime: 5
      })

      const { result } = renderHook(() => useSearch({ debounceMs: 0 }), { wrapper })

      act(() => {
        result.current.setQuery('test')
      })

      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      await waitFor(() => {
        expect(result.current.results).toHaveLength(1)
      })

      const callCount = (window.api.search.query as ReturnType<typeof vi.fn>).mock.calls.length

      await act(async () => {
        await result.current.loadMore()
      })

      expect(window.api.search.query).toHaveBeenCalledTimes(callCount)
    })

    it('should not load more while already loading', async () => {
      // Create a promise that we control
      let resolveSearch: (value: unknown) => void
      const searchPromise = new Promise((resolve) => {
        resolveSearch = resolve
      })

      ;(window.api.search.query as ReturnType<typeof vi.fn>).mockReturnValue(searchPromise)

      const { result } = renderHook(() => useSearch({ debounceMs: 0 }), { wrapper })

      act(() => {
        result.current.setQuery('test')
      })

      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      expect(result.current.isLoading).toBe(true)

      await act(async () => {
        await result.current.loadMore()
      })

      // Should only have one call because loadMore was blocked by isLoading
      expect(window.api.search.query).toHaveBeenCalledTimes(1)

      // Resolve the promise to clean up
      await act(async () => {
        resolveSearch!({ results: [], total: 0, hasMore: false, queryTime: 0 })
      })
    })
  })

  // ==========================================================================
  // T500: useSearch - clear functionality
  // ==========================================================================

  describe('T500: clear functionality', () => {
    it('should clear all search state', async () => {
      ;(window.api.search.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: [{ id: 'note-1' }],
        total: 1,
        hasMore: false,
        queryTime: 10
      })

      const { result } = renderHook(() => useSearch({ debounceMs: 0 }), { wrapper })

      act(() => {
        result.current.setQuery('test')
      })

      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      await waitFor(() => {
        expect(result.current.results).toHaveLength(1)
      })

      act(() => {
        result.current.clear()
      })

      expect(result.current.query).toBe('')
      expect(result.current.results).toEqual([])
      expect(result.current.total).toBe(0)
      expect(result.current.queryTime).toBeNull()
    })
  })
})

// ============================================================================
// T501: useQuickSearch Tests
// ============================================================================

describe('useQuickSearch', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  describe('T501: quick search for command palette', () => {
    it('should initialize with empty state', () => {
      const { result } = renderHook(() => useQuickSearch(), { wrapper })

      expect(result.current.query).toBe('')
      expect(result.current.notes).toEqual([])
      expect(result.current.isLoading).toBe(false)
    })

    it('should perform quick search with minimal delay', async () => {
      const mockNotes = [
        { id: 'note-1', title: 'Quick Result', path: 'notes/quick.md' }
      ]

      ;(window.api.search.quick as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: mockNotes
      })

      const { result } = renderHook(() => useQuickSearch(50), { wrapper })

      act(() => {
        result.current.setQuery('quick')
      })

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.notes).toEqual(mockNotes)
      expect(window.api.search.quick).toHaveBeenCalledWith({
        query: 'quick',
        limit: 5
      })
    })

    it('should return empty results for empty query', async () => {
      const { result } = renderHook(() => useQuickSearch(), { wrapper })

      act(() => {
        result.current.setQuery('')
      })

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      expect(window.api.search.quick).not.toHaveBeenCalled()
      expect(result.current.notes).toEqual([])
    })

    it('should clear quick search state', async () => {
      ;(window.api.search.quick as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [{ id: 'note-1', title: 'Test' }]
      })

      const { result } = renderHook(() => useQuickSearch(0), { wrapper })

      act(() => {
        result.current.setQuery('test')
      })

      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      await waitFor(() => {
        expect(result.current.notes).toHaveLength(1)
      })

      act(() => {
        result.current.clear()
      })

      expect(result.current.query).toBe('')
      expect(result.current.notes).toEqual([])
    })

    it('should handle quick search errors silently', async () => {
      ;(window.api.search.quick as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Search failed')
      )

      const { result } = renderHook(() => useQuickSearch(0), { wrapper })

      act(() => {
        result.current.setQuery('error')
      })

      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      // Quick search handles errors silently by returning empty results
      expect(result.current.notes).toEqual([])
    })
  })
})

// ============================================================================
// useSearchStats Tests
// ============================================================================

describe('useSearchStats', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('should load stats on mount', async () => {
    const mockStats = { indexed: 100, pending: 5 }

    ;(window.api.search.getStats as ReturnType<typeof vi.fn>).mockResolvedValue(mockStats)

    const { result } = renderHook(() => useSearchStats(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.stats).toEqual(mockStats)
  })

  it('should rebuild search index', async () => {
    ;(window.api.search.getStats as ReturnType<typeof vi.fn>).mockResolvedValue({ indexed: 0, pending: 0 })
    ;(window.api.search.rebuildIndex as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

    const { result } = renderHook(() => useSearchStats(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    await act(async () => {
      await result.current.rebuildIndex()
    })

    expect(window.api.search.rebuildIndex).toHaveBeenCalled()
    expect(result.current.rebuildProgress).toBe(0)
  })

  it('should refresh stats', async () => {
    ;(window.api.search.getStats as ReturnType<typeof vi.fn>).mockResolvedValue({ indexed: 50, pending: 0 })

    const { result } = renderHook(() => useSearchStats(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(window.api.search.getStats).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.refresh()
    })

    expect(window.api.search.getStats).toHaveBeenCalledTimes(2)
  })
})

// ============================================================================
// useRecentSearches Tests
// ============================================================================

describe('useRecentSearches', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('should load recent searches on mount', async () => {
    const mockRecent = ['react', 'typescript', 'testing']

    ;(window.api.search.getRecent as ReturnType<typeof vi.fn>).mockResolvedValue(mockRecent)

    const { result } = renderHook(() => useRecentSearches(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.recent).toEqual(mockRecent)
  })

  it('should add a recent search', async () => {
    ;(window.api.search.getRecent as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(window.api.search.addRecent as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

    const { result } = renderHook(() => useRecentSearches(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    await act(async () => {
      await result.current.addRecent('new search')
    })

    expect(window.api.search.addRecent).toHaveBeenCalledWith('new search')
    expect(result.current.recent).toContain('new search')
  })

  it('should not duplicate recent searches', async () => {
    ;(window.api.search.getRecent as ReturnType<typeof vi.fn>).mockResolvedValue(['existing'])
    ;(window.api.search.addRecent as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

    const { result } = renderHook(() => useRecentSearches(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    await act(async () => {
      await result.current.addRecent('existing')
    })

    // Should move to front but not duplicate
    expect(result.current.recent.filter((r) => r === 'existing')).toHaveLength(1)
  })

  it('should clear recent searches', async () => {
    ;(window.api.search.getRecent as ReturnType<typeof vi.fn>).mockResolvedValue(['one', 'two'])
    ;(window.api.search.clearRecent as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

    const { result } = renderHook(() => useRecentSearches(), { wrapper })

    await waitFor(() => {
      expect(result.current.recent).toHaveLength(2)
    })

    await act(async () => {
      await result.current.clearRecent()
    })

    expect(window.api.search.clearRecent).toHaveBeenCalled()
    expect(result.current.recent).toEqual([])
  })

  it('should refresh recent searches', async () => {
    ;(window.api.search.getRecent as ReturnType<typeof vi.fn>).mockResolvedValue(['old'])

    const { result } = renderHook(() => useRecentSearches(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(window.api.search.getRecent).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.refresh()
    })

    expect(window.api.search.getRecent).toHaveBeenCalledTimes(2)
  })
})
