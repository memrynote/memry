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
  MergeTagSchema,
  type TagNoteItem,
  type GetNotesByTagResponse,
  type GetAllWithCountsResponse,
  type MergeTagResponse,
  type TagOperationResponse,
  type RenameTagResponse,
  type DeleteTagResponse
} from '@memry/contracts/tags-api'
import { noteTags } from '@memry/db-schema/schema/notes-cache'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { createValidatedHandler, createStringHandler, createHandler, withErrorHandler } from './validate'
import { getDatabase, getIndexDatabase } from '../database'
import {
  findNotesWithTagInfo,
  pinNoteToTag,
  unpinNoteFromTag,
  renameTag,
  deleteTag,
  removeTagFromNote,
  getOrCreateTag,
  deleteTagDefinition,
  renameTagDefinition,
  updateTagColor,
  getNoteTags,
  getNoteCacheById
} from '@main/database/queries/notes'
import { getAllTagsWithCounts, mergeTagInNotes, mergeTagInTasks } from '@main/database/queries/tags'
import { createLogger } from '../lib/logger'
import { toAbsolutePath } from '../vault/notes'
import { parseNote, serializeNote } from '../vault/frontmatter'
import { atomicWrite } from '../vault/file-ops'
import { getNoteSyncService } from '../sync/note-sync'
import { getTagDefinitionSyncService } from '../sync/tag-definition-sync'
import { getTaskSyncService } from '../sync/task-sync'

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

      const notes = findNotesWithTagInfo(indexDb, input.tag, {
        sortBy: input.sortBy,
        sortOrder: input.sortOrder,
        includeDescendants: input.includeDescendants
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
    createValidatedHandler(PinNoteToTagSchema, withErrorHandler((input) => {
      const db = requireIndexDatabase()
      pinNoteToTag(db, input.noteId, input.tag)

      emitTagEvent(TagsChannels.events.NOTES_CHANGED, {
        tag: input.tag,
        noteId: input.noteId,
        action: 'pinned'
      })

      return { success: true } as TagOperationResponse
    }, 'Failed to pin note'))
  )

  // tags:unpin-note-from-tag - Unpin a note from a tag
  ipcMain.handle(
    TagsChannels.invoke.UNPIN_NOTE_FROM_TAG,
    createValidatedHandler(UnpinNoteFromTagSchema, withErrorHandler((input) => {
      const db = requireIndexDatabase()
      unpinNoteFromTag(db, input.noteId, input.tag)

      emitTagEvent(TagsChannels.events.NOTES_CHANGED, {
        tag: input.tag,
        noteId: input.noteId,
        action: 'unpinned'
      })

      return { success: true } as TagOperationResponse
    }, 'Failed to unpin note'))
  )

  // tags:rename - Rename a tag across all notes
  ipcMain.handle(
    TagsChannels.invoke.RENAME_TAG,
    createValidatedHandler(RenameTagSchema, withErrorHandler(async (input) => {
      const indexDb = requireIndexDatabase()
      const dataDb = requireDatabase()

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
    }, 'Failed to rename tag'))
  )

  // tags:update-color - Update tag color
  ipcMain.handle(
    TagsChannels.invoke.UPDATE_TAG_COLOR,
    createValidatedHandler(UpdateTagColorSchema, withErrorHandler((input) => {
      const dataDb = requireDatabase()
      getOrCreateTag(dataDb, input.tag)
      updateTagColor(dataDb, input.tag, input.color)
      getTagDefinitionSyncService()?.enqueueUpdate(input.tag)

      emitTagEvent(TagsChannels.events.COLOR_UPDATED, {
        tag: input.tag,
        color: input.color
      })

      emitTagEvent('notes:tags-changed', {})

      return { success: true } as TagOperationResponse
    }, 'Failed to update tag color'))
  )

  // tags:delete - Delete a tag from all notes
  ipcMain.handle(
    TagsChannels.invoke.DELETE_TAG,
    createStringHandler(withErrorHandler(async (tag: string) => {
      const indexDb = requireIndexDatabase()
      const dataDb = requireDatabase()

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
    }, 'Failed to delete tag'))
  )

  // tags:remove-from-note - Remove tag from a specific note
  ipcMain.handle(
    TagsChannels.invoke.REMOVE_TAG_FROM_NOTE,
    createValidatedHandler(RemoveTagFromNoteSchema, withErrorHandler(async (input) => {
      const db = requireIndexDatabase()
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
    }, 'Failed to remove tag from note'))
  )

  // tags:get-all-with-counts - Aggregate tags from notes + tasks
  ipcMain.handle(
    TagsChannels.invoke.GET_ALL_WITH_COUNTS,
    createHandler((): GetAllWithCountsResponse => {
      const indexDb = requireIndexDatabase()
      const dataDb = requireDatabase()
      return { tags: getAllTagsWithCounts(indexDb, dataDb) }
    })
  )

  // tags:merge - Merge source tag into target (deduplicate across notes + tasks)
  ipcMain.handle(
    TagsChannels.invoke.MERGE_TAG,
    createValidatedHandler(MergeTagSchema, withErrorHandler(async (input): Promise<MergeTagResponse> => {
      const indexDb = requireIndexDatabase()
      const dataDb = requireDatabase()

      const normalizedSource = input.source.toLowerCase().trim()
      const normalizedTarget = input.target.toLowerCase().trim()

      if (normalizedSource === normalizedTarget) {
        return { success: false, error: 'Source and target tags are the same' }
      }

      const noteResult = mergeTagInNotes(indexDb, normalizedSource, normalizedTarget)
      const taskResult = mergeTagInTasks(dataDb, normalizedSource, normalizedTarget)

      const sourceSnapshot = dataDb
        .select()
        .from(tagDefinitions)
        .where(eq(tagDefinitions.name, normalizedSource))
        .get()

      deleteTagDefinition(dataDb, normalizedSource)
      getOrCreateTag(dataDb, normalizedTarget)

      const syncService = getTagDefinitionSyncService()
      if (syncService && sourceSnapshot) {
        syncService.enqueueDelete(normalizedSource, JSON.stringify(sourceSnapshot))
        syncService.enqueueCreate(normalizedTarget)
      }

      await Promise.all(
        noteResult.noteIds.map((noteId) =>
          updateNoteFrontmatterTag(indexDb, noteId, (tags) => {
            const withoutSource = tags.filter((t) => t.toLowerCase() !== normalizedSource)
            const hasTarget = withoutSource.some((t) => t.toLowerCase() === normalizedTarget)
            return hasTarget ? withoutSource : [...withoutSource, normalizedTarget]
          }).catch((err) =>
            log.warn('Failed to update frontmatter for note during merge', { noteId, err })
          )
        )
      )

      const taskSyncService = getTaskSyncService()
      if (taskSyncService) {
        for (const taskId of taskResult.taskIds) {
          taskSyncService.enqueueUpdate(taskId)
        }
      }

      emitTagEvent(TagsChannels.events.DELETED, {
        tag: normalizedSource,
        affectedNotes: noteResult.affected
      })
      emitTagEvent('notes:tags-changed', {})

      return {
        success: true,
        affectedItems: noteResult.affected + taskResult.affected
      }
    }, 'Failed to merge tags'))
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
  ipcMain.removeHandler(TagsChannels.invoke.GET_ALL_WITH_COUNTS)
  ipcMain.removeHandler(TagsChannels.invoke.MERGE_TAG)
}
