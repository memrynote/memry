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
  CreateCategoryResponse,
  TagsClientAPI
} from '../../../preload/index.d'
import { commands, events } from '../../../generated/bindings'
import { extractErrorMessage } from '../lib/ipc-error'
import { subscribeToEvent } from './tauri-event'

/**
 * Tags service. The methods in `ported` are the Rust commands of Step 13j (`commands/tags.rs`);
 * every other method still forwards to `window.api.tags`.
 *
 * `TagsClientAPI` is the shape of `window.api.tags` (the wire-level IPC
 * surface); most methods here forward 1:1 and are checked against it via
 * `TagsService` below. The three tag category methods that take flat
 * arguments (`createCategory`, `renameCategory`, `deleteCategory`) are
 * deliberately overridden for ergonomic call sites.
 */
type TagsService = Omit<TagsClientAPI, 'createCategory' | 'renameCategory' | 'deleteCategory'> & {
  createCategory: (name: string) => Promise<CreateCategoryResponse>
  renameCategory: (id: string, name: string) => Promise<CategoryOperationResponse>
  deleteCategory: (id: string) => Promise<CategoryOperationResponse>
}

/** A failed write as Electron's tag handlers answer it: the error's message. */
function failure(error: unknown): { success: false; error?: string } {
  const message = extractErrorMessage(error, '')
  return message ? { success: false, error: message } : { success: false }
}

/** Runs a write that answers `{ success }`, a rejection becoming `{ success: false }`. */
async function settled(write: () => Promise<unknown>): Promise<TagOperationResponse> {
  try {
    await write()
    return { success: true }
  } catch (error) {
    return failure(error)
  }
}

/**
 * The tag commands of Step 13j. The list and a tag's notes reject on failure, as Electron's
 * handlers rethrow; the writes answer `{ success: false, error }`, as its handlers do.
 */
const ported = {
  getNotesByTag: (input: {
    tag: string
    sortBy?: 'modified' | 'created' | 'title'
    sortOrder?: 'asc' | 'desc'
    includeDescendants?: boolean
  }): Promise<GetNotesByTagResponse> => commands.tagsGetNotesByTag(input),

  updateTagColor: (input: { tag: string; color: string }): Promise<TagOperationResponse> =>
    settled(() => commands.tagsUpdateColor(input.tag, input.color)),

  /** A raw emoji or "icon:Name"; null clears it. */
  updateTagIcon: (input: { tag: string; icon: string | null }): Promise<TagOperationResponse> =>
    settled(() => commands.tagsUpdateIcon(input.tag, input.icon)),

  getAllWithCounts: async (): Promise<GetAllWithCountsResponse> => ({
    tags: await commands.tagsGetAllWithCounts()
  }),

  listCategories: async (): Promise<ListCategoriesResponse> => {
    try {
      return { success: true, categories: await commands.tagsListCategories() }
    } catch (error) {
      return failure(error)
    }
  },

  createCategory: async (name: string): Promise<CreateCategoryResponse> => {
    try {
      return { success: true, category: await commands.tagsCreateCategory(name) }
    } catch (error) {
      return failure(error)
    }
  },

  renameCategory: (id: string, name: string): Promise<CategoryOperationResponse> =>
    settled(() => commands.tagsRenameCategory(id, name)),

  /** Its tags become uncategorized, not deleted. */
  deleteCategory: (id: string): Promise<CategoryOperationResponse> =>
    settled(() => commands.tagsDeleteCategory(id)),

  /** A drag result: tag assignments and/or category order, in one call. */
  reorder: (payload: {
    tags?: TagAssignment[]
    categories?: { id: string; sortOrder: number }[]
  }): Promise<CategoryOperationResponse> => settled(() => commands.tagsReorder(payload))
}

/** The tag methods served from Rust; `window.api.tags` is typed without them. */
export type PortedTagMethod = keyof typeof ported

export const tagsService: TagsService = {
  ...ported,

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
  renameTag: (input: {
    oldName: string
    newName: string
    runId?: string
  }): Promise<RenameTagResponse> => {
    return window.api.tags.renameTag(input)
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

  mergeTag: (input: { source: string; target: string }): Promise<MergeTagResponse> => {
    return window.api.tags.mergeTag(input)
  },

  getSchemaSnapshot: () => window.api.tags.getSchemaSnapshot(),

  editSchema: (command) => window.api.tags.editSchema(command),

  previewImpact: (query) => window.api.tags.previewImpact(query),

  getFillStatus: () => window.api.tags.getFillStatus(),

  fillFields: (input) => window.api.tags.fillFields(input),

  searchObjects: (input) => window.api.tags.searchObjects(input),

  getLinkedHere: (input) => window.api.tags.getLinkedHere(input)
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
  return subscribeToEvent(events.tagColorUpdatedEvent, callback)
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
  return subscribeToEvent(events.tagCategoriesChangedEvent, () => callback())
}

/** The subscriptions above that Rust events serve; `window.api` is typed without them. */
export type PortedTagEvent = 'onTagColorUpdated' | 'onTagCategoriesChanged'

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
