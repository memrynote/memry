/**
 * useFolderSuggestions Hook
 *
 * Fetches AI-powered folder suggestions for moving a note.
 * Caches suggestions per noteId to avoid re-fetching.
 *
 * @module hooks/use-folder-suggestions
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { FolderSuggestion } from '@shared/contracts/folder-view-api'

interface UseFolderSuggestionsResult {
  /** AI folder suggestions */
  suggestions: FolderSuggestion[]
  /** Whether suggestions are currently loading */
  isLoading: boolean
  /** Error if fetch failed */
  error: Error | null
  /** Manually refetch suggestions */
  refetch: () => void
}

// Simple in-memory cache for suggestions
const suggestionsCache = new Map<string, FolderSuggestion[]>()

/**
 * Hook to fetch AI-powered folder suggestions for moving a note.
 *
 * @param noteId - The note ID to get suggestions for, or null to skip
 * @returns Suggestions, loading state, and error
 *
 * @example
 * ```tsx
 * const { suggestions, isLoading, error } = useFolderSuggestions(noteId);
 *
 * if (isLoading) return <Skeleton />;
 * if (error) return null; // Silently fail - AI suggestions are optional
 *
 * return (
 *   <div>
 *     {suggestions.map(s => (
 *       <div key={s.path}>{s.path} - {s.reason}</div>
 *     ))}
 *   </div>
 * );
 * ```
 */
export function useFolderSuggestions(noteId: string | null): UseFolderSuggestionsResult {
  const [suggestions, setSuggestions] = useState<FolderSuggestion[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const mountedRef = useRef(true)

  const fetchSuggestions = useCallback(async () => {
    if (!noteId) {
      setSuggestions([])
      setIsLoading(false)
      setError(null)
      return
    }

    // Check cache first
    const cached = suggestionsCache.get(noteId)
    if (cached) {
      setSuggestions(cached)
      setIsLoading(false)
      setError(null)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const response = await window.api.folderView.getFolderSuggestions(noteId)

      if (!mountedRef.current) return

      // Cache the result
      suggestionsCache.set(noteId, response.suggestions)

      setSuggestions(response.suggestions)
      setIsLoading(false)
    } catch (err) {
      if (!mountedRef.current) return

      console.error('[useFolderSuggestions] Error fetching suggestions:', err)
      setError(err instanceof Error ? err : new Error('Failed to fetch suggestions'))
      setSuggestions([])
      setIsLoading(false)
    }
  }, [noteId])

  // Fetch on mount or noteId change
  useEffect(() => {
    mountedRef.current = true
    fetchSuggestions()

    return () => {
      mountedRef.current = false
    }
  }, [fetchSuggestions])

  // Manual refetch (clears cache for this noteId)
  const refetch = useCallback(() => {
    if (noteId) {
      suggestionsCache.delete(noteId)
    }
    fetchSuggestions()
  }, [noteId, fetchSuggestions])

  return {
    suggestions,
    isLoading,
    error,
    refetch
  }
}

/**
 * Clear the entire suggestions cache.
 * Useful for testing or when user changes settings.
 */
export function clearFolderSuggestionsCache(): void {
  suggestionsCache.clear()
}
