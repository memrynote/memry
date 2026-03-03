/**
 * useBookmarks Hook Tests (T505-T506)
 * Tests for bookmark hooks: list, toggle, and isBookmarked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useBookmarks, useIsBookmarked } from './use-bookmarks'
import {
  createTestQueryClient,
  createMockBookmark,
  setupHookTestEnvironment,
  cleanupHookTestEnvironment
} from '@tests/utils/hook-test-wrapper'

// ============================================================================
// Test Setup
// ============================================================================

describe('useBookmarks', () => {
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

  // ==========================================================================
  // T505: List Bookmarks
  // ==========================================================================

  describe('list bookmarks', () => {
    it('should load bookmarks on mount when autoLoad is true', async () => {
      const mockBookmarks = [
        createMockBookmark({ id: 'bm-1', itemTitle: 'Note 1' }),
        createMockBookmark({ id: 'bm-2', itemTitle: 'Note 2' })
      ]

      ;(window.api.bookmarks.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        bookmarks: mockBookmarks,
        total: 2,
        hasMore: false
      })

      const { result } = renderHook(() => useBookmarks({ autoLoad: true }), { wrapper })

      expect(result.current.isLoading).toBe(true)

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.bookmarks).toHaveLength(2)
      expect(result.current.total).toBe(2)
      expect(window.api.bookmarks.list).toHaveBeenCalled()
    })

    it('should not load bookmarks on mount when autoLoad is false', async () => {
      const { result } = renderHook(() => useBookmarks({ autoLoad: false }), { wrapper })

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(result.current.bookmarks).toHaveLength(0)
      expect(window.api.bookmarks.list).not.toHaveBeenCalled()
    })

    it('should load bookmarks filtered by item type', async () => {
      ;(window.api.bookmarks.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        bookmarks: [createMockBookmark({ id: 'bm-1', itemType: 'note' })],
        total: 1,
        hasMore: false
      })

      const { result } = renderHook(() => useBookmarks({ itemType: 'note' }), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(window.api.bookmarks.list).toHaveBeenCalledWith(
        expect.objectContaining({
          itemType: 'note'
        })
      )
    })

    it('should handle loading errors gracefully', async () => {
      ;(window.api.bookmarks.list as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Failed to load bookmarks')
      )

      const { result } = renderHook(() => useBookmarks(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.error).toBe('Failed to load bookmarks')
      expect(result.current.bookmarks).toHaveLength(0)
    })

    it('should load more bookmarks when loadMore is called', async () => {
      const initialBookmarks = [createMockBookmark({ id: 'bm-1' })]
      const moreBookmarks = [createMockBookmark({ id: 'bm-2' })]

      ;(window.api.bookmarks.list as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ bookmarks: initialBookmarks, total: 2, hasMore: true })
        .mockResolvedValueOnce({ bookmarks: moreBookmarks, total: 2, hasMore: false })

      const { result } = renderHook(() => useBookmarks({ limit: 1 }), { wrapper })

      await waitFor(() => {
        expect(result.current.hasMore).toBe(true)
      })

      await act(async () => {
        await result.current.loadMore()
      })

      expect(result.current.bookmarks).toHaveLength(2)
      expect(result.current.hasMore).toBe(false)
    })
  })

  // ==========================================================================
  // T506: Toggle Bookmark
  // ==========================================================================

  describe('toggle bookmark', () => {
    it('should toggle bookmark on (create)', async () => {
      const newBookmark = createMockBookmark({ id: 'bm-new', itemId: 'note-1' })

      ;(window.api.bookmarks.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        bookmarks: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.bookmarks.toggle as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        isBookmarked: true,
        bookmark: newBookmark
      })

      const { result } = renderHook(() => useBookmarks(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const toggleResult = await act(async () => {
        return await result.current.toggleBookmark('note', 'note-1')
      })

      expect(toggleResult.success).toBe(true)
      expect(toggleResult.isBookmarked).toBe(true)
      expect(window.api.bookmarks.toggle).toHaveBeenCalledWith({
        itemType: 'note',
        itemId: 'note-1'
      })
    })

    it('should toggle bookmark off (remove)', async () => {
      const existingBookmark = createMockBookmark({
        id: 'bm-1',
        itemId: 'note-1',
        itemType: 'note'
      })

      ;(window.api.bookmarks.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        bookmarks: [existingBookmark],
        total: 1,
        hasMore: false
      })
      ;(window.api.bookmarks.toggle as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        isBookmarked: false,
        bookmark: null
      })

      const { result } = renderHook(() => useBookmarks(), { wrapper })

      await waitFor(() => {
        expect(result.current.bookmarks).toHaveLength(1)
      })

      await act(async () => {
        await result.current.toggleBookmark('note', 'note-1')
      })

      // Should optimistically remove from list
      expect(result.current.bookmarks).toHaveLength(0)
    })

    it('should handle toggle errors', async () => {
      ;(window.api.bookmarks.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        bookmarks: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.bookmarks.toggle as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        isBookmarked: false,
        bookmark: null,
        error: 'Toggle failed'
      })

      const { result } = renderHook(() => useBookmarks(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const toggleResult = await act(async () => {
        return await result.current.toggleBookmark('note', 'note-1')
      })

      expect(toggleResult.success).toBe(false)
      expect(result.current.error).toBe('Toggle failed')
    })
  })

  // ==========================================================================
  // Remove Bookmark
  // ==========================================================================

  describe('remove bookmark', () => {
    it('should remove a bookmark by ID', async () => {
      const bookmark = createMockBookmark({ id: 'bm-1' })

      ;(window.api.bookmarks.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        bookmarks: [bookmark],
        total: 1,
        hasMore: false
      })
      ;(window.api.bookmarks.delete as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true
      })

      const { result } = renderHook(() => useBookmarks(), { wrapper })

      await waitFor(() => {
        expect(result.current.bookmarks).toHaveLength(1)
      })

      const success = await act(async () => {
        return await result.current.removeBookmark('bm-1')
      })

      expect(success).toBe(true)
      expect(result.current.bookmarks).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Reorder Bookmarks
  // ==========================================================================

  describe('reorder bookmarks', () => {
    it('should reorder bookmarks', async () => {
      const bookmarks = [
        createMockBookmark({ id: 'bm-1', position: 0 }),
        createMockBookmark({ id: 'bm-2', position: 1 })
      ]

      ;(window.api.bookmarks.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        bookmarks,
        total: 2,
        hasMore: false
      })
      ;(window.api.bookmarks.reorder as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true
      })

      const { result } = renderHook(() => useBookmarks(), { wrapper })

      await waitFor(() => {
        expect(result.current.bookmarks).toHaveLength(2)
      })

      const success = await act(async () => {
        return await result.current.reorderBookmarks(['bm-2', 'bm-1'])
      })

      expect(success).toBe(true)
      expect(window.api.bookmarks.reorder).toHaveBeenCalledWith(['bm-2', 'bm-1'])
    })
  })

  // ==========================================================================
  // Utility Functions
  // ==========================================================================

  describe('utility functions', () => {
    it('should check if an item is bookmarked', async () => {
      ;(window.api.bookmarks.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        bookmarks: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.bookmarks.isBookmarked as ReturnType<typeof vi.fn>).mockResolvedValue(true)

      const { result } = renderHook(() => useBookmarks(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const isBookmarked = await act(async () => {
        return await result.current.isBookmarked('note', 'note-1')
      })

      expect(isBookmarked).toBe(true)
      expect(window.api.bookmarks.isBookmarked).toHaveBeenCalledWith({
        itemType: 'note',
        itemId: 'note-1'
      })
    })

    it('should clear error state', async () => {
      ;(window.api.bookmarks.list as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Test error')
      )

      const { result } = renderHook(() => useBookmarks(), { wrapper })

      await waitFor(() => {
        expect(result.current.error).toBe('Test error')
      })

      act(() => {
        result.current.clearError()
      })

      expect(result.current.error).toBeNull()
    })

    it('should refresh bookmarks', async () => {
      ;(window.api.bookmarks.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        bookmarks: [],
        total: 0,
        hasMore: false
      })

      const { result } = renderHook(() => useBookmarks(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(window.api.bookmarks.list).toHaveBeenCalledTimes(1)

      await act(async () => {
        await result.current.refresh()
      })

      expect(window.api.bookmarks.list).toHaveBeenCalledTimes(2)
    })
  })
})

// ============================================================================
// useIsBookmarked Tests
// ============================================================================

describe('useIsBookmarked', () => {
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

  it('should check bookmark status on mount', async () => {
    ;(window.api.bookmarks.isBookmarked as ReturnType<typeof vi.fn>).mockResolvedValue(true)

    const { result } = renderHook(() => useIsBookmarked('note', 'note-1'), { wrapper })

    expect(result.current.isLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.isBookmarked).toBe(true)
  })

  it('should handle missing itemType or itemId', async () => {
    const { result } = renderHook(() => useIsBookmarked('', ''), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.isBookmarked).toBe(false)
    expect(window.api.bookmarks.isBookmarked).not.toHaveBeenCalled()
  })

  it('should toggle bookmark and update state', async () => {
    ;(window.api.bookmarks.isBookmarked as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    ;(window.api.bookmarks.toggle as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      isBookmarked: true,
      bookmark: createMockBookmark({ id: 'new-bm' })
    })

    const { result } = renderHook(() => useIsBookmarked('note', 'note-1'), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.isBookmarked).toBe(false)

    const newState = await act(async () => {
      return await result.current.toggle()
    })

    expect(newState).toBe(true)
    expect(result.current.isBookmarked).toBe(true)
  })

  it('should refresh bookmark status', async () => {
    ;(window.api.bookmarks.isBookmarked as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const { result } = renderHook(() => useIsBookmarked('note', 'note-1'), { wrapper })

    await waitFor(() => {
      expect(result.current.isBookmarked).toBe(false)
    })

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.isBookmarked).toBe(true)
  })
})
