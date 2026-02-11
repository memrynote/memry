/**
 * useSearch Hook
 * Manages search state with debounced queries to the main process.
 *
 * @example
 * ```tsx
 * function SearchPanel() {
 *   const { query, setQuery, results, isLoading, queryTime } = useSearch()
 *
 *   return (
 *     <div>
 *       <input
 *         value={query}
 *         onChange={(e) => setQuery(e.target.value)}
 *         placeholder="Search notes..."
 *       />
 *       {isLoading && <span>Searching...</span>}
 *       {queryTime && <span>{queryTime}ms</span>}
 *       <ul>
 *         {results.map(result => (
 *           <li key={result.id}>{result.title}</li>
 *         ))}
 *       </ul>
 *     </div>
 *   )
 * }
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { SearchResult, SearchResultNote, SearchStats } from '../../../preload/index.d'
import {
  searchService,
  onSearchIndexRebuildProgress,
  onSearchIndexRebuildCompleted
} from '../services/search-service'

// ============================================================================
// Debounce Hook
// ============================================================================

/**
 * Returns a debounced value that updates after the specified delay.
 */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(timer)
    }
  }, [value, delay])

  return debouncedValue
}

// ============================================================================
// Main Search Hook
// ============================================================================

export interface UseSearchOptions {
  /** Debounce delay in milliseconds (default: 100) */
  debounceMs?: number
  /** Auto-search when query changes (default: true) */
  autoSearch?: boolean
  /** Default result limit (default: 50) */
  limit?: number
}

export interface UseSearchReturn {
  // State
  query: string
  results: SearchResult[]
  total: number
  hasMore: boolean
  isLoading: boolean
  queryTime: number | null
  error: string | null

  // Actions
  setQuery: (query: string) => void
  search: (query: string) => Promise<void>
  loadMore: () => Promise<void>
  clear: () => void
}

/**
 * Hook for full-text search with debouncing.
 * Automatically searches as user types with configurable debounce.
 */
export function useSearch(options: UseSearchOptions = {}): UseSearchReturn {
  const { debounceMs = 100, autoSearch = true, limit = 50 } = options

  // State
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [queryTime, setQueryTime] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Track current offset for pagination
  const offsetRef = useRef(0)

  // Debounced query for auto-search
  const debouncedQuery = useDebouncedValue(query, debounceMs)

  // Search function
  const search = useCallback(
    async (searchQuery: string) => {
      if (!searchQuery.trim()) {
        setResults([])
        setTotal(0)
        setHasMore(false)
        setQueryTime(null)
        setError(null)
        return
      }

      setIsLoading(true)
      setError(null)
      offsetRef.current = 0

      try {
        const response = await searchService.query({
          query: searchQuery,
          limit,
          offset: 0
        })

        setResults(response.results)
        setTotal(response.total)
        setHasMore(response.hasMore)
        setQueryTime(response.queryTime)
      } catch (err) {
        const message = extractErrorMessage(err, 'Search failed')
        setError(message)
        setResults([])
        setTotal(0)
        setHasMore(false)
      } finally {
        setIsLoading(false)
      }
    },
    [limit]
  )

  // Load more results
  const loadMore = useCallback(async () => {
    if (!query.trim() || isLoading || !hasMore) return

    setIsLoading(true)
    offsetRef.current += limit

    try {
      const response = await searchService.query({
        query,
        limit,
        offset: offsetRef.current
      })

      setResults((prev) => [...prev, ...response.results])
      setHasMore(response.hasMore)
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to load more')
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [query, limit, isLoading, hasMore])

  // Clear search
  const clear = useCallback(() => {
    setQuery('')
    setResults([])
    setTotal(0)
    setHasMore(false)
    setQueryTime(null)
    setError(null)
    offsetRef.current = 0
  }, [])

  // Auto-search when debounced query changes
  // Use a ref to avoid including search in dependencies
  const searchRef = useRef(search)
  searchRef.current = search

  useEffect(() => {
    if (autoSearch) {
      searchRef.current(debouncedQuery)
    }
  }, [debouncedQuery, autoSearch])

  return {
    query,
    results,
    total,
    hasMore,
    isLoading,
    queryTime,
    error,
    setQuery,
    search,
    loadMore,
    clear
  }
}

// ============================================================================
// Quick Search Hook
// ============================================================================

export interface UseQuickSearchReturn {
  query: string
  notes: SearchResultNote[]
  isLoading: boolean
  setQuery: (query: string) => void
  clear: () => void
}

/**
 * Hook for quick search (command palette / omnibar).
 * Optimized for fast results with minimal processing.
 */
export function useQuickSearch(debounceMs: number = 50): UseQuickSearchReturn {
  const [query, setQuery] = useState('')
  const [searchNotes, setSearchNotes] = useState<SearchResultNote[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const debouncedQuery = useDebouncedValue(query, debounceMs)

  useEffect(() => {
    // Skip search if query is empty
    if (!debouncedQuery.trim()) {
      return
    }

    const doSearch = async () => {
      setIsLoading(true)
      try {
        const response = await searchService.quick({
          query: debouncedQuery,
          limit: 5
        })
        setSearchNotes(response.notes)
      } catch {
        setSearchNotes([])
      } finally {
        setIsLoading(false)
      }
    }

    doSearch()
  }, [debouncedQuery])

  // Compute notes during render - empty array when query is empty
  const notes = query.trim() ? searchNotes : []

  const clear = useCallback(() => {
    setQuery('')
    setSearchNotes([])
  }, [])

  return { query, notes, isLoading, setQuery, clear }
}

// ============================================================================
// Search Stats Hook
// ============================================================================

export interface UseSearchStatsReturn {
  stats: SearchStats | null
  isLoading: boolean
  refresh: () => Promise<void>
  rebuildIndex: () => Promise<void>
  rebuildProgress: number | null
}

/**
 * Hook for search index stats and management.
 */
export function useSearchStats(): UseSearchStatsReturn {
  const [stats, setStats] = useState<SearchStats | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [rebuildProgress, setRebuildProgress] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await searchService.getStats()
      setStats(result)
    } catch {
      // Ignore errors
    } finally {
      setIsLoading(false)
    }
  }, [])

  const rebuildIndex = useCallback(async () => {
    setRebuildProgress(0)
    try {
      await searchService.rebuildIndex()
    } catch {
      setRebuildProgress(null)
    }
  }, [])

  // Subscribe to rebuild events
  useEffect(() => {
    const unsubProgress = onSearchIndexRebuildProgress((progress) => {
      setRebuildProgress(progress.percentage)
    })

    const unsubCompleted = onSearchIndexRebuildCompleted(() => {
      setRebuildProgress(null)
      refresh()
    })

    return () => {
      unsubProgress()
      unsubCompleted()
    }
  }, [refresh])

  // Load stats on mount
  useEffect(() => {
    refresh()
  }, [refresh])

  return { stats, isLoading, refresh, rebuildIndex, rebuildProgress }
}

// ============================================================================
// Recent Searches Hook
// ============================================================================

export interface UseRecentSearchesReturn {
  recent: string[]
  isLoading: boolean
  addRecent: (query: string) => Promise<void>
  clearRecent: () => Promise<void>
  refresh: () => Promise<void>
}

/**
 * Hook for managing recent searches.
 */
export function useRecentSearches(): UseRecentSearchesReturn {
  const [recent, setRecent] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await searchService.getRecent()
      setRecent(result)
    } catch {
      // Ignore errors
    } finally {
      setIsLoading(false)
    }
  }, [])

  const addRecent = useCallback(async (query: string) => {
    try {
      await searchService.addRecent(query)
      setRecent((prev) => {
        const filtered = prev.filter((q) => q !== query.toLowerCase())
        return [query.toLowerCase(), ...filtered].slice(0, 20)
      })
    } catch {
      // Ignore errors
    }
  }, [])

  const clearRecent = useCallback(async () => {
    try {
      await searchService.clearRecent()
      setRecent([])
    } catch {
      // Ignore errors
    }
  }, [])

  // Load on mount - use ref to avoid refresh dependency
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    refreshRef.current()
  }, [])

  return { recent, isLoading, addRecent, clearRecent, refresh }
}
