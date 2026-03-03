/**
 * useTags Hook
 * Manages tags data for tag functionality
 */

import { useState, useCallback, useEffect } from 'react'
import { createLogger } from '@/lib/logger'
import { fuzzySearch } from '@/lib/fuzzy-search'

const log = createLogger('Hook:Tags')

export interface Tag {
  name: string // tag name without # prefix
  count: number // usage count
  createdAt: string // ISO timestamp
}

const STORAGE_KEY = 'memry:tags'

// Mock data for initial development
const MOCK_TAGS: Tag[] = [
  {
    name: 'work',
    count: 42,
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days ago
  },
  {
    name: 'personal',
    count: 28,
    createdAt: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    name: 'ideas',
    count: 15,
    createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    name: 'productivity',
    count: 12,
    createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    name: 'wins',
    count: 8,
    createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    name: 'learning',
    count: 7,
    createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    name: 'health',
    count: 6,
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    name: 'goals',
    count: 5,
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  }
]

/**
 * Custom hook for managing tags
 */
export function useTags() {
  const [tags, setTags] = useState<Tag[]>(() => {
    // Try to load from localStorage, fall back to mock data
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        return JSON.parse(stored)
      }
    } catch (error) {
      log.error('Failed to load tags from localStorage:', error)
    }
    return MOCK_TAGS
  })

  // Persist to localStorage whenever tags change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tags))
    } catch (error) {
      log.error('Failed to save tags to localStorage:', error)
    }
  }, [tags])

  /**
   * Check if a tag exists
   */
  const tagExists = useCallback(
    (tagName: string): boolean => {
      const normalized = tagName.toLowerCase().trim()
      return tags.some((t) => t.name.toLowerCase() === normalized)
    },
    [tags]
  )

  /**
   * Get a tag by name (case-insensitive)
   */
  const getTag = useCallback(
    (tagName: string): Tag | undefined => {
      const normalized = tagName.toLowerCase().trim()
      return tags.find((t) => t.name.toLowerCase() === normalized)
    },
    [tags]
  )

  /**
   * Increment tag count or create new tag
   */
  const incrementTagCount = useCallback((tagName: string) => {
    const normalized = tagName.trim()

    setTags((prev) => {
      const existing = prev.find((t) => t.name.toLowerCase() === normalized.toLowerCase())

      if (existing) {
        // Increment count of existing tag
        return prev.map((t) =>
          t.name.toLowerCase() === normalized.toLowerCase() ? { ...t, count: t.count + 1 } : t
        )
      } else {
        // Create new tag
        const newTag: Tag = {
          name: normalized,
          count: 1,
          createdAt: new Date().toISOString()
        }
        return [...prev, newTag]
      }
    })
  }, [])

  /**
   * Decrement tag count (when tag is removed from content)
   */
  const decrementTagCount = useCallback((tagName: string) => {
    const normalized = tagName.trim()

    setTags((prev) => {
      return prev
        .map((t) =>
          t.name.toLowerCase() === normalized.toLowerCase()
            ? { ...t, count: Math.max(0, t.count - 1) }
            : t
        )
        .filter((t) => t.count > 0) // Remove tags with 0 count
    })
  }, [])

  /**
   * Delete a tag completely
   */
  const deleteTag = useCallback((tagName: string) => {
    const normalized = tagName.toLowerCase().trim()
    setTags((prev) => prev.filter((t) => t.name.toLowerCase() !== normalized))
  }, [])

  /**
   * Search tags with fuzzy matching, sorted by usage count
   */
  const searchTags = useCallback(
    (query: string): Tag[] => {
      if (!query || query.trim() === '') {
        // Return all tags sorted by count (descending)
        return [...tags].sort((a, b) => b.count - a.count)
      }

      const filtered = fuzzySearch(tags, query, ['name'])
      // Sort by count after filtering
      return filtered.sort((a, b) => b.count - a.count)
    },
    [tags]
  )

  /**
   * Get most popular tags
   */
  const getPopularTags = useCallback(
    (limit: number = 10): Tag[] => {
      return [...tags].sort((a, b) => b.count - a.count).slice(0, limit)
    },
    [tags]
  )

  /**
   * Get recently created tags
   */
  const getRecentTags = useCallback(
    (limit: number = 5): Tag[] => {
      return [...tags]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit)
    },
    [tags]
  )

  return {
    tags,
    tagExists,
    getTag,
    incrementTagCount,
    decrementTagCount,
    deleteTag,
    searchTags,
    getPopularTags,
    getRecentTags
  }
}
