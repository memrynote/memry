/**
 * useNotes Hook
 * Manages notes data with real IPC calls to the main process.
 *
 * @example
 * ```tsx
 * function NotesList() {
 *   const { notes, isLoading, error, createNote, deleteNote } = useNotes()
 *
 *   if (isLoading) return <div>Loading...</div>
 *   if (error) return <div>Error: {error}</div>
 *
 *   return (
 *     <ul>
 *       {notes.map(note => (
 *         <li key={note.id}>{note.title}</li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  Note,
  NoteListItem,
  NoteListResponse,
  NoteLinksResponse
} from '../../../preload/index.d'
import {
  notesService,
  onNoteCreated,
  onNoteUpdated,
  onNoteDeleted,
  onNoteRenamed,
  onNoteMoved,
  onNoteExternalChange
} from '../services/notes-service'

export interface UseNotesOptions {
  /** Initial folder to filter notes */
  folder?: string
  /** Initial tags to filter by */
  tags?: string[]
  /** Sort field */
  sortBy?: 'modified' | 'created' | 'title'
  /** Sort direction */
  sortOrder?: 'asc' | 'desc'
  /** Page size */
  limit?: number
  /** Auto-load on mount */
  autoLoad?: boolean
}

export interface UseNotesReturn {
  // State
  notes: NoteListItem[]
  currentNote: Note | null
  total: number
  hasMore: boolean
  isLoading: boolean
  error: string | null

  // Actions
  loadNotes: (options?: {
    folder?: string
    tags?: string[]
    sortBy?: 'modified' | 'created' | 'title'
    sortOrder?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }) => Promise<NoteListResponse>
  loadMore: () => Promise<void>
  refresh: () => Promise<void>
  createNote: (input: {
    title: string
    content?: string
    folder?: string
    tags?: string[]
  }) => Promise<Note | null>
  getNote: (id: string) => Promise<Note | null>
  updateNote: (input: {
    id: string
    title?: string
    content?: string
    tags?: string[]
    frontmatter?: Record<string, unknown>
  }) => Promise<Note | null>
  renameNote: (id: string, newTitle: string) => Promise<Note | null>
  moveNote: (id: string, newFolder: string) => Promise<Note | null>
  deleteNote: (id: string) => Promise<boolean>
  setCurrentNote: (note: Note | null) => void
  clearError: () => void
}

/**
 * Hook for notes state management.
 * Provides notes list, current note, loading states, and CRUD actions.
 */
export function useNotes(options: UseNotesOptions = {}): UseNotesReturn {
  const {
    folder: initialFolder,
    tags: initialTags,
    sortBy: initialSortBy = 'modified',
    sortOrder: initialSortOrder = 'desc',
    limit: initialLimit = 100,
    autoLoad = true
  } = options

  // State
  const [notes, setNotes] = useState<NoteListItem[]>([])
  const [currentNote, setCurrentNote] = useState<Note | null>(null)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track current filter options for loadMore
  const currentOptionsRef = useRef({
    folder: initialFolder,
    tags: initialTags,
    sortBy: initialSortBy,
    sortOrder: initialSortOrder,
    limit: initialLimit,
    offset: 0
  })

  /**
   * Load notes with optional filters.
   */
  const loadNotes = useCallback(
    async (loadOptions?: {
      folder?: string
      tags?: string[]
      sortBy?: 'modified' | 'created' | 'title'
      sortOrder?: 'asc' | 'desc'
      limit?: number
      offset?: number
    }): Promise<NoteListResponse> => {
      setIsLoading(true)
      setError(null)

      const opts = {
        folder: loadOptions?.folder ?? initialFolder,
        tags: loadOptions?.tags ?? initialTags,
        sortBy: loadOptions?.sortBy ?? initialSortBy,
        sortOrder: loadOptions?.sortOrder ?? initialSortOrder,
        limit: loadOptions?.limit ?? initialLimit,
        offset: loadOptions?.offset ?? 0
      }

      // Store for loadMore
      currentOptionsRef.current = opts

      try {
        const result = await notesService.list(opts)
        setNotes(result.notes)
        setTotal(result.total)
        setHasMore(result.hasMore)
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load notes'
        setError(message)
        return { notes: [], total: 0, hasMore: false }
      } finally {
        setIsLoading(false)
      }
    },
    [initialFolder, initialTags, initialSortBy, initialSortOrder, initialLimit]
  )

  /**
   * Load more notes (pagination).
   */
  const loadMore = useCallback(async (): Promise<void> => {
    if (!hasMore || isLoading) return

    setIsLoading(true)
    setError(null)

    const opts = {
      ...currentOptionsRef.current,
      offset: notes.length
    }

    try {
      const result = await notesService.list(opts)
      setNotes((prev) => [...prev, ...result.notes])
      setTotal(result.total)
      setHasMore(result.hasMore)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load more notes'
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [hasMore, isLoading, notes.length])

  /**
   * Refresh the current notes list.
   */
  const refresh = useCallback(async (): Promise<void> => {
    await loadNotes(currentOptionsRef.current)
  }, [loadNotes])

  /**
   * Create a new note.
   */
  const createNote = useCallback(
    async (input: {
      title: string
      content?: string
      folder?: string
      tags?: string[]
    }): Promise<Note | null> => {
      setError(null)

      try {
        const result = await notesService.create(input)

        if (!result.success) {
          setError(result.error ?? 'Failed to create note')
          return null
        }

        // Note will be added via event listener
        return result.note
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create note'
        setError(message)
        return null
      }
    },
    []
  )

  /**
   * Get a single note by ID.
   */
  const getNote = useCallback(async (id: string): Promise<Note | null> => {
    setError(null)

    try {
      const note = await notesService.get(id)
      return note
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get note'
      setError(message)
      return null
    }
  }, [])

  /**
   * Update an existing note.
   */
  const updateNote = useCallback(
    async (input: {
      id: string
      title?: string
      content?: string
      tags?: string[]
      frontmatter?: Record<string, unknown>
    }): Promise<Note | null> => {
      setError(null)

      try {
        const result = await notesService.update(input)

        if (!result.success) {
          setError(result.error ?? 'Failed to update note')
          return null
        }

        // Update current note if it's the one being updated
        if (currentNote?.id === input.id && result.note) {
          setCurrentNote(result.note)
        }

        // Note will be updated via event listener
        return result.note
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update note'
        setError(message)
        return null
      }
    },
    [currentNote?.id]
  )

  /**
   * Rename a note.
   */
  const renameNote = useCallback(
    async (id: string, newTitle: string): Promise<Note | null> => {
      setError(null)

      try {
        const result = await notesService.rename(id, newTitle)

        if (!result.success) {
          setError(result.error ?? 'Failed to rename note')
          return null
        }

        // Update current note if it's the one being renamed
        if (currentNote?.id === id && result.note) {
          setCurrentNote(result.note)
        }

        return result.note
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to rename note'
        setError(message)
        return null
      }
    },
    [currentNote?.id]
  )

  /**
   * Move a note to a different folder.
   */
  const moveNote = useCallback(
    async (id: string, newFolder: string): Promise<Note | null> => {
      setError(null)

      try {
        const result = await notesService.move(id, newFolder)

        if (!result.success) {
          setError(result.error ?? 'Failed to move note')
          return null
        }

        // Update current note if it's the one being moved
        if (currentNote?.id === id && result.note) {
          setCurrentNote(result.note)
        }

        return result.note
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to move note'
        setError(message)
        return null
      }
    },
    [currentNote?.id]
  )

  /**
   * Delete a note.
   */
  const deleteNote = useCallback(
    async (id: string): Promise<boolean> => {
      setError(null)

      try {
        const result = await notesService.delete(id)

        if (!result.success) {
          setError(result.error ?? 'Failed to delete note')
          return false
        }

        // Clear current note if it's the one being deleted
        if (currentNote?.id === id) {
          setCurrentNote(null)
        }

        // Note will be removed via event listener
        return true
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete note'
        setError(message)
        return false
      }
    },
    [currentNote?.id]
  )

  /**
   * Clear error state.
   */
  const clearError = useCallback(() => {
    setError(null)
  }, [])

  // Load initial notes
  useEffect(() => {
    if (autoLoad) {
      loadNotes()
    }
  }, [autoLoad, loadNotes])

  // Subscribe to note events
  useEffect(() => {
    const unsubCreated = onNoteCreated((event) => {
      // Add to list if it matches current filter
      setNotes((prev) => {
        // Check if note already exists
        if (prev.some((n) => n.id === event.note.id)) {
          return prev
        }
        // Add at start (assuming sorted by modified desc)
        return [event.note, ...prev]
      })
      setTotal((prev) => prev + 1)
    })

    const unsubUpdated = onNoteUpdated((event) => {
      setNotes((prev) =>
        prev.map((note) =>
          note.id === event.id
            ? {
                ...note,
                ...event.changes,
                modified: event.changes.modified ?? note.modified
              }
            : note
        )
      )

      // Update current note if it's the one being updated
      if (currentNote?.id === event.id) {
        setCurrentNote((prev) => (prev ? { ...prev, ...event.changes } : prev))
      }
    })

    const unsubDeleted = onNoteDeleted((event) => {
      setNotes((prev) => prev.filter((note) => note.id !== event.id))
      setTotal((prev) => Math.max(0, prev - 1))

      // Clear current note if it's the one being deleted
      if (currentNote?.id === event.id) {
        setCurrentNote(null)
      }
    })

    const unsubRenamed = onNoteRenamed((event) => {
      setNotes((prev) =>
        prev.map((note) =>
          note.id === event.id
            ? { ...note, title: event.newTitle, path: event.newPath }
            : note
        )
      )

      if (currentNote?.id === event.id) {
        setCurrentNote((prev) =>
          prev ? { ...prev, title: event.newTitle, path: event.newPath } : prev
        )
      }
    })

    const unsubMoved = onNoteMoved((event) => {
      setNotes((prev) =>
        prev.map((note) => (note.id === event.id ? { ...note, path: event.newPath } : note))
      )

      if (currentNote?.id === event.id) {
        setCurrentNote((prev) => (prev ? { ...prev, path: event.newPath } : prev))
      }
    })

    const unsubExternal = onNoteExternalChange((event) => {
      if (event.type === 'deleted') {
        setNotes((prev) => prev.filter((note) => note.id !== event.id))
        setTotal((prev) => Math.max(0, prev - 1))

        if (currentNote?.id === event.id) {
          setCurrentNote(null)
        }
      } else if (event.type === 'modified') {
        // Refresh the note data
        refresh()
      }
    })

    return () => {
      unsubCreated()
      unsubUpdated()
      unsubDeleted()
      unsubRenamed()
      unsubMoved()
      unsubExternal()
    }
  }, [currentNote?.id, refresh])

  return {
    // State
    notes,
    currentNote,
    total,
    hasMore,
    isLoading,
    error,

    // Actions
    loadNotes,
    loadMore,
    refresh,
    createNote,
    getNote,
    updateNote,
    renameNote,
    moveNote,
    deleteNote,
    setCurrentNote,
    clearError
  }
}

/**
 * Hook for getting tags with counts.
 */
export function useNoteTags() {
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadTags = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await notesService.getTags()
      setTags(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load tags'
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTags()
  }, [loadTags])

  return {
    tags,
    isLoading,
    error,
    refresh: loadTags
  }
}

/**
 * Hook for getting note links (outgoing and incoming).
 */
export function useNoteLinks(noteId: string | null) {
  const [links, setLinks] = useState<NoteLinksResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadLinks = useCallback(async (id: string) => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await notesService.getLinks(id)
      setLinks(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load links'
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (noteId) {
      loadLinks(noteId)
    } else {
      setLinks(null)
    }
  }, [noteId, loadLinks])

  return {
    outgoing: links?.outgoing ?? [],
    incoming: links?.incoming ?? [],
    isLoading,
    error,
    refresh: noteId ? () => loadLinks(noteId) : undefined
  }
}

/**
 * Hook for getting note folders.
 */
export function useNoteFolders() {
  const [folders, setFolders] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadFolders = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await notesService.getFolders()
      setFolders(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load folders'
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const createFolder = useCallback(async (path: string): Promise<boolean> => {
    try {
      const result = await notesService.createFolder(path)
      if (result.success) {
        await loadFolders()
      }
      return result.success
    } catch {
      return false
    }
  }, [loadFolders])

  useEffect(() => {
    loadFolders()
  }, [loadFolders])

  return {
    folders,
    isLoading,
    error,
    refresh: loadFolders,
    createFolder
  }
}

// Re-export types for convenience
export type { Note, NoteListItem, NoteListResponse, NoteLinksResponse }
