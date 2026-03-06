/**
 * Tags IPC handlers.
 * Handles tag management operations for sidebar drill-down feature.
 *
 * @module ipc/tags-handlers
 */

import { readFile } from 'fs/promises'
import { ipcMain, BrowserWindow } from 'electron'
import { eq } from 'drizzle-orm'
import { TagsChannels } from '@memry/contracts/ipc-channels'
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
} from '@memry/contracts/tags-api'
import { noteTags } from '@memry/db-schema/schema/notes-cache'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { createValidatedHandler, createStringHandler } from './validate'
import { getDatabase, getIndexDatabase } from '../database'
import {
  findNotesWithTagInfo,
  pinNoteToTag,
  unpinNoteFromTag,
  renameTag,
  deleteTag,
  removeTagFromNote,
  getOrCreateTag,
  renameTagDefinition,
  deleteTagDefinition,
  updateTagColor,
  getNoteTags,
  getNoteCacheById
} from '@main/database/queries/notes'
import { createLogger } from '../lib/logger'
import { toAbsolutePath } from '../vault/notes'
import { parseNote, serializeNote } from '../vault/frontmatter'
import { atomicWrite } from '../vault/file-ops'
import { getNoteSyncService } from '../sync/note-sync'
import { getTagDefinitionSyncService } from '../sync/tag-definition-sync'

const log = createLogger('TagsHandlers')

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
 * Helper to get data database, throwing a user-friendly error if not available.
 */
function requireDatabase() {
  try {
    return getDatabase()
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
    wordCount: number | null
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
    wordCount: note.wordCount ?? 0,
    isPinned: note.isPinned,
    pinnedAt: note.pinnedAt,
    emoji: note.emoji
  }
}

function getAffectedNoteIds(indexDb: ReturnType<typeof getIndexDatabase>, tag: string): string[] {
  const normalized = tag.toLowerCase().trim()
  return indexDb
    .select({ noteId: noteTags.noteId })
    .from(noteTags)
    .where(eq(noteTags.tag, normalized))
    .all()
    .map((r) => r.noteId)
}

async function updateNoteFrontmatterTag(
  indexDb: ReturnType<typeof getIndexDatabase>,
  noteId: string,
  mutate: (tags: string[]) => string[]
): Promise<void> {
  const cached = getNoteCacheById(indexDb, noteId)
  if (!cached) return

  const absolutePath = toAbsolutePath(cached.path)
  const raw = await readFile(absolutePath, 'utf-8')
  const parsed = parseNote(raw, absolutePath)

  const currentTags: string[] = Array.isArray(parsed.frontmatter.tags)
    ? parsed.frontmatter.tags
    : []
  const updatedTags = mutate(currentTags)

  if (updatedTags.length === 0) {
    delete parsed.frontmatter.tags
  } else {
    parsed.frontmatter.tags = updatedTags
  }

  const serialized = serializeNote(parsed.frontmatter, parsed.content)
  await atomicWrite(absolutePath, serialized)
  getNoteSyncService()?.enqueueUpdate(noteId)
}

/**
 * Register all tags IPC handlers.
 */
export function registerTagsHandlers(): void {
  // tags:get-notes-by-tag - Get notes for a specific tag with pinned status
  ipcMain.handle(
    TagsChannels.invoke.GET_NOTES_BY_TAG,
    createValidatedHandler(GetNotesByTagSchema, (input) => {
      const indexDb = requireIndexDatabase()
      const dataDb = requireDatabase()

      // Get tag definition for color (create if missing)
      const { color } = getOrCreateTag(dataDb, input.tag)

      // Get notes with pinned info
      const notes = findNotesWithTagInfo(indexDb, input.tag, {
        sortBy: input.sortBy,
        sortOrder: input.sortOrder
      })

      // Separate pinned and unpinned
      const pinnedNotes: TagNoteItem[] = []
      const unpinnedNotes: TagNoteItem[] = []

      for (const note of notes) {
        const noteTags = getNoteTags(indexDb, note.id)
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
    createValidatedHandler(PinNoteToTagSchema, (input) => {
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
    createValidatedHandler(UnpinNoteFromTagSchema, (input) => {
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
      const indexDb = requireIndexDatabase()
      const dataDb = requireDatabase()

      try {
        const noteIds = getAffectedNoteIds(indexDb, input.oldName)

        const affectedNotes = renameTag(indexDb, input.oldName, input.newName)

        const oldTagSnapshot = dataDb
          .select()
          .from(tagDefinitions)
          .where(eq(tagDefinitions.name, input.oldName.toLowerCase().trim()))
          .get()

        renameTagDefinition(dataDb, input.oldName, input.newName)

        const syncService = getTagDefinitionSyncService()
        if (syncService && oldTagSnapshot) {
          syncService.enqueueDelete(input.oldName, JSON.stringify(oldTagSnapshot))
          syncService.enqueueCreate(input.newName.toLowerCase().trim())
        }

        const normalizedOld = input.oldName.toLowerCase().trim()
        const normalizedNew = input.newName.toLowerCase().trim()
        await Promise.all(
          noteIds.map((noteId) =>
            updateNoteFrontmatterTag(indexDb, noteId, (tags) =>
              tags.map((t) => (t.toLowerCase() === normalizedOld ? normalizedNew : t))
            ).catch((err) => log.warn('Failed to update frontmatter for note', { noteId, err }))
          )
        )

        emitTagEvent(TagsChannels.events.RENAMED, {
          oldName: input.oldName,
          newName: input.newName,
          affectedNotes
        })
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
    createValidatedHandler(UpdateTagColorSchema, (input) => {
      const dataDb = requireDatabase()

      try {
        getOrCreateTag(dataDb, input.tag)
        updateTagColor(dataDb, input.tag, input.color)
        getTagDefinitionSyncService()?.enqueueUpdate(input.tag)

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
      const indexDb = requireIndexDatabase()
      const dataDb = requireDatabase()

      try {
        const noteIds = getAffectedNoteIds(indexDb, tag)

        const normalizedTag = tag.toLowerCase().trim()
        const tagSnapshot = dataDb
          .select()
          .from(tagDefinitions)
          .where(eq(tagDefinitions.name, normalizedTag))
          .get()

        const affectedNotes = deleteTag(indexDb, tag)
        deleteTagDefinition(dataDb, tag)

        if (tagSnapshot) {
          getTagDefinitionSyncService()?.enqueueDelete(normalizedTag, JSON.stringify(tagSnapshot))
        }
        await Promise.all(
          noteIds.map((noteId) =>
            updateNoteFrontmatterTag(indexDb, noteId, (tags) =>
              tags.filter((t) => t.toLowerCase() !== normalizedTag)
            ).catch((err) => log.warn('Failed to update frontmatter for note', { noteId, err }))
          )
        )

        emitTagEvent(TagsChannels.events.DELETED, { tag, affectedNotes })
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

        const normalizedTag = input.tag.toLowerCase().trim()
        await updateNoteFrontmatterTag(db, input.noteId, (tags) =>
          tags.filter((t) => t.toLowerCase() !== normalizedTag)
        ).catch((err) =>
          log.warn('Failed to update frontmatter for note', { noteId: input.noteId, err })
        )

        emitTagEvent(TagsChannels.events.NOTES_CHANGED, {
          tag: input.tag,
          noteId: input.noteId,
          action: 'removed'
        })
        emitTagEvent('notes:tags-changed', {})

        return { success: true } as TagOperationResponse
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to remove tag from note'
        return { success: false, error: message } as TagOperationResponse
      }
    })
  )
}

/**
 * Unregister all tags IPC handlers.
 */
export function unregisterTagsHandlers(): void {
  ipcMain.removeHandler(TagsChannels.invoke.GET_NOTES_BY_TAG)
  ipcMain.removeHandler(TagsChannels.invoke.PIN_NOTE_TO_TAG)
  ipcMain.removeHandler(TagsChannels.invoke.UNPIN_NOTE_FROM_TAG)
  ipcMain.removeHandler(TagsChannels.invoke.RENAME_TAG)
  ipcMain.removeHandler(TagsChannels.invoke.UPDATE_TAG_COLOR)
  ipcMain.removeHandler(TagsChannels.invoke.DELETE_TAG)
  ipcMain.removeHandler(TagsChannels.invoke.REMOVE_TAG_FROM_NOTE)
}
