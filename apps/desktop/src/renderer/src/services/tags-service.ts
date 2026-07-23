import type {
  GetNotesByTagResponse,
  GetAllWithCountsResponse,
  MergeTagResponse,
  TagOperationResponse,
  RenameTagResponse,
  DeleteTagResponse,
  TagRenamedEvent,
  TagColorUpdatedEvent,
  TagDeletedEvent,
  TagNotesChangedEvent,
  TagAssignment,
  ListCategoriesResponse,
  CategoryOperationResponse,
  CreateCategoryResponse
} from '../../../preload/index.d'

/**
 * Tags service - thin wrapper around window.api.tags
 * Provides a typed interface for tag operations in the renderer process.
 *
 * `TagsClientAPI` is the shape of `window.api.tags` (the wire-level IPC
 * surface); most methods here forward 1:1. The tag category methods below
 * are deliberately flattened for ergonomic call sites and wrap the values
 * back into the object shape `window.api.tags` expects, so this object is
 * not a strict `TagsClientAPI` implementation.
 */
export const tagsService = {
  /**
   * Get notes for a specific tag with pinned status.
   */
  getNotesByTag: (input: {
    tag: string
    sortBy?: 'modified' | 'created' | 'title'
    sortOrder?: 'asc' | 'desc'
    includeDescendants?: boolean
  }): Promise<GetNotesByTagResponse> => {
    return window.api.tags.getNotesByTag(input)
  },

  /**
   * Pin a note to a tag.
   */
  pinNoteToTag: (input: { noteId: string; tag: string }): Promise<TagOperationResponse> => {
    return window.api.tags.pinNoteToTag(input)
  },

  /**
   * Unpin a note from a tag.
   */
  unpinNoteFromTag: (input: { noteId: string; tag: string }): Promise<TagOperationResponse> => {
    return window.api.tags.unpinNoteFromTag(input)
  },

  /**
   * Rename a tag across all notes.
   */
  renameTag: (input: { oldName: string; newName: string }): Promise<RenameTagResponse> => {
    return window.api.tags.renameTag(input)
  },

  /**
   * Update tag color.
   */
  updateTagColor: (input: { tag: string; color: string }): Promise<TagOperationResponse> => {
    return window.api.tags.updateTagColor(input)
  },

  /**
   * Update tag icon (raw emoji or "icon:Name", null clears).
   */
  updateTagIcon: (input: { tag: string; icon: string | null }): Promise<TagOperationResponse> => {
    return window.api.tags.updateTagIcon(input)
  },

  /**
   * Delete a tag from all notes.
   */
  deleteTag: (tag: string): Promise<DeleteTagResponse> => {
    return window.api.tags.deleteTag(tag)
  },

  /**
   * Remove tag from a specific note.
   */
  removeTagFromNote: (input: { noteId: string; tag: string }): Promise<TagOperationResponse> => {
    return window.api.tags.removeTagFromNote(input)
  },

  getAllWithCounts: (): Promise<GetAllWithCountsResponse> => {
    return window.api.tags.getAllWithCounts()
  },

  mergeTag: (input: { source: string; target: string }): Promise<MergeTagResponse> => {
    return window.api.tags.mergeTag(input)
  },

  /**
   * List tag categories with their tag counts.
   */
  listCategories: (): Promise<ListCategoriesResponse> => {
    return window.api.tags.listCategories()
  },

  /**
   * Create a tag category.
   */
  createCategory: (name: string): Promise<CreateCategoryResponse> => {
    return window.api.tags.createCategory({ name })
  },

  /**
   * Rename a tag category.
   */
  renameCategory: (id: string, name: string): Promise<CategoryOperationResponse> => {
    return window.api.tags.renameCategory({ id, name })
  },

  /**
   * Delete a tag category. Its tags become uncategorized, not deleted.
   */
  deleteCategory: (id: string): Promise<CategoryOperationResponse> => {
    return window.api.tags.deleteCategory({ id })
  },

  /**
   * Apply a drag result: tag assignments and/or category order, in one call.
   */
  reorder: (payload: {
    tags?: TagAssignment[]
    categories?: { id: string; sortOrder: number }[]
  }): Promise<CategoryOperationResponse> => {
    return window.api.tags.reorder(payload)
  }
}

// ============================================================================
// Event Subscription Helpers
// ============================================================================

/**
 * Subscribe to tag renamed events.
 * @returns Unsubscribe function
 */
export function onTagRenamed(callback: (event: TagRenamedEvent) => void): () => void {
  return window.api.onTagRenamed(callback)
}

/**
 * Subscribe to tag color updated events.
 * @returns Unsubscribe function
 */
export function onTagColorUpdated(callback: (event: TagColorUpdatedEvent) => void): () => void {
  return window.api.onTagColorUpdated(callback)
}

/**
 * Subscribe to tag deleted events.
 * @returns Unsubscribe function
 */
export function onTagDeleted(callback: (event: TagDeletedEvent) => void): () => void {
  return window.api.onTagDeleted(callback)
}

/**
 * Subscribe to tag notes changed events (pin/unpin/add/remove).
 * @returns Unsubscribe function
 */
export function onTagNotesChanged(callback: (event: TagNotesChangedEvent) => void): () => void {
  return window.api.onTagNotesChanged(callback)
}

/**
 * Subscribe to tag category changed events (create/rename/delete/reorder).
 * @returns Unsubscribe function
 */
export function onTagCategoriesChanged(callback: () => void): () => void {
  return window.api.onTagCategoriesChanged(callback)
}

// ============================================================================
// Type Re-exports
// ============================================================================

export type {
  GetNotesByTagResponse,
  GetAllWithCountsResponse,
  MergeTagResponse,
  TagOperationResponse,
  RenameTagResponse,
  DeleteTagResponse,
  TagNoteItem,
  TagWithCount,
  TagRenamedEvent,
  TagColorUpdatedEvent,
  TagDeletedEvent,
  TagNotesChangedEvent,
  TagCategoryRow,
  TagAssignment,
  ListCategoriesResponse,
  CategoryOperationResponse,
  CreateCategoryResponse
} from '../../../preload/index.d'
