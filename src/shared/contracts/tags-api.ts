/**
 * Tags IPC API Contract
 *
 * Handles tag management for the sidebar drill-down feature.
 * Provides operations for viewing, pinning, renaming, and deleting tags.
 */

import { z } from 'zod'

// Import channels from shared (single source of truth)
import { TagsChannels } from '../ipc-channels'
export { TagsChannels }

// ============================================================================
// Types
// ============================================================================

export interface TagNoteItem {
  id: string
  path: string
  title: string
  created: string
  modified: string
  tags: string[]
  wordCount: number
  isPinned: boolean
  pinnedAt: string | null
  emoji?: string | null
}

export interface TagDetail {
  name: string
  color: string
  count: number
  pinnedNotes: TagNoteItem[]
  allNotes: TagNoteItem[]
}

export type TagSortBy = 'modified' | 'created' | 'title'
export type TagSortOrder = 'asc' | 'desc'

// ============================================================================
// Request Schemas
// ============================================================================

export const GetNotesByTagSchema = z.object({
  tag: z.string().min(1),
  sortBy: z.enum(['modified', 'created', 'title']).default('modified'),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
})

export const PinNoteToTagSchema = z.object({
  noteId: z.string().min(1),
  tag: z.string().min(1)
})

export const UnpinNoteFromTagSchema = z.object({
  noteId: z.string().min(1),
  tag: z.string().min(1)
})

export const RenameTagSchema = z.object({
  oldName: z.string().min(1),
  newName: z.string().min(1).max(50)
})

export const UpdateTagColorSchema = z.object({
  tag: z.string().min(1),
  color: z.string().min(1)
})

export const RemoveTagFromNoteSchema = z.object({
  noteId: z.string().min(1),
  tag: z.string().min(1)
})

// ============================================================================
// Response Types
// ============================================================================

export interface GetNotesByTagResponse {
  tag: string
  color: string
  count: number
  pinnedNotes: TagNoteItem[]
  unpinnedNotes: TagNoteItem[]
}

export interface TagOperationResponse {
  success: boolean
  error?: string
}

export interface RenameTagResponse extends TagOperationResponse {
  affectedNotes?: number
}

export interface DeleteTagResponse extends TagOperationResponse {
  affectedNotes?: number
}

// ============================================================================
// Handler Signatures
// ============================================================================

export interface TagsHandlers {
  [TagsChannels.invoke.GET_NOTES_BY_TAG]: (
    input: z.infer<typeof GetNotesByTagSchema>
  ) => Promise<GetNotesByTagResponse>

  [TagsChannels.invoke.PIN_NOTE_TO_TAG]: (
    input: z.infer<typeof PinNoteToTagSchema>
  ) => Promise<TagOperationResponse>

  [TagsChannels.invoke.UNPIN_NOTE_FROM_TAG]: (
    input: z.infer<typeof UnpinNoteFromTagSchema>
  ) => Promise<TagOperationResponse>

  [TagsChannels.invoke.RENAME_TAG]: (
    input: z.infer<typeof RenameTagSchema>
  ) => Promise<RenameTagResponse>

  [TagsChannels.invoke.UPDATE_TAG_COLOR]: (
    input: z.infer<typeof UpdateTagColorSchema>
  ) => Promise<TagOperationResponse>

  [TagsChannels.invoke.DELETE_TAG]: (tag: string) => Promise<DeleteTagResponse>

  [TagsChannels.invoke.REMOVE_TAG_FROM_NOTE]: (
    input: z.infer<typeof RemoveTagFromNoteSchema>
  ) => Promise<TagOperationResponse>
}

// ============================================================================
// Event Payloads
// ============================================================================

export interface TagRenamedEvent {
  oldName: string
  newName: string
  affectedNotes: number
}

export interface TagColorUpdatedEvent {
  tag: string
  color: string
}

export interface TagDeletedEvent {
  tag: string
  affectedNotes: number
}

export interface TagNotesChangedEvent {
  tag: string
  noteId: string
  action: 'pinned' | 'unpinned' | 'removed' | 'added'
}

// ============================================================================
// Client API
// ============================================================================

/**
 * Tags service client interface for renderer process
 *
 * @example
 * ```typescript
 * const tags = window.api.tags;
 *
 * // Get notes for a tag
 * const { pinnedNotes, unpinnedNotes } = await tags.getNotesByTag({
 *   tag: 'design-systems',
 *   sortBy: 'modified'
 * });
 *
 * // Pin a note
 * await tags.pinNoteToTag({ noteId: 'abc123', tag: 'design-systems' });
 *
 * // Listen for changes
 * window.api.on('tags:notes-changed', ({ tag, noteId, action }) => {
 *   if (tag === currentTag) refreshTagView();
 * });
 * ```
 */
export interface TagsClientAPI {
  getNotesByTag(input: z.infer<typeof GetNotesByTagSchema>): Promise<GetNotesByTagResponse>
  pinNoteToTag(input: z.infer<typeof PinNoteToTagSchema>): Promise<TagOperationResponse>
  unpinNoteFromTag(input: z.infer<typeof UnpinNoteFromTagSchema>): Promise<TagOperationResponse>
  renameTag(input: z.infer<typeof RenameTagSchema>): Promise<RenameTagResponse>
  updateTagColor(input: z.infer<typeof UpdateTagColorSchema>): Promise<TagOperationResponse>
  deleteTag(tag: string): Promise<DeleteTagResponse>
  removeTagFromNote(input: z.infer<typeof RemoveTagFromNoteSchema>): Promise<TagOperationResponse>
}
