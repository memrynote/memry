/**
 * Tags IPC handlers.
 * Handles tag management operations for sidebar drill-down feature.
 *
 * @module ipc/tags-handlers
 */

import { ipcMain, BrowserWindow } from 'electron'
import { TagsChannels } from '@shared/ipc-channels'
import {
  GetNotesByTagSchema,
  PinNoteToTagSchema,
  UnpinNoteFromTagSchema,
  RenameTagSchema,
  UpdateTagColorSchema,
  RemoveTagFromNoteSchema,
  type TagNoteItem,
  type GetNotesByTagResponse,
  type TagOperationResponse,
  type RenameTagResponse,
  type DeleteTagResponse
} from '@shared/contracts/tags-api'
import { createValidatedHandler, createStringHandler } from './validate'
import { getIndexDatabase } from '../database'
import {
  findNotesWithTagInfo,
  pinNoteToTag,
  unpinNoteFromTag,
  renameTag,
  deleteTag,
  removeTagFromNote,
  getTagDefinition,
  updateTagColor,
  getNoteTags
} from '@shared/db/queries/notes'

/**
 * Emit tag event to all windows
 */
function emitTagEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

/**
 * Helper to get index database, throwing a user-friendly error if not available.
 */
function requireIndexDatabase() {
  try {
    return getIndexDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
}

/**
 * Convert NoteWithTagInfo to TagNoteItem for API response
 */
function toTagNoteItem(
  note: {
    id: string
    path: string
    title: string
    createdAt: string
    modifiedAt: string
    wordCount: number
    isPinned: boolean
    pinnedAt: string | null
    emoji?: string | null
  },
  tags: string[]
): TagNoteItem {
  return {
    id: note.id,
    path: note.path,
    title: note.title,
    created: note.createdAt,
    modified: note.modifiedAt,
    tags,
    wordCount: note.wordCount,
    isPinned: note.isPinned,
    pinnedAt: note.pinnedAt,
    emoji: note.emoji
  }
}

/**
 * Register all tags IPC handlers.
 */
export function registerTagsHandlers(): void {
  // tags:get-notes-by-tag - Get notes for a specific tag with pinned status
  ipcMain.handle(
    TagsChannels.invoke.GET_NOTES_BY_TAG,
    createValidatedHandler(GetNotesByTagSchema, async (input) => {
      const db = requireIndexDatabase()

      // Get tag definition for color
      const tagDef = getTagDefinition(db, input.tag)
      const color = tagDef?.color ?? 'gray'

      // Get notes with pinned info
      const notes = findNotesWithTagInfo(db, input.tag, {
        sortBy: input.sortBy,
        sortOrder: input.sortOrder
      })

      // Separate pinned and unpinned
      const pinnedNotes: TagNoteItem[] = []
      const unpinnedNotes: TagNoteItem[] = []

      for (const note of notes) {
        const noteTags = getNoteTags(db, note.id)
        const item = toTagNoteItem(note, noteTags)

        if (note.isPinned) {
          pinnedNotes.push(item)
        } else {
          unpinnedNotes.push(item)
        }
      }

      const response: GetNotesByTagResponse = {
        tag: input.tag,
        color,
        count: notes.length,
        pinnedNotes,
        unpinnedNotes
      }

      return response
    })
  )

  // tags:pin-note-to-tag - Pin a note to a tag
  ipcMain.handle(
    TagsChannels.invoke.PIN_NOTE_TO_TAG,
    createValidatedHandler(PinNoteToTagSchema, async (input) => {
      const db = requireIndexDatabase()

      try {
        pinNoteToTag(db, input.noteId, input.tag)

        // Emit event
        emitTagEvent(TagsChannels.events.NOTES_CHANGED, {
          tag: input.tag,
          noteId: input.noteId,
          action: 'pinned'
        })

        return { success: true } as TagOperationResponse
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to pin note'
        return { success: false, error: message } as TagOperationResponse
      }
    })
  )

  // tags:unpin-note-from-tag - Unpin a note from a tag
  ipcMain.handle(
    TagsChannels.invoke.UNPIN_NOTE_FROM_TAG,
    createValidatedHandler(UnpinNoteFromTagSchema, async (input) => {
      const db = requireIndexDatabase()

      try {
        unpinNoteFromTag(db, input.noteId, input.tag)

        // Emit event
        emitTagEvent(TagsChannels.events.NOTES_CHANGED, {
          tag: input.tag,
          noteId: input.noteId,
          action: 'unpinned'
        })

        return { success: true } as TagOperationResponse
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to unpin note'
        return { success: false, error: message } as TagOperationResponse
      }
    })
  )

  // tags:rename - Rename a tag across all notes
  ipcMain.handle(
    TagsChannels.invoke.RENAME_TAG,
    createValidatedHandler(RenameTagSchema, async (input) => {
      const db = requireIndexDatabase()

      try {
        const affectedNotes = renameTag(db, input.oldName, input.newName)

        // Emit event
        emitTagEvent(TagsChannels.events.RENAMED, {
          oldName: input.oldName,
          newName: input.newName,
          affectedNotes
        })

        // Also emit tags changed for sidebar update
        emitTagEvent('notes:tags-changed', {})

        return { success: true, affectedNotes } as RenameTagResponse
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to rename tag'
        return { success: false, error: message } as RenameTagResponse
      }
    })
  )

  // tags:update-color - Update tag color
  ipcMain.handle(
    TagsChannels.invoke.UPDATE_TAG_COLOR,
    createValidatedHandler(UpdateTagColorSchema, async (input) => {
      const db = requireIndexDatabase()

      try {
        updateTagColor(db, input.tag, input.color)

        // Emit event
        emitTagEvent(TagsChannels.events.COLOR_UPDATED, {
          tag: input.tag,
          color: input.color
        })

        // Also emit tags changed for sidebar update
        emitTagEvent('notes:tags-changed', {})

        return { success: true } as TagOperationResponse
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update tag color'
        return { success: false, error: message } as TagOperationResponse
      }
    })
  )

  // tags:delete - Delete a tag from all notes
  ipcMain.handle(
    TagsChannels.invoke.DELETE_TAG,
    createStringHandler(async (tag: string) => {
      const db = requireIndexDatabase()

      try {
        const affectedNotes = deleteTag(db, tag)

        // Emit event
        emitTagEvent(TagsChannels.events.DELETED, {
          tag,
          affectedNotes
        })

        // Also emit tags changed for sidebar update
        emitTagEvent('notes:tags-changed', {})

        return { success: true, affectedNotes } as DeleteTagResponse
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete tag'
        return { success: false, error: message } as DeleteTagResponse
      }
    })
  )

  // tags:remove-from-note - Remove tag from a specific note
  ipcMain.handle(
    TagsChannels.invoke.REMOVE_TAG_FROM_NOTE,
    createValidatedHandler(RemoveTagFromNoteSchema, async (input) => {
      const db = requireIndexDatabase()

      try {
        removeTagFromNote(db, input.noteId, input.tag)

        // Emit event
        emitTagEvent(TagsChannels.events.NOTES_CHANGED, {
          tag: input.tag,
          noteId: input.noteId,
          action: 'removed'
        })

        // Also emit tags changed for sidebar update
        emitTagEvent('notes:tags-changed', {})

        return { success: true } as TagOperationResponse
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to remove tag from note'
        return { success: false, error: message } as TagOperationResponse
      }
    })
  )
}
