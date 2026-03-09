import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  SearchResponse,
  SearchResultGroup,
  ContentType,
  RecentSearch,
  DateRange
} from '@memry/contracts/search-api'
import { searchService } from '@/services/search-service'

const DEBOUNCE_MS = 150
const MAX_QUERY_LENGTH = 500

interface UseSearchState {
  query: string
  results: SearchResultGroup[]
  totalCount: number
  queryTimeMs: number
  loading: boolean
  error: string | null
}

export interface UseSearchFilters {
  types: ContentType[]
  tags: string[]
  dateRange: DateRange | null
}

interface UseSearchReturn {
  query: string
  setQuery: (q: string) => void
  results: SearchResultGroup[]
  totalCount: number
  queryTimeMs: number
  loading: boolean
  error: string | null
  filters: UseSearchFilters
  setFilters: (f: UseSearchFilters) => void
  recentSearches: RecentSearch[]
  loadRecentSearches: () => void
  clearRecentSearches: () => void
  reset: () => void
}

const INITIAL_FILTERS: UseSearchFilters = { types: [], tags: [], dateRange: null }

export function useSearch(): UseSearchReturn {
  const [state, setState] = useState<UseSearchState>({
    query: '',
    results: [],
    totalCount: 0,
    queryTimeMs: 0,
    loading: false,
    error: null
  })
  const [filters, setFilters] = useState<UseSearchFilters>(INITIAL_FILTERS)
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef(0)
  const lastSavedQueryRef = useRef('')

  const setQuery = useCallback((q: string) => {
    const clamped = q.length > MAX_QUERY_LENGTH ? q.slice(0, MAX_QUERY_LENGTH) : q
    setState((prev) => ({ ...prev, query: clamped, error: null }))
  }, [])

  const loadRecentSearches = useCallback(() => {
    searchService
      .getRecent()
      .then(setRecentSearches)
      .catch(() => {})
  }, [])

  const clearRecentSearches = useCallback(() => {
    searchService
      .clearRecent()
      .then(() => setRecentSearches([]))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)

    const trimmed = state.query.trim()
    if (!trimmed) {
      setState((prev) => ({
        ...prev,
        results: [],
        totalCount: 0,
        queryTimeMs: 0,
        loading: false,
        error: null
      }))
      return
    }

    setState((prev) => ({ ...prev, loading: true }))
    const requestId = ++abortRef.current

    timerRef.current = setTimeout(async () => {
      try {
        const response: SearchResponse = await searchService.query({
          text: trimmed,
          types: filters.types,
          tags: filters.tags,
          dateRange: filters.dateRange,
          projectId: null,
          folderPath: null,
          limit: 10,
          offset: 0
        })

        if (abortRef.current !== requestId) return

        setState((prev) => ({
          ...prev,
          results: response.groups,
          totalCount: response.totalCount,
          queryTimeMs: response.queryTimeMs,
          loading: false,
          error: null
        }))

        if (response.totalCount > 0 && trimmed !== lastSavedQueryRef.current) {
          lastSavedQueryRef.current = trimmed
          searchService
            .addRecent({ query: trimmed, resultCount: response.totalCount })
            .catch(() => {})
        }
      } catch (err) {
        if (abortRef.current !== requestId) return
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : 'Search failed'
        }))
      }
    }, DEBOUNCE_MS)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [state.query, filters.types, filters.tags, filters.dateRange])

  const reset = useCallback(() => {
    abortRef.current++
    if (timerRef.current) clearTimeout(timerRef.current)
    lastSavedQueryRef.current = ''
    setState({
      query: '',
      results: [],
      totalCount: 0,
      queryTimeMs: 0,
      loading: false,
      error: null
    })
    setFilters(INITIAL_FILTERS)
  }, [])

  return {
    query: state.query,
    setQuery,
    results: state.results,
    totalCount: state.totalCount,
    queryTimeMs: state.queryTimeMs,
    loading: state.loading,
    error: state.error,
    filters,
    setFilters,
    recentSearches,
    loadRecentSearches,
    clearRecentSearches,
    reset
  }
}
