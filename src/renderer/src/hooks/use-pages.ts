/**
 * usePages Hook
 * Manages pages data for wiki-link functionality
 */

import { useState, useCallback, useEffect } from 'react'
import { createLogger } from '@/lib/logger'
import { fuzzySearch } from '@/lib/fuzzy-search'

const log = createLogger('Hook:Pages')

export interface Page {
  id: string
  title: string
  type: 'page' | 'note' | 'journal'
  content?: string
  lastEdited: string // ISO timestamp
  exists: boolean
}

const STORAGE_KEY = 'memry:pages'

// Mock data for initial development
const MOCK_PAGES: Page[] = [
  {
    id: '1',
    title: 'Project Alpha',
    type: 'page',
    content: 'Main project documentation...',
    lastEdited: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    exists: true
  },
  {
    id: '2',
    title: 'Meeting Notes',
    type: 'note',
    content: 'Weekly standup notes...',
    lastEdited: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
    exists: true
  },
  {
    id: '3',
    title: 'Weekly Review',
    type: 'note',
    content: 'Review of accomplishments...',
    lastEdited: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
    exists: true
  },
  {
    id: '4',
    title: '2024 Goals',
    type: 'page',
    content: 'Annual goals and objectives...',
    lastEdited: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 1 week ago
    exists: true
  },
  {
    id: '5',
    title: 'Book Notes',
    type: 'note',
    content: 'Notes from recent reading...',
    lastEdited: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
    exists: true
  },
  {
    id: '6',
    title: 'Ideas',
    type: 'page',
    content: 'Collection of ideas...',
    lastEdited: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(), // 2 weeks ago
    exists: true
  },
  {
    id: '7',
    title: 'Project Beta',
    type: 'page',
    content: 'Side project documentation...',
    lastEdited: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago
    exists: true
  },
  {
    id: '8',
    title: 'Side Project Ideas',
    type: 'note',
    content: 'Brainstorming side projects...',
    lastEdited: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(), // 12 days ago
    exists: true
  }
]

/**
 * Custom hook for managing pages
 */
export function usePages() {
  const [pages, setPages] = useState<Page[]>(() => {
    // Try to load from localStorage, fall back to mock data
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        return JSON.parse(stored)
      }
    } catch (error) {
      log.error('Failed to load pages from localStorage:', error)
    }
    return MOCK_PAGES
  })

  // Persist to localStorage whenever pages change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pages))
    } catch (error) {
      log.error('Failed to save pages to localStorage:', error)
    }
  }, [pages])

  /**
   * Check if a page with the given title exists
   */
  const checkPageExists = useCallback(
    (title: string): boolean => {
      const normalizedTitle = title.toLowerCase().trim()
      return pages.some((p) => p.title.toLowerCase().trim() === normalizedTitle)
    },
    [pages]
  )

  /**
   * Get a page by title (case-insensitive)
   */
  const getPageByTitle = useCallback(
    (title: string): Page | undefined => {
      const normalizedTitle = title.toLowerCase().trim()
      return pages.find((p) => p.title.toLowerCase().trim() === normalizedTitle)
    },
    [pages]
  )

  /**
   * Create a new page
   */
  const createPage = useCallback((title: string, type: Page['type'] = 'page'): Page => {
    const newPage: Page = {
      id: crypto.randomUUID(),
      title: title.trim(),
      type,
      content: '',
      lastEdited: new Date().toISOString(),
      exists: true
    }

    setPages((prev) => [...prev, newPage])
    return newPage
  }, [])

  /**
   * Update an existing page
   */
  const updatePage = useCallback((id: string, updates: Partial<Omit<Page, 'id'>>) => {
    setPages((prev) =>
      prev.map((page) =>
        page.id === id
          ? {
              ...page,
              ...updates,
              lastEdited: new Date().toISOString()
            }
          : page
      )
    )
  }, [])

  /**
   * Delete a page
   */
  const deletePage = useCallback((id: string) => {
    setPages((prev) => prev.filter((page) => page.id !== id))
  }, [])

  /**
   * Search pages with fuzzy matching
   */
  const searchPages = useCallback(
    (query: string): Page[] => {
      if (!query || query.trim() === '') {
        // Return all pages sorted by most recently edited
        return [...pages].sort(
          (a, b) => new Date(b.lastEdited).getTime() - new Date(a.lastEdited).getTime()
        )
      }

      return fuzzySearch(pages, query, ['title'])
    },
    [pages]
  )

  /**
   * Get recent pages (sorted by last edited)
   */
  const getRecentPages = useCallback(
    (limit: number = 5): Page[] => {
      return [...pages]
        .sort((a, b) => new Date(b.lastEdited).getTime() - new Date(a.lastEdited).getTime())
        .slice(0, limit)
    },
    [pages]
  )

  return {
    pages,
    checkPageExists,
    getPageByTitle,
    createPage,
    updatePage,
    deletePage,
    searchPages,
    getRecentPages
  }
}
