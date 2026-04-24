/**
 * Hook for managing tag detail view state and operations.
 * Used in the sidebar drill-down for viewing notes in a tag.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('Hook:TagDetail')
import {
  tagsService,
  onTagNotesChanged,
  onTagColorUpdated,
  type TagNoteItem,
  type GetNotesByTagResponse
} from '@/services/tags-service'

export type TagSortBy = 'modified' | 'created' | 'title'
export type TagSortOrder = 'asc' | 'desc'

export interface UseTagDetailOptions {
  tag: string
  sortBy?: TagSortBy
  sortOrder?: TagSortOrder
  fallbackColor?: string
  includeDescendants?: boolean
}

export interface UseTagDetailReturn {
  // Data
  tag: string
  color: string
  count: number
  pinnedNotes: TagNoteItem[]
  unpinnedNotes: TagNoteItem[]

  // State
  isLoading: boolean
  error: string | null

  // Sorting
  sortBy: TagSortBy
  sortOrder: TagSortOrder
  setSortBy: (sortBy: TagSortBy) => void
  setSortOrder: (sortOrder: TagSortOrder) => void

  // Actions
  pinNote: (noteId: string) => Promise<void>
  unpinNote: (noteId: string) => Promise<void>
  removeNoteFromTag: (noteId: string) => Promise<void>
  refresh: () => Promise<void>
}

/**
 * Hook for managing tag detail view.
 * Fetches notes for a tag and provides actions for pinning/unpinning.
 */
export function useTagDetail(options: UseTagDetailOptions): UseTagDetailReturn {
  const { tag, fallbackColor, includeDescendants = true } = options
  const [data, setData] = useState<GetNotesByTagResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<TagSortBy>(options.sortBy ?? 'modified')
  const [sortOrder, setSortOrder] = useState<TagSortOrder>(options.sortOrder ?? 'desc')

  // Fetch notes for tag
  const fetchNotes = useCallback(async () => {
    if (!tag) return

    setIsLoading(true)
    setError(null)

    try {
      const response = await tagsService.getNotesByTag({
        tag,
        sortBy,
        sortOrder,
        includeDescendants
      })
      setData(response)
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to load notes')
      setError(message)
      log.error('Error fetching notes:', err)
    } finally {
      setIsLoading(false)
    }
  }, [tag, sortBy, sortOrder, includeDescendants])

  // Initial fetch
  useEffect(() => {
    fetchNotes()
  }, [fetchNotes])

  // Subscribe to tag notes changed events
  useEffect(() => {
    const unsubscribe = onTagNotesChanged((event) => {
      if (event.tag.toLowerCase() === tag.toLowerCase()) {
        // Refresh the list when notes change for this tag
        fetchNotes()
      }
    })

    return unsubscribe
  }, [tag, fetchNotes])

  useEffect(() => {
    const unsubscribe = onTagColorUpdated((event) => {
      if (event.tag.toLowerCase() === tag.toLowerCase()) {
        fetchNotes()
      }
    })

    return unsubscribe
  }, [tag, fetchNotes])

  // Pin a note
  const pinNote = useCallback(
    async (noteId: string) => {
      try {
        const result = await tagsService.pinNoteToTag({ noteId, tag })
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to pin note')
        }
        // The onTagNotesChanged event will trigger a refresh
      } catch (err) {
        log.error('Error pinning note:', err)
        throw err
      }
    },
    [tag]
  )

  // Unpin a note
  const unpinNote = useCallback(
    async (noteId: string) => {
      try {
        const result = await tagsService.unpinNoteFromTag({ noteId, tag })
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to unpin note')
        }
        // The onTagNotesChanged event will trigger a refresh
      } catch (err) {
        log.error('Error unpinning note:', err)
        throw err
      }
    },
    [tag]
  )

  // Remove note from tag
  const removeNoteFromTag = useCallback(
    async (noteId: string) => {
      try {
        const result = await tagsService.removeTagFromNote({ noteId, tag })
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to remove tag from note')
        }
        // The onTagNotesChanged event will trigger a refresh
      } catch (err) {
        log.error('Error removing note from tag:', err)
        throw err
      }
    },
    [tag]
  )

  // Memoized return value
  return useMemo(
    () => ({
      tag: data?.tag ?? tag,
      color: data?.color ?? fallbackColor ?? 'gray',
      count: data?.count ?? 0,
      pinnedNotes: data?.pinnedNotes ?? [],
      unpinnedNotes: data?.unpinnedNotes ?? [],
      isLoading,
      error,
      sortBy,
      sortOrder,
      setSortBy,
      setSortOrder,
      pinNote,
      unpinNote,
      removeNoteFromTag,
      refresh: fetchNotes
    }),
    [
      data,
      tag,
      isLoading,
      error,
      sortBy,
      sortOrder,
      pinNote,
      unpinNote,
      removeNoteFromTag,
      fetchNotes
    ]
  )
}
