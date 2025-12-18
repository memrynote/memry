import type {
  NotesClientAPI,
  Note,
  NoteListItem,
  NoteCreateResponse,
  NoteUpdateResponse,
  NoteListResponse,
  NoteLinksResponse,
  NoteCreatedEvent,
  NoteUpdatedEvent,
  NoteDeletedEvent,
  NoteRenamedEvent,
  NoteMovedEvent,
  NoteExternalChangeEvent
} from '../../../preload/index.d'

/**
 * Notes service - thin wrapper around window.api.notes
 * Provides a typed interface for note operations in the renderer process.
 */
export const notesService: NotesClientAPI = {
  /**
   * Create a new note.
   */
  create: (input: {
    title: string
    content?: string
    folder?: string
    tags?: string[]
    template?: string
  }): Promise<NoteCreateResponse> => {
    return window.api.notes.create(input)
  },

  /**
   * Get a note by ID.
   */
  get: (id: string): Promise<Note | null> => {
    return window.api.notes.get(id)
  },

  /**
   * Get a note by path.
   */
  getByPath: (path: string): Promise<Note | null> => {
    return window.api.notes.getByPath(path)
  },

  /**
   * Update an existing note.
   */
  update: (input: {
    id: string
    title?: string
    content?: string
    tags?: string[]
    frontmatter?: Record<string, unknown>
  }): Promise<NoteUpdateResponse> => {
    return window.api.notes.update(input)
  },

  /**
   * Rename a note (changes title and filename).
   */
  rename: (id: string, newTitle: string): Promise<NoteUpdateResponse> => {
    return window.api.notes.rename(id, newTitle)
  },

  /**
   * Move a note to a different folder.
   */
  move: (id: string, newFolder: string): Promise<NoteUpdateResponse> => {
    return window.api.notes.move(id, newFolder)
  },

  /**
   * Delete a note.
   */
  delete: (id: string): Promise<{ success: boolean; error?: string }> => {
    return window.api.notes.delete(id)
  },

  /**
   * List notes with filtering and pagination.
   */
  list: (options?: {
    folder?: string
    tags?: string[]
    sortBy?: 'modified' | 'created' | 'title'
    sortOrder?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }): Promise<NoteListResponse> => {
    return window.api.notes.list(options)
  },

  /**
   * Get all tags with their usage counts.
   */
  getTags: (): Promise<{ tag: string; count: number }[]> => {
    return window.api.notes.getTags()
  },

  /**
   * Get outgoing and incoming links for a note.
   */
  getLinks: (id: string): Promise<NoteLinksResponse> => {
    return window.api.notes.getLinks(id)
  },

  /**
   * Get all folders containing notes.
   */
  getFolders: (): Promise<string[]> => {
    return window.api.notes.getFolders()
  },

  /**
   * Create a new folder.
   */
  createFolder: (path: string): Promise<{ success: boolean }> => {
    return window.api.notes.createFolder(path)
  },

  /**
   * Check if a note exists by title or path.
   */
  exists: (titleOrPath: string): Promise<boolean> => {
    return window.api.notes.exists(titleOrPath)
  },

  /**
   * Open note in default external editor.
   */
  openExternal: (id: string): Promise<void> => {
    return window.api.notes.openExternal(id)
  },

  /**
   * Reveal note file in Finder/Explorer.
   */
  revealInFinder: (id: string): Promise<void> => {
    return window.api.notes.revealInFinder(id)
  }
}

// ============================================================================
// Event Subscriptions
// ============================================================================

/**
 * Subscribe to note created events.
 * Returns unsubscribe function.
 */
export function onNoteCreated(callback: (event: NoteCreatedEvent) => void): () => void {
  return window.api.onNoteCreated(callback)
}

/**
 * Subscribe to note updated events.
 * Returns unsubscribe function.
 */
export function onNoteUpdated(callback: (event: NoteUpdatedEvent) => void): () => void {
  return window.api.onNoteUpdated(callback)
}

/**
 * Subscribe to note deleted events.
 * Returns unsubscribe function.
 */
export function onNoteDeleted(callback: (event: NoteDeletedEvent) => void): () => void {
  return window.api.onNoteDeleted(callback)
}

/**
 * Subscribe to note renamed events.
 * Returns unsubscribe function.
 */
export function onNoteRenamed(callback: (event: NoteRenamedEvent) => void): () => void {
  return window.api.onNoteRenamed(callback)
}

/**
 * Subscribe to note moved events.
 * Returns unsubscribe function.
 */
export function onNoteMoved(callback: (event: NoteMovedEvent) => void): () => void {
  return window.api.onNoteMoved(callback)
}

/**
 * Subscribe to external file change events.
 * Fired when note files are modified outside the app.
 * Returns unsubscribe function.
 */
export function onNoteExternalChange(
  callback: (event: NoteExternalChangeEvent) => void
): () => void {
  return window.api.onNoteExternalChange(callback)
}

// Re-export types for convenience
export type {
  Note,
  NoteListItem,
  NoteCreateResponse,
  NoteUpdateResponse,
  NoteListResponse,
  NoteLinksResponse,
  NoteCreatedEvent,
  NoteUpdatedEvent,
  NoteDeletedEvent,
  NoteRenamedEvent,
  NoteMovedEvent,
  NoteExternalChangeEvent
}
