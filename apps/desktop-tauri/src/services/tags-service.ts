import type {
  TagsClientAPI,
  TagRenamedEvent,
  TagColorUpdatedEvent,
  TagDeletedEvent,
  TagNotesChangedEvent
} from '@/types/preload-types'
import { createInvokeForwarder, subscribeEvent } from '@/lib/ipc/forwarder'

/**
 * Tags service - Tauri invoke forwarder.
 * Provides a typed interface for tag operations in the renderer process.
 */
export const tagsService: TagsClientAPI = createInvokeForwarder<TagsClientAPI>('tags')

// ============================================================================
// Event Subscription Helpers
// ============================================================================

/**
 * Subscribe to tag renamed events.
 * @returns Unsubscribe function
 */
export function onTagRenamed(callback: (event: TagRenamedEvent) => void): () => void {
  return subscribeEvent<TagRenamedEvent>('tag-renamed', callback)
}

/**
 * Subscribe to tag color updated events.
 * @returns Unsubscribe function
 */
export function onTagColorUpdated(callback: (event: TagColorUpdatedEvent) => void): () => void {
  return subscribeEvent<TagColorUpdatedEvent>('tag-color-updated', callback)
}

/**
 * Subscribe to tag deleted events.
 * @returns Unsubscribe function
 */
export function onTagDeleted(callback: (event: TagDeletedEvent) => void): () => void {
  return subscribeEvent<TagDeletedEvent>('tag-deleted', callback)
}

/**
 * Subscribe to tag notes changed events (pin/unpin/add/remove).
 * @returns Unsubscribe function
 */
export function onTagNotesChanged(callback: (event: TagNotesChangedEvent) => void): () => void {
  return subscribeEvent<TagNotesChangedEvent>('tag-notes-changed', callback)
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
  TagNotesChangedEvent
} from '@/types/preload-types'
