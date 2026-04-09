/**
 * Notes Query Hooks
 * TanStack Query based hooks for notes with caching and stale-while-revalidate.
 *
 * @module hooks/use-notes-query
 */

import { useEffect, useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  FolderInfo,
  Note,
  NoteLinksResponse,
  NoteListItem,
  NoteListResponse
} from '@memry/rpc/notes'

// Types are re-exported at the end of this file
import {
  notesService,
  onNoteCreated,
  onNoteUpdated,
  onNoteDeleted,
  onNoteRenamed,
  onNoteMoved,
  onNoteExternalChange,
  onTagsChanged
} from '@/services/notes-service'
import { tagsService } from '@/services/tags-service'

// =============================================================================
// Query Keys
// =============================================================================

export const notesKeys = {
  all: ['notes'] as const,

  // List queries
  lists: () => [...notesKeys.all, 'list'] as const,
  list: (options?: NoteListInput) => [...notesKeys.lists(), options] as const,

  // Individual note queries
  notes: () => [...notesKeys.all, 'note'] as const,
  note: (id: string) => [...notesKeys.notes(), id] as const,

  // Related data
  links: (id: string) => [...notesKeys.all, 'links', id] as const,
  tags: () => [...notesKeys.all, 'tags'] as const,
  folders: () => [...notesKeys.all, 'folders'] as const
}

// =============================================================================
// Types
// =============================================================================

export interface NoteListInput {
  folder?: string
  tags?: string[]
  sortBy?: 'modified' | 'created' | 'title'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface UseNoteOptions {
  /** Whether to enable the query (default: true) */
  enabled?: boolean
}

export interface UseNoteResult {
  /** The note data */
  note: Note | null
  /** Whether initial load is in progress */
  isLoading: boolean
  /** Whether any fetch is in progress */
  isFetching: boolean
  /** Error if query failed */
  error: Error | null
  /** Refetch the note */
  refetch: () => void
}

export interface UseNotesListOptions extends NoteListInput {
  /** Whether to enable the query (default: true) */
  enabled?: boolean
}

export interface UseNotesListResult {
  /** List of notes */
  notes: NoteListItem[]
  /** Total count */
  total: number
  /** Whether there are more notes */
  hasMore: boolean
  /** Whether initial load is in progress */
  isLoading: boolean
  /** Whether any fetch is in progress */
  isFetching: boolean
  /** Error if query failed */
  error: Error | null
  /** Refetch the list */
  refetch: () => void
}

// =============================================================================
// Stale Time Configuration
// =============================================================================

/** 30 seconds - matches journal pattern */
const NOTE_STALE_TIME = 30_000

/** 60 seconds - metadata changes less frequently */
const METADATA_STALE_TIME = 60_000

/** 5 minutes - keep in cache for quick access */
const NOTE_GC_TIME = 5 * 60 * 1000

/** Stable empty arrays/objects to avoid recreating on every render */
const EMPTY_FOLDERS: FolderInfo[] = []
const EMPTY_TAGS: Array<{ tag: string; color: string; count: number }> = []
const EMPTY_NOTES_LIST: NoteListResponse = { notes: [], total: 0, hasMore: false }
const EMPTY_LINKS: NoteLinksResponse = { outgoing: [], incoming: [] }

// =============================================================================
// useNote Hook - Single Note with Caching
// =============================================================================

/**
 * Fetch a single note with TanStack Query caching.
 * Shows cached data immediately, refreshes in background if stale.
 */
export function useNote(id: string | null, options: UseNoteOptions = {}): UseNoteResult {
  const { enabled = true } = options
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: notesKeys.note(id!),
    queryFn: () => notesService.get(id!),
    enabled: enabled && !!id,
    staleTime: NOTE_STALE_TIME,
    gcTime: NOTE_GC_TIME
  })

  // Subscribe to note events for cache invalidation
  useEffect(() => {
    if (!id) return

    const unsubUpdated = onNoteUpdated((event) => {
      if (event.id === id) {
        // Invalidate this specific note
        void queryClient.invalidateQueries({ queryKey: notesKeys.note(id) })
      }
    })

    const unsubRenamed = onNoteRenamed((event) => {
      if (event.id === id) {
        void queryClient.invalidateQueries({ queryKey: notesKeys.note(id) })
      }
    })

    const unsubDeleted = onNoteDeleted((event) => {
      if (event.id === id) {
        // Remove from cache
        queryClient.removeQueries({ queryKey: notesKeys.note(id) })
      }
    })

    const unsubExternal = onNoteExternalChange((event) => {
      if (event.id === id) {
        void queryClient.invalidateQueries({ queryKey: notesKeys.note(id) })
      }
    })

    return () => {
      unsubUpdated()
      unsubRenamed()
      unsubDeleted()
      unsubExternal()
    }
  }, [id, queryClient])

  return {
    note: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch
  }
}

// =============================================================================
// useNotesList Hook - Notes List with Caching
// =============================================================================

/**
 * Fetch notes list with TanStack Query caching.
 * Shows cached data immediately, refreshes in background if stale.
 */
export function useNotesList(options: UseNotesListOptions = {}): UseNotesListResult {
  const { enabled = true, ...listOptions } = options
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: notesKeys.list(listOptions),
    queryFn: () => notesService.list(listOptions),
    enabled,
    staleTime: NOTE_STALE_TIME,
    gcTime: NOTE_GC_TIME
  })

  // Subscribe to note events for list invalidation
  useEffect(() => {
    const unsubCreated = onNoteCreated(() => {
      // New note added, invalidate lists
      void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
    })

    const unsubDeleted = onNoteDeleted(() => {
      // Note removed, invalidate lists
      void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
    })

    const unsubUpdated = onNoteUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
    })

    const unsubRenamed = onNoteRenamed(() => {
      void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
    })

    const unsubMoved = onNoteMoved(() => {
      void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
    })

    return () => {
      unsubCreated()
      unsubUpdated()
      unsubDeleted()
      unsubRenamed()
      unsubMoved()
    }
  }, [queryClient])

  // Memoize data to avoid recreating object reference
  const data = useMemo(() => query.data ?? EMPTY_NOTES_LIST, [query.data])

  return {
    notes: data.notes,
    total: data.total,
    hasMore: data.hasMore,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch
  }
}

// =============================================================================
// useNoteTags Hook - Tags with Caching
// =============================================================================

/**
 * Fetch all tags with TanStack Query caching.
 */
export function useNoteTagsQuery(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: notesKeys.tags(),
    queryFn: async () => {
      const { tags } = await tagsService.getAllWithCounts()
      return tags.map((t) => ({ tag: t.name, color: t.color ?? '', count: t.count }))
    },
    enabled,
    staleTime: METADATA_STALE_TIME,
    gcTime: NOTE_GC_TIME
  })

  // Memoize tags to avoid recreating array reference
  const tags = useMemo(() => query.data ?? EMPTY_TAGS, [query.data])

  useEffect(() => {
    const unsubscribe = onTagsChanged(() => {
      void queryClient.invalidateQueries({ queryKey: notesKeys.tags() })
    })

    return unsubscribe
  }, [queryClient])

  return {
    tags,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch
  }
}

// =============================================================================
// useNoteFolders Hook - Folders with Caching
// =============================================================================

/**
 * Fetch all folders with TanStack Query caching.
 */
export function useNoteFoldersQuery(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: notesKeys.folders(),
    queryFn: () => notesService.getFolders(),
    enabled,
    staleTime: METADATA_STALE_TIME,
    gcTime: NOTE_GC_TIME
  })

  useEffect(() => {
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: notesKeys.folders() })
    }

    const unsubCreated = onNoteCreated(invalidate)
    const unsubDeleted = onNoteDeleted(invalidate)
    const unsubMoved = onNoteMoved(invalidate)
    const unsubRenamed = onNoteRenamed(invalidate)

    return () => {
      unsubCreated()
      unsubDeleted()
      unsubMoved()
      unsubRenamed()
    }
  }, [queryClient])

  const createFolderMutation = useMutation({
    mutationFn: (path: string) => notesService.createFolder(path),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notesKeys.folders() })
    }
  })

  // Wrap in useCallback to provide stable reference (prevents infinite re-render loops)
  const createFolder = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const result = await createFolderMutation.mutateAsync(path)
        return result.success
      } catch {
        return false
      }
    },
    [createFolderMutation.mutateAsync]
  )

  const setFolderIconMutation = useMutation({
    mutationFn: async ({ folderPath, icon }: { folderPath: string; icon: string | null }) => {
      const existing = await notesService.getFolderConfig(folderPath)
      return notesService.setFolderConfig(folderPath, { ...existing, icon })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notesKeys.folders() })
    }
  })

  const setFolderIcon = useCallback(
    async (folderPath: string, icon: string | null): Promise<boolean> => {
      try {
        const result = await setFolderIconMutation.mutateAsync({ folderPath, icon })
        return result.success
      } catch {
        return false
      }
    },
    [setFolderIconMutation.mutateAsync]
  )

  // Memoize folders to avoid recreating array reference
  const folders = useMemo(() => query.data ?? EMPTY_FOLDERS, [query.data])

  return {
    folders,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    createFolder,
    setFolderIcon
  }
}

// =============================================================================
// useNoteLinks Hook - Links with Caching
// =============================================================================

/**
 * Fetch note links (incoming/outgoing) with caching.
 */
export function useNoteLinksQuery(noteId: string | null, options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: notesKeys.links(noteId!),
    queryFn: () => notesService.getLinks(noteId!),
    enabled: enabled && !!noteId,
    staleTime: NOTE_STALE_TIME,
    gcTime: NOTE_GC_TIME
  })

  // Refresh links when notes change (links may be affected)
  useEffect(() => {
    if (!noteId) return

    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: notesKeys.links(noteId) })
    }

    // Only refresh on content changes, not all updates
    const unsubUpdated = onNoteUpdated((event) => {
      // Refresh if this note or any linked note changed
      if (event.id === noteId || event.changes.content !== undefined) {
        refresh()
      }
    })

    const unsubDeleted = onNoteDeleted(refresh)

    return () => {
      unsubUpdated()
      unsubDeleted()
    }
  }, [noteId, queryClient])

  // Memoize data to avoid recreating object reference
  const data = useMemo(() => query.data ?? EMPTY_LINKS, [query.data])

  return {
    outgoing: data.outgoing,
    incoming: data.incoming,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch
  }
}

// =============================================================================
// Mutation Hooks
// =============================================================================

/**
 * Hook providing note mutation functions with optimistic updates.
 */
export function useNoteMutations() {
  const queryClient = useQueryClient()

  const createNote = useMutation({
    mutationFn: notesService.create,
    onSuccess: () => {
      // Invalidate lists to show new note
      void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
    }
  })

  const updateNote = useMutation({
    mutationFn: notesService.update,
    onSuccess: (result, variables) => {
      if (result.success && result.note) {
        // Update single note cache
        queryClient.setQueryData(notesKeys.note(variables.id), result.note)
        // Invalidate lists in background
        void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
      }
    }
  })

  const deleteNote = useMutation({
    mutationFn: notesService.delete,
    onSuccess: (_, noteId) => {
      // Remove from cache
      queryClient.removeQueries({ queryKey: notesKeys.note(noteId) })
      // Invalidate lists
      void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
    }
  })

  const renameNote = useMutation({
    mutationFn: ({ id, newTitle }: { id: string; newTitle: string }) =>
      notesService.rename(id, newTitle),
    onSuccess: (result, variables) => {
      if (result.success && result.note) {
        queryClient.setQueryData(notesKeys.note(variables.id), result.note)
        void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
      }
    }
  })

  const moveNote = useMutation({
    mutationFn: ({ id, newFolder }: { id: string; newFolder: string }) =>
      notesService.move(id, newFolder),
    onSuccess: (result, variables) => {
      if (result.success && result.note) {
        queryClient.setQueryData(notesKeys.note(variables.id), result.note)
        void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
        void queryClient.invalidateQueries({ queryKey: notesKeys.folders() })
      }
    }
  })

  return {
    createNote,
    updateNote,
    deleteNote,
    renameNote,
    moveNote
  }
}

// =============================================================================
// Prefetch Utilities
// =============================================================================

// Re-export types
export type { Note, NoteListItem, NoteListResponse, NoteLinksResponse }
