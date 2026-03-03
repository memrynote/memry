/**
 * useAllTags Hook
 * Combines tags from notes and inbox items for comprehensive tag suggestions.
 * Provides search, recent tags, and popular tags functionality.
 *
 * @module hooks/use-all-tags
 */

import { useMemo, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { notesService, onTagsChanged } from '@/services/notes-service'
import { inboxService } from '@/services/inbox-service'

// =============================================================================
// Types
// =============================================================================

export interface TagWithMeta {
  /** Tag name (lowercase, no # prefix) */
  name: string
  /** Total usage count across notes + inbox */
  count: number
  /** Optional color from notes system */
  color?: string
  /** Source of the tag */
  source: 'notes' | 'inbox' | 'both'
}

export interface UseAllTagsResult {
  /** All tags sorted by count */
  tags: TagWithMeta[]
  /** Whether tags are loading */
  isLoading: boolean
  /** Error if query failed */
  error: Error | null
  /** Search tags by query string */
  searchTags: (query: string) => TagWithMeta[]
  /** Get most popular tags */
  getPopularTags: (limit?: number) => TagWithMeta[]
  /** Get recent tags (based on recent notes/inbox usage) */
  getRecentTags: (limit?: number) => TagWithMeta[]
  /** Refetch tags */
  refetch: () => void
}

// =============================================================================
// Query Keys
// =============================================================================

const allTagsKeys = {
  all: ['all-tags'] as const,
  notes: () => [...allTagsKeys.all, 'notes'] as const,
  inbox: () => [...allTagsKeys.all, 'inbox'] as const
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for fetching and managing all tags from notes and inbox.
 * Combines tags from both sources and provides search/filter capabilities.
 */
export function useAllTags(): UseAllTagsResult {
  // Fetch notes tags
  const notesQuery = useQuery({
    queryKey: allTagsKeys.notes(),
    queryFn: () => notesService.getTags(),
    staleTime: 60 * 1000 // 1 minute
  })

  // Fetch inbox tags
  const inboxQuery = useQuery({
    queryKey: allTagsKeys.inbox(),
    queryFn: () => inboxService.getTags(),
    staleTime: 60 * 1000 // 1 minute
  })

  useEffect(() => {
    const unsubscribe = onTagsChanged(() => {
      void notesQuery.refetch()
    })

    return unsubscribe
  }, [notesQuery.refetch])

  // Combine and deduplicate tags from both sources
  const combinedTags = useMemo((): TagWithMeta[] => {
    const tagMap = new Map<string, TagWithMeta>()

    // Add notes tags
    if (notesQuery.data) {
      for (const tag of notesQuery.data) {
        const normalizedName = tag.tag.toLowerCase()
        tagMap.set(normalizedName, {
          name: normalizedName,
          count: tag.count,
          color: tag.color,
          source: 'notes'
        })
      }
    }

    // Add inbox tags (merge counts if tag exists)
    if (inboxQuery.data) {
      for (const tag of inboxQuery.data) {
        const normalizedName = tag.tag.toLowerCase()
        const existing = tagMap.get(normalizedName)
        if (existing) {
          // Tag exists in both sources
          tagMap.set(normalizedName, {
            ...existing,
            count: existing.count + tag.count,
            source: 'both'
          })
        } else {
          tagMap.set(normalizedName, {
            name: normalizedName,
            count: tag.count,
            source: 'inbox'
          })
        }
      }
    }

    // Convert to array and sort by count (descending)
    return Array.from(tagMap.values()).sort((a, b) => b.count - a.count)
  }, [notesQuery.data, inboxQuery.data])

  // Search tags with fuzzy matching
  const searchTags = useCallback(
    (query: string): TagWithMeta[] => {
      if (!query || query.trim() === '') {
        return combinedTags
      }

      const normalizedQuery = query.toLowerCase().trim()

      // Filter tags that contain the query
      const filtered = combinedTags.filter((tag) => tag.name.includes(normalizedQuery))

      // Sort: exact match first, then starts with, then contains
      return filtered.sort((a, b) => {
        const aExact = a.name === normalizedQuery
        const bExact = b.name === normalizedQuery
        const aStartsWith = a.name.startsWith(normalizedQuery)
        const bStartsWith = b.name.startsWith(normalizedQuery)

        if (aExact && !bExact) return -1
        if (!aExact && bExact) return 1
        if (aStartsWith && !bStartsWith) return -1
        if (!aStartsWith && bStartsWith) return 1

        // If same match type, sort by count
        return b.count - a.count
      })
    },
    [combinedTags]
  )

  // Get most popular tags
  const getPopularTags = useCallback(
    (limit: number = 8): TagWithMeta[] => {
      return combinedTags.slice(0, limit)
    },
    [combinedTags]
  )

  // Get recent tags (tags from items with most recent modifications)
  // Since we don't have direct access to modification times in this context,
  // we use a heuristic: tags from inbox (likely more recent) + top notes tags
  const getRecentTags = useCallback(
    (limit: number = 5): TagWithMeta[] => {
      // Prioritize inbox tags as they're typically more recent captures
      const inboxTags = combinedTags.filter((t) => t.source === 'inbox' || t.source === 'both')
      const noteOnlyTags = combinedTags.filter((t) => t.source === 'notes')

      // Take from inbox first, then fill with notes tags
      const result: TagWithMeta[] = []
      result.push(...inboxTags.slice(0, limit))

      if (result.length < limit) {
        result.push(...noteOnlyTags.slice(0, limit - result.length))
      }

      return result.slice(0, limit)
    },
    [combinedTags]
  )

  const refetch = useCallback(() => {
    void notesQuery.refetch()
    void inboxQuery.refetch()
  }, [notesQuery, inboxQuery])

  return {
    tags: combinedTags,
    isLoading: notesQuery.isLoading || inboxQuery.isLoading,
    error: notesQuery.error || inboxQuery.error,
    searchTags,
    getPopularTags,
    getRecentTags,
    refetch
  }
}
