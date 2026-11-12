/**
 * Notes Query Hooks
 * TanStack Query based hooks for notes with caching and stale-while-revalidate.
 *
 * @module hooks/use-notes-query
 */

import { useEffect, useCallback, useMemo } from 'react'
import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey
} from '@tanstack/react-query'
import type {
  FolderInfo,
  Note,
  NoteLinksResponse,
  NoteListFields,
  NoteListItem,
  NoteListResponse
} from '@memry/rpc/notes'

// Types are re-exported at the end of this file
import {
  notesService,
  onNoteCreated,
  onNoteUpdated,
  onNoteDeleted,
  onNoteLinksChanged,
  onNoteRenamed,
  onNoteMoved,
  onNoteExternalChange,
  onNoteEventsDropped
} from '@/services/notes-service'
import {
  onJournalEntryCreated,
  onJournalEntryUpdated,
  onJournalEntryDeleted
} from '@/services/journal-service'
import { onVaultIndexProgress } from '@/services/vault-service'
import { subscribeToEvents } from '@/services/tauri-event'
import { unwrapIpcResult } from '@/lib/ipc-error'
import { onCanvasCreated, onCanvasDeleted, onCanvasUpdated } from '@/services/canvas-service'
import { tagsService } from '@/services/tags-service'

/**
 * Minimum spacing between notes-list refetches driven by background index-build
 * progress. The build emits every 10 files; refetching the whole list that
 * often on a large vault would drown the renderer.
 */
const INDEX_PROGRESS_INVALIDATE_MS = 2000

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
  tagCategories: () => [...notesKeys.all, 'tag-categories'] as const,
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
  /**
   * Omit for the full row. `'tree'` asks main to skip the fields the sidebar
   * never renders (`snippet`, `mimeType`, `fileSize`) — it is part of the
   * query key, so the two shapes are cached separately and a `'tree'` fetch
   * can never overwrite a full-shape consumer's cache entry.
   */
  fields?: NoteListFields
  /** Also list journal entries; part of the query key like `fields`. */
  includeJournals?: boolean
}

export interface UseNoteOptions {
  /** Whether to enable the query (default: true) */
  enabled?: boolean
  /**
   * Read the note again on every mount and note switch, even from a fresh cache: an open
   * editor needs the file as it is now, not as it was when the cache was filled.
   */
  readOnMount?: boolean
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
  /** A read of this note finished since the hook mounted or switched to it. */
  isFetchedAfterMount: boolean
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
export const METADATA_STALE_TIME = 60_000

/** 5 minutes - keep in cache for quick access */
const NOTE_GC_TIME = 5 * 60 * 1000

/**
 * 1 minute for list pages. Loading more notes changes the key, so each smaller
 * page left behind stays cached until this runs out; there is no reason to keep
 * those for the full five.
 */
const NOTES_LIST_GC_TIME = 60 * 1000

/** Stable empty arrays/objects to avoid recreating on every render */
const EMPTY_FOLDERS: FolderInfo[] = []
const EMPTY_TAGS: Array<{
  tag: string
  color: string
  count: number
  icon: string | null
  categoryId: string | null
  sortOrder: number
}> = []
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
  const { enabled = true, readOnMount = false } = options
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: notesKeys.note(id!),
    queryFn: () => notesService.get(id!),
    enabled: enabled && !!id,
    // `refetchOnMount: 'always'` would miss a note switch, which reads only a stale cache.
    staleTime: readOnMount ? 0 : NOTE_STALE_TIME,
    gcTime: NOTE_GC_TIME
  })

  // Subscribe to note events for cache invalidation
  useEffect(() => {
    if (!id) return undefined

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

    // A folder rename or move sends no rename event for the notes inside it, only this one.
    const unsubMoved = onNoteMoved((event) => {
      if (event.id !== id) return
      const key = notesKeys.note(id)
      queryClient.setQueryData<Note | null>(key, (cached) =>
        cached ? { ...cached, path: event.newPath } : cached
      )
      // A read in flight began before the move and would answer the old path: read again.
      if (queryClient.isFetching({ queryKey: key }) > 0) rereadQueries(queryClient, key)
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

    // A dropped event may have been this note's.
    const unsubDropped = onNoteEventsDropped(() => {
      void queryClient.invalidateQueries({ queryKey: notesKeys.note(id) })
    })

    return () => {
      unsubUpdated()
      unsubRenamed()
      unsubMoved()
      unsubDeleted()
      unsubExternal()
      unsubDropped()
    }
  }, [id, queryClient])

  return {
    note: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    isFetchedAfterMount: query.isFetchedAfterMount,
    refetch: (...args) => void query.refetch(...args)
  }
}

// =============================================================================
// useNotesList Hook - Notes List with Caching
// =============================================================================

/**
 * Reads the queries under `queryKey` again after what they show changed. TanStack folds a refetch
 * into a read already out while the query has no data yet (`cancelRefetch` applies only once it
 * has), and that read may have taken its answer before the change: its answer then clears the
 * invalidation and stays fresh for the stale time, so a note made during the sidebar's first
 * read stayed out of the tree (#3967). Cancelling that read silently, as TanStack does for a
 * refetch over data, makes the refetch a new read; only active queries, which the invalidation
 * refetches at once. A query that already has data needs no help: TanStack restarts its read on
 * the refetch anyway.
 */
export function rereadQueries(queryClient: QueryClient, queryKey: QueryKey): void {
  void queryClient.cancelQueries(
    { queryKey, type: 'active', fetchStatus: 'fetching' },
    { silent: true, revert: false }
  )
  void queryClient.invalidateQueries({ queryKey })
}

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
    gcTime: NOTES_LIST_GC_TIME
  })

  // Subscribe to note events for list invalidation
  useEffect(() => {
    const invalidateLists = () => rereadQueries(queryClient, notesKeys.lists())
    // The listeners go live a round trip after this effect asks for them. A note made, renamed,
    // moved or deleted after the list's first read and before then shows wrong until the next
    // event (#3967, #4270): read again once they listen.
    const unsubNotes = subscribeToEvents(
      [
        (live) => onNoteCreated(invalidateLists, live),
        (live) => onNoteDeleted(invalidateLists, live),
        (live) => onNoteUpdated(invalidateLists, live),
        (live) => onNoteRenamed(invalidateLists, live),
        (live) => onNoteMoved(invalidateLists, live)
      ],
      invalidateLists
    )

    // The background index build (vault open on a not-yet-indexed vault) writes
    // notes straight into the cache without per-note events, so the list would
    // sit stale until something else touched it. Refresh on its progress beats,
    // throttled — and always on the final 100% so the finished tree lands.
    let lastIndexInvalidateAt = 0
    const unsubIndexProgress = onVaultIndexProgress((progress) => {
      const now = Date.now()
      if (progress < 100 && now - lastIndexInvalidateAt < INDEX_PROGRESS_INVALIDATE_MS) return
      lastIndexInvalidateAt = now
      void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
    })

    // Dropped events may have been any note's: the lists and the tags may be stale.
    const unsubDropped = onNoteEventsDropped(() => {
      invalidateLists()
      void queryClient.invalidateQueries({ queryKey: notesKeys.tags() })
    })

    return () => {
      unsubNotes()
      unsubIndexProgress()
      unsubDropped()
    }
  }, [queryClient])

  // Journal entries are listed only on request (the sidebar, when the journal
  // folder is shown), and the Journal page's writes emit journal events, not
  // note events.
  const includeJournals = listOptions.includeJournals === true
  useEffect(() => {
    if (!includeJournals) return undefined
    const invalidate = () => rereadQueries(queryClient, notesKeys.lists())
    return subscribeToEvents(
      [
        (live) => onJournalEntryCreated(invalidate, live),
        (live) => onJournalEntryUpdated(invalidate, live),
        (live) => onJournalEntryDeleted(invalidate, live)
      ],
      invalidate
    )
  }, [includeJournals, queryClient])

  // Memoize data to avoid recreating object reference
  const data = useMemo(() => query.data ?? EMPTY_NOTES_LIST, [query.data])

  return {
    notes: data.notes,
    total: data.total,
    hasMore: data.hasMore,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: (...args) => void query.refetch(...args)
  }
}

// =============================================================================
// useNoteTags Hook - Tags with Caching
// =============================================================================

/**
 * Fetch all tags with TanStack Query caching. `useNoteMetadataEvents` (mounted once in App)
 * owns the events that refresh it.
 */
export function useNoteTagsQuery(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options

  const query = useQuery({
    queryKey: notesKeys.tags(),
    queryFn: async () => {
      const { tags } = await tagsService.getAllWithCounts()
      return tags.map((t) => ({
        tag: t.name,
        color: t.color ?? '',
        count: t.count,
        icon: t.icon ?? null,
        categoryId: t.categoryId ?? null,
        sortOrder: t.sortOrder ?? 0
      }))
    },
    enabled,
    staleTime: METADATA_STALE_TIME,
    gcTime: NOTE_GC_TIME
  })

  // Memoize tags to avoid recreating array reference
  const tags = useMemo(() => query.data ?? EMPTY_TAGS, [query.data])

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
 * Fetch all folders with TanStack Query caching. `useNoteMetadataEvents` (mounted once in App)
 * owns the events that refresh it.
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
    [createFolderMutation]
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
    [setFolderIconMutation]
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
    if (!noteId) return undefined

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

    // The index wrote links that touch this note. A note event comes before the index has
    // written the edit's links, so this is what shows them.
    const unsubLinks = onNoteLinksChanged(({ sourceIds, targetIds }) => {
      if (sourceIds.includes(noteId) || targetIds.includes(noteId)) refresh()
    })
    // A created note resolves any outgoing link that named its title.
    const unsubCreated = onNoteCreated(refresh)
    const unsubDeleted = onNoteDeleted(refresh)
    // An arrow drawn or removed on any canvas can add or drop a connection, and
    // a canvas arriving by sync (or as a conflict copy) can bring its own.
    const unsubCanvasCreated = onCanvasCreated(refresh)
    const unsubCanvasUpdated = onCanvasUpdated(refresh)
    const unsubCanvasDeleted = onCanvasDeleted(refresh)

    return () => {
      unsubUpdated()
      unsubLinks()
      unsubCreated()
      unsubDeleted()
      unsubCanvasCreated()
      unsubCanvasUpdated()
      unsubCanvasDeleted()
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
    onSuccess: (result, noteId) => {
      // A note the delete left (kept, or its file could not go) stays cached.
      if (!result.success) return
      // Remove from cache
      queryClient.removeQueries({ queryKey: notesKeys.note(noteId) })
      // Invalidate lists
      void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
    }
  })

  // A refused rename rejects with its reason: the title field and the sidebar's inline rename
  // show a failure only from `catch`, so an envelope would snap the title back unexplained (#4008).
  const renameNote = useMutation({
    mutationFn: async ({ id, newTitle }: { id: string; newTitle: string }) =>
      unwrapIpcResult(await notesService.rename(id, newTitle), 'errors:note.renameFailed'),
    onSuccess: (result, variables) => {
      if (result.note) {
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
export type { Note, NoteListFields, NoteListItem, NoteListResponse, NoteLinksResponse }
