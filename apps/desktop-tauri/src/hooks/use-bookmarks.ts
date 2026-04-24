/**
 * useBookmarks Hook
 * Manages bookmarks data with real IPC calls to the main process.
 *
 * @example
 * ```tsx
 * function BookmarksList() {
 *   const { bookmarks, isLoading, toggleBookmark } = useBookmarks()
 *
 *   if (isLoading) return <div>Loading...</div>
 *
 *   return (
 *     <ul>
 *       {bookmarks.map(bookmark => (
 *         <li key={bookmark.id}>{bookmark.itemTitle}</li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'
import type {
  BookmarkWithItem,
  BookmarkListResponse,
  BookmarkToggleResponse
} from '@memry/contracts/bookmarks-api'

interface BookmarkCreatedEvent {
  bookmark?: { itemType: string; itemId: string }
}

interface BookmarkDeletedEvent {
  id: string
  itemType?: string
  itemId?: string
}

// ============================================================================
// Bookmarks Service
// ============================================================================

const bookmarksService = {
  list: async (options?: {
    itemType?: string
    sortBy?: 'position' | 'createdAt'
    sortOrder?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }): Promise<BookmarkListResponse> => {
    return invoke<BookmarkListResponse>('bookmarks_list', options)
  },

  listByType: async (itemType: string): Promise<BookmarkListResponse> => {
    return invoke<BookmarkListResponse>('bookmarks_list_by_type', { args: [itemType] })
  },

  toggle: async (input: { itemType: string; itemId: string }): Promise<BookmarkToggleResponse> => {
    return invoke<BookmarkToggleResponse>('bookmarks_toggle', input)
  },

  isBookmarked: async (input: { itemType: string; itemId: string }): Promise<boolean> => {
    return invoke<boolean>('bookmarks_is_bookmarked', input)
  },

  delete: async (id: string): Promise<{ success: boolean; error?: string }> => {
    return invoke<{ success: boolean; error?: string }>('bookmarks_delete', { args: [id] })
  },

  reorder: async (bookmarkIds: string[]): Promise<{ success: boolean; error?: string }> => {
    return invoke<{ success: boolean; error?: string }>('bookmarks_reorder', {
      args: [bookmarkIds]
    })
  }
}

// ============================================================================
// Hook
// ============================================================================

export interface UseBookmarksOptions {
  /** Filter by item type (e.g., 'note', 'task', 'journal') */
  itemType?: string
  /** Sort field */
  sortBy?: 'position' | 'createdAt'
  /** Sort direction */
  sortOrder?: 'asc' | 'desc'
  /** Page size */
  limit?: number
  /** Auto-load on mount */
  autoLoad?: boolean
}

export interface UseBookmarksReturn {
  // State
  bookmarks: BookmarkWithItem[]
  total: number
  hasMore: boolean
  isLoading: boolean
  error: string | null

  // Actions
  loadBookmarks: (options?: {
    itemType?: string
    sortBy?: 'position' | 'createdAt'
    sortOrder?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }) => Promise<BookmarkListResponse>
  loadMore: () => Promise<void>
  refresh: () => Promise<void>
  toggleBookmark: (itemType: string, itemId: string) => Promise<BookmarkToggleResponse>
  removeBookmark: (id: string) => Promise<boolean>
  isBookmarked: (itemType: string, itemId: string) => Promise<boolean>
  reorderBookmarks: (bookmarkIds: string[]) => Promise<boolean>
  clearError: () => void
}

/**
 * Hook for bookmarks state management.
 * Provides bookmarks list, loading states, and CRUD actions.
 */
export function useBookmarks(options: UseBookmarksOptions = {}): UseBookmarksReturn {
  const {
    itemType: initialItemType,
    sortBy: initialSortBy = 'position',
    sortOrder: initialSortOrder = 'asc',
    limit: initialLimit = 100,
    autoLoad = true
  } = options

  // State
  const [bookmarks, setBookmarks] = useState<BookmarkWithItem[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track current filter options for loadMore
  const currentOptionsRef = useRef({
    itemType: initialItemType,
    sortBy: initialSortBy,
    sortOrder: initialSortOrder,
    limit: initialLimit,
    offset: 0
  })

  /**
   * Load bookmarks with optional filters.
   */
  const loadBookmarks = useCallback(
    async (loadOptions?: {
      itemType?: string
      sortBy?: 'position' | 'createdAt'
      sortOrder?: 'asc' | 'desc'
      limit?: number
      offset?: number
    }): Promise<BookmarkListResponse> => {
      setIsLoading(true)
      setError(null)

      const opts = {
        itemType: loadOptions?.itemType ?? initialItemType,
        sortBy: loadOptions?.sortBy ?? initialSortBy,
        sortOrder: loadOptions?.sortOrder ?? initialSortOrder,
        limit: loadOptions?.limit ?? initialLimit,
        offset: loadOptions?.offset ?? 0
      }

      // Store for loadMore
      currentOptionsRef.current = opts

      try {
        const result = await bookmarksService.list(opts)
        setBookmarks(result.bookmarks)
        setTotal(result.total)
        setHasMore(result.hasMore)
        return result
      } catch (err) {
        const message = extractErrorMessage(err, 'Failed to load bookmarks')
        setError(message)
        return { bookmarks: [], total: 0, hasMore: false }
      } finally {
        setIsLoading(false)
      }
    },
    [initialItemType, initialSortBy, initialSortOrder, initialLimit]
  )

  /**
   * Load more bookmarks (pagination).
   */
  const loadMore = useCallback(async (): Promise<void> => {
    if (!hasMore || isLoading) return

    setIsLoading(true)
    setError(null)

    const opts = {
      ...currentOptionsRef.current,
      offset: bookmarks.length
    }

    try {
      const result = await bookmarksService.list(opts)
      setBookmarks((prev) => [...prev, ...result.bookmarks])
      setTotal(result.total)
      setHasMore(result.hasMore)
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to load more bookmarks')
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [hasMore, isLoading, bookmarks.length])

  /**
   * Refresh the current bookmarks list.
   */
  const refresh = useCallback(async (): Promise<void> => {
    await loadBookmarks(currentOptionsRef.current)
  }, [loadBookmarks])

  /**
   * Toggle bookmark status for an item.
   */
  const toggleBookmark = useCallback(
    async (itemType: string, itemId: string): Promise<BookmarkToggleResponse> => {
      setError(null)

      try {
        const result = await bookmarksService.toggle({ itemType, itemId })

        if (!result.success) {
          setError(extractErrorMessage(result.error, 'Failed to toggle bookmark'))
          return result
        }

        // Optimistic update: add or remove from list
        if (result.isBookmarked && result.bookmark) {
          // Bookmark was created - will be added via event listener
        } else {
          // Bookmark was removed - remove from local state immediately
          setBookmarks((prev) => prev.filter((b) => b.itemId !== itemId || b.itemType !== itemType))
          setTotal((prev) => Math.max(0, prev - 1))
        }

        return result
      } catch (err) {
        const message = extractErrorMessage(err, 'Failed to toggle bookmark')
        setError(message)
        return { success: false, isBookmarked: false, bookmark: null, error: message }
      }
    },
    []
  )

  /**
   * Remove a bookmark by ID.
   */
  const removeBookmark = useCallback(async (id: string): Promise<boolean> => {
    setError(null)

    try {
      const result = await bookmarksService.delete(id)

      if (!result.success) {
        setError(extractErrorMessage(result.error, 'Failed to remove bookmark'))
        return false
      }

      // Remove from local state
      setBookmarks((prev) => prev.filter((b) => b.id !== id))
      setTotal((prev) => Math.max(0, prev - 1))

      return true
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to remove bookmark')
      setError(message)
      return false
    }
  }, [])

  /**
   * Check if an item is bookmarked.
   */
  const isBookmarkedCheck = useCallback(
    async (itemType: string, itemId: string): Promise<boolean> => {
      try {
        return await bookmarksService.isBookmarked({ itemType, itemId })
      } catch {
        return false
      }
    },
    []
  )

  /**
   * Reorder bookmarks.
   */
  const reorderBookmarks = useCallback(async (bookmarkIds: string[]): Promise<boolean> => {
    setError(null)

    try {
      const result = await bookmarksService.reorder(bookmarkIds)

      if (!result.success) {
        setError(extractErrorMessage(result.error, 'Failed to reorder bookmarks'))
        return false
      }

      // Reorder local state to match
      setBookmarks((prev) => {
        const bookmarkMap = new Map(prev.map((b) => [b.id, b]))
        return bookmarkIds.map((id) => bookmarkMap.get(id)).filter(Boolean) as BookmarkWithItem[]
      })

      return true
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to reorder bookmarks')
      setError(message)
      return false
    }
  }, [])

  /**
   * Clear error state.
   */
  const clearError = useCallback(() => {
    setError(null)
  }, [])

  // Load initial bookmarks
  useEffect(() => {
    if (autoLoad) {
      loadBookmarks()
    }
  }, [autoLoad, loadBookmarks])

  // Subscribe to bookmark events
  useEffect(() => {
    const unsubCreated = subscribeEvent<BookmarkCreatedEvent>('bookmark-created', () => {
      // Refresh to get the full bookmark with resolved item
      refresh()
    })

    const unsubDeleted = subscribeEvent<BookmarkDeletedEvent>('bookmark-deleted', (event) => {
      setBookmarks((prev) => prev.filter((b) => b.id !== event.id))
      setTotal((prev) => Math.max(0, prev - 1))
    })

    const unsubReordered = subscribeEvent<void>('bookmarks-reordered', () => {
      // Refresh to get new order
      refresh()
    })

    return () => {
      unsubCreated()
      unsubDeleted()
      unsubReordered()
    }
  }, [refresh])

  return {
    // State
    bookmarks,
    total,
    hasMore,
    isLoading,
    error,

    // Actions
    loadBookmarks,
    loadMore,
    refresh,
    toggleBookmark,
    removeBookmark,
    isBookmarked: isBookmarkedCheck,
    reorderBookmarks,
    clearError
  }
}

/**
 * Hook for checking if a specific item is bookmarked.
 * Useful for bookmark toggle buttons on individual items.
 */
export function useIsBookmarked(itemType: string, itemId: string) {
  const [isBookmarked, setIsBookmarked] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const checkBookmark = useCallback(async () => {
    if (!itemType || !itemId) {
      setIsBookmarked(false)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    try {
      const result = await invoke<boolean>('bookmarks_is_bookmarked', { itemType, itemId })
      setIsBookmarked(result)
    } catch {
      setIsBookmarked(false)
    } finally {
      setIsLoading(false)
    }
  }, [itemType, itemId])

  const toggle = useCallback(async (): Promise<boolean> => {
    try {
      const result = await invoke<BookmarkToggleResponse>('bookmarks_toggle', {
        itemType,
        itemId
      })
      setIsBookmarked(result.isBookmarked)
      return result.isBookmarked
    } catch {
      return isBookmarked
    }
  }, [itemType, itemId, isBookmarked])

  useEffect(() => {
    checkBookmark()

    // Subscribe to bookmark events
    const unsubCreated = subscribeEvent<BookmarkCreatedEvent>('bookmark-created', (event) => {
      if (event.bookmark?.itemType === itemType && event.bookmark?.itemId === itemId) {
        setIsBookmarked(true)
      }
    })

    const unsubDeleted = subscribeEvent<BookmarkDeletedEvent>('bookmark-deleted', (event) => {
      if (event.itemType === itemType && event.itemId === itemId) {
        setIsBookmarked(false)
      }
    })

    return () => {
      unsubCreated()
      unsubDeleted()
    }
  }, [checkBookmark, itemType, itemId])

  return {
    isBookmarked,
    isLoading,
    toggle,
    refresh: checkBookmark
  }
}

// Re-export types for convenience
export type { BookmarkWithItem, BookmarkListResponse }
