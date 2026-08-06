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
  UpdateTagIconSchema,
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
import {
  createValidatedHandler,
  createStringHandler,
  createHandler,
  withErrorHandler
} from './validate'
import { requireDatabase, getIndexDatabase } from '../database'
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
  updateTagIcon,
  getNoteTags,
  getNoteCacheById
} from '../tags/store'
import {
  getAllTagsWithCounts,
  mergeTagInNotes,
  mergeTagInTasks,
  listTagCategories,
  createTagCategory,
  renameTagCategory,
  deleteTagCategory,
  reorderTags,
  reorderCategories,
  type TagAssignment
} from '../tags/store'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { trackMainEvent } from '../telemetry/track'
import { toAbsolutePath } from '../vault/notes'
import { parseNote, serializeParsedNote } from '../vault/frontmatter'
import { atomicWrite } from '../vault/file-ops'
import {
  syncMergedTagDefinitions,
  syncTaggedNote,
  syncTaggedTasks,
  syncTagDefinitionDelete,
  syncTagDefinitionRename,
  syncTagDefinitionUpdate,
  syncTagCategoryCreate,
  syncTagCategoryUpdate,
  syncTagCategoryDelete
} from '../tags/runtime-effects'
import { getMainI18n } from '../lib/main-i18n'

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
 * Extract a safe, user-facing message from an error, never leaking a raw error object.
 */
function extractErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * Helper to get index database, throwing a user-friendly error if not available.
 */
function requireIndexDatabase() {
  try {
    return getIndexDatabase()
  } catch {
    throw new Error(getMainI18n().t('errors:ipc.noVaultOpen'))
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

  const serialized = serializeParsedNote(parsed, parsed.content, { frontmatterEdited: true })
  if (serialized !== raw) {
    await atomicWrite(absolutePath, serialized)
  }
  syncTaggedNote(noteId)
}

/**
 * Register all tags IPC handlers.
 */
export function registerTagsHandlers(): void {
  // tags:get-notes-by-tag - Get notes for a specific tag with pinned status
  ipcMain.handle(
    TagsChannels.invoke.GET_NOTES_BY_TAG,
    createValidatedHandler(GetNotesByTagSchema, (input) => {
      try {
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
      } catch (error) {
        // Rethrow untouched: the renderer treats the rejected invoke as its
        // error state. Telemetry only — this path had no app_error_seen at all.
        trackMainError('tags', 'get_notes_by_tag', error)
        throw error
      }
    })
  )

  // tags:pin-note-to-tag - Pin a note to a tag
  ipcMain.handle(
    TagsChannels.invoke.PIN_NOTE_TO_TAG,
    createValidatedHandler(
      PinNoteToTagSchema,
      withErrorHandler((input) => {
        const db = requireIndexDatabase()
        pinNoteToTag(db, input.noteId, input.tag)

        emitTagEvent(TagsChannels.events.NOTES_CHANGED, {
          tag: input.tag,
          noteId: input.noteId,
          action: 'pinned'
        })

        return { success: true } as TagOperationResponse
      }, 'errors:tag.pinNoteFailed')
    )
  )

  // tags:unpin-note-from-tag - Unpin a note from a tag
  ipcMain.handle(
    TagsChannels.invoke.UNPIN_NOTE_FROM_TAG,
    createValidatedHandler(
      UnpinNoteFromTagSchema,
      withErrorHandler((input) => {
        const db = requireIndexDatabase()
        unpinNoteFromTag(db, input.noteId, input.tag)

        emitTagEvent(TagsChannels.events.NOTES_CHANGED, {
          tag: input.tag,
          noteId: input.noteId,
          action: 'unpinned'
        })

        return { success: true } as TagOperationResponse
      }, 'errors:tag.unpinNoteFailed')
    )
  )

  // tags:rename - Rename a tag across all notes
  ipcMain.handle(
    TagsChannels.invoke.RENAME_TAG,
    createValidatedHandler(
      RenameTagSchema,
      withErrorHandler(async (input) => {
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

        syncTagDefinitionRename(input.oldName, input.newName, oldTagSnapshot)

        const normalizedOld = input.oldName.toLowerCase().trim()
        const trimmedNew = input.newName.trim()
        await Promise.all(
          noteIds.map((noteId) =>
            updateNoteFrontmatterTag(indexDb, noteId, (tags) =>
              tags.map((t) => (t.toLowerCase() === normalizedOld ? trimmedNew : t))
            ).catch((err) => {
              log.warn('Failed to update frontmatter for note', { noteId, err })
              // DB and vault file now diverge silently; must reach Error Tracking.
              trackMainError('tags', 'frontmatter_writeback', err)
            })
          )
        )

        emitTagEvent(TagsChannels.events.RENAMED, {
          oldName: input.oldName,
          newName: input.newName,
          affectedNotes
        })
        emitTagEvent('notes:tags-changed', {})

        trackMainEvent('tag_renamed', {
          surface: 'tags',
          action: 'renamed',
          objectType: 'tag',
          result: 'success',
          metrics: { itemCount: affectedNotes }
        })

        return { success: true, affectedNotes } as RenameTagResponse
      }, 'errors:tag.renameFailed')
    )
  )

  // tags:update-color - Update tag color
  ipcMain.handle(
    TagsChannels.invoke.UPDATE_TAG_COLOR,
    createValidatedHandler(
      UpdateTagColorSchema,
      withErrorHandler((input) => {
        const dataDb = requireDatabase()
        getOrCreateTag(dataDb, input.tag)
        updateTagColor(dataDb, input.tag, input.color)
        syncTagDefinitionUpdate(input.tag)

        emitTagEvent(TagsChannels.events.COLOR_UPDATED, {
          tag: input.tag,
          color: input.color
        })

        emitTagEvent('notes:tags-changed', {})

        return { success: true } as TagOperationResponse
      }, 'errors:tag.updateColorFailed')
    )
  )

  // tags:update-icon - Update tag icon (raw emoji or "icon:Name", null clears)
  ipcMain.handle(
    TagsChannels.invoke.UPDATE_TAG_ICON,
    createValidatedHandler(
      UpdateTagIconSchema,
      withErrorHandler((input) => {
        const dataDb = requireDatabase()
        getOrCreateTag(dataDb, input.tag)
        updateTagIcon(dataDb, input.tag, input.icon)
        syncTagDefinitionUpdate(input.tag)

        emitTagEvent('notes:tags-changed', {})

        return { success: true } as TagOperationResponse
      }, 'errors:tag.updateIconFailed')
    )
  )

  // tags:delete - Delete a tag from all notes
  ipcMain.handle(
    TagsChannels.invoke.DELETE_TAG,
    createStringHandler(
      withErrorHandler(async (tag: string) => {
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

        syncTagDefinitionDelete(normalizedTag, tagSnapshot)
        await Promise.all(
          noteIds.map((noteId) =>
            updateNoteFrontmatterTag(indexDb, noteId, (tags) =>
              tags.filter((t) => t.toLowerCase() !== normalizedTag)
            ).catch((err) => {
              log.warn('Failed to update frontmatter for note', { noteId, err })
              trackMainError('tags', 'frontmatter_writeback', err)
            })
          )
        )

        emitTagEvent(TagsChannels.events.DELETED, { tag, affectedNotes })
        emitTagEvent('notes:tags-changed', {})

        trackMainEvent('tag_deleted', {
          surface: 'tags',
          action: 'deleted',
          objectType: 'tag',
          result: 'success',
          metrics: { itemCount: affectedNotes }
        })

        return { success: true, affectedNotes } as DeleteTagResponse
      }, 'errors:tag.deleteFailed')
    )
  )

  // tags:remove-from-note - Remove tag from a specific note
  ipcMain.handle(
    TagsChannels.invoke.REMOVE_TAG_FROM_NOTE,
    createValidatedHandler(
      RemoveTagFromNoteSchema,
      withErrorHandler(async (input) => {
        const db = requireIndexDatabase()
        removeTagFromNote(db, input.noteId, input.tag)

        const normalizedTag = input.tag.toLowerCase().trim()
        await updateNoteFrontmatterTag(db, input.noteId, (tags) =>
          tags.filter((t) => t.toLowerCase() !== normalizedTag)
        ).catch((err) => {
          log.warn('Failed to update frontmatter for note', { noteId: input.noteId, err })
          trackMainError('tags', 'frontmatter_writeback', err)
        })

        emitTagEvent(TagsChannels.events.NOTES_CHANGED, {
          tag: input.tag,
          noteId: input.noteId,
          action: 'removed'
        })
        emitTagEvent('notes:tags-changed', {})

        return { success: true } as TagOperationResponse
      }, 'errors:tag.removeFromNoteFailed')
    )
  )

  // tags:get-all-with-counts - Aggregate tags from notes + tasks
  ipcMain.handle(
    TagsChannels.invoke.GET_ALL_WITH_COUNTS,
    createHandler((): GetAllWithCountsResponse => {
      try {
        const indexDb = requireIndexDatabase()
        const dataDb = requireDatabase()
        return { tags: getAllTagsWithCounts(indexDb, dataDb) }
      } catch (error) {
        // Rethrow untouched: the renderer treats the rejected invoke as its
        // error state. Telemetry only — this handler also writes (tag cleanup
        // inside getAllTagsWithCounts), so a mid-cleanup failure must surface.
        trackMainError('tags', 'get_all_with_counts', error)
        throw error
      }
    })
  )

  // tags:merge - Merge source tag into target (deduplicate across notes + tasks)
  ipcMain.handle(
    TagsChannels.invoke.MERGE_TAG,
    createValidatedHandler(
      MergeTagSchema,
      withErrorHandler(async (input): Promise<MergeTagResponse> => {
        const indexDb = requireIndexDatabase()
        const dataDb = requireDatabase()

        const normalizedSource = input.source.toLowerCase().trim()
        const trimmedTarget = input.target.trim()
        const normalizedTarget = trimmedTarget.toLowerCase()

        if (normalizedSource === normalizedTarget) {
          return { success: false, error: getMainI18n().t('errors:tag.mergeSameTag') }
        }

        const noteResult = mergeTagInNotes(indexDb, input.source, input.target)
        const taskResult = mergeTagInTasks(dataDb, input.source, input.target)

        const sourceSnapshot = dataDb
          .select()
          .from(tagDefinitions)
          .where(eq(tagDefinitions.name, normalizedSource))
          .get()

        deleteTagDefinition(dataDb, normalizedSource)
        getOrCreateTag(dataDb, normalizedTarget)

        syncMergedTagDefinitions(normalizedSource, normalizedTarget, sourceSnapshot)

        await Promise.all(
          noteResult.noteIds.map((noteId) =>
            updateNoteFrontmatterTag(indexDb, noteId, (tags) => {
              const withoutSource = tags.filter((t) => t.toLowerCase() !== normalizedSource)
              const hasTarget = withoutSource.some((t) => t.toLowerCase() === normalizedTarget)
              return hasTarget ? withoutSource : [...withoutSource, trimmedTarget]
            }).catch((err) => {
              log.warn('Failed to update frontmatter for note during merge', { noteId, err })
              trackMainError('tags', 'frontmatter_writeback', err)
            })
          )
        )

        syncTaggedTasks(taskResult.taskIds)

        emitTagEvent(TagsChannels.events.DELETED, {
          tag: normalizedSource,
          affectedNotes: noteResult.affected
        })
        emitTagEvent('notes:tags-changed', {})

        trackMainEvent('tag_merged', {
          surface: 'tags',
          action: 'merged',
          objectType: 'tag',
          result: 'success',
          metrics: { itemCount: noteResult.affected + taskResult.affected }
        })

        return {
          success: true,
          affectedItems: noteResult.affected + taskResult.affected
        }
      }, 'errors:tag.mergeFailed')
    )
  )

  // tags:list-categories - List tag categories with their tag counts
  ipcMain.handle(TagsChannels.invoke.LIST_CATEGORIES, () => {
    try {
      return { success: true, categories: listTagCategories(requireDatabase()) }
    } catch (error) {
      log.error('Failed to list tag categories', error)
      trackMainError('tags', 'category_list', error)
      return {
        success: false,
        error: extractErrorMessage(error, getMainI18n().t('errors:tag.listCategoriesFailed'))
      }
    }
  })

  // tags:create-category - Create a tag category
  ipcMain.handle(TagsChannels.invoke.CREATE_CATEGORY, (_e, { name }: { name: string }) => {
    try {
      if (!name?.trim())
        return { success: false, error: getMainI18n().t('errors:tag.categoryNameRequired') }
      const category = createTagCategory(requireDatabase(), name)
      syncTagCategoryCreate(category.id)
      emitTagEvent(TagsChannels.events.CATEGORIES_CHANGED, { categoryId: category.id })
      trackMainEvent('tag_category_created', {
        surface: 'tags',
        action: 'created',
        objectType: 'tag_category',
        result: 'success'
      })
      return { success: true, category }
    } catch (error) {
      log.error('Failed to create tag category', error)
      trackMainError('tags', 'category_create', error)
      return {
        success: false,
        error: extractErrorMessage(error, getMainI18n().t('errors:tag.createCategoryFailed'))
      }
    }
  })

  // tags:rename-category - Rename a tag category
  ipcMain.handle(
    TagsChannels.invoke.RENAME_CATEGORY,
    (_e, { id, name }: { id: string; name: string }) => {
      try {
        if (!name?.trim())
          return { success: false, error: getMainI18n().t('errors:tag.categoryNameRequired') }
        renameTagCategory(requireDatabase(), id, name)
        syncTagCategoryUpdate(id)
        emitTagEvent(TagsChannels.events.CATEGORIES_CHANGED, { categoryId: id })
        return { success: true }
      } catch (error) {
        log.error('Failed to rename tag category', error)
        trackMainError('tags', 'category_rename', error)
        return {
          success: false,
          error: extractErrorMessage(error, getMainI18n().t('errors:tag.renameCategoryFailed'))
        }
      }
    }
  )

  // tags:delete-category - Delete a tag category (its tags become uncategorized)
  ipcMain.handle(TagsChannels.invoke.DELETE_CATEGORY, (_e, { id }: { id: string }) => {
    try {
      deleteTagCategory(requireDatabase(), id)
      syncTagCategoryDelete(id)
      emitTagEvent(TagsChannels.events.CATEGORIES_CHANGED, { categoryId: id })
      return { success: true }
    } catch (error) {
      log.error('Failed to delete tag category', error)
      trackMainError('tags', 'category_delete', error)
      return {
        success: false,
        error: extractErrorMessage(error, getMainI18n().t('errors:tag.deleteCategoryFailed'))
      }
    }
  })

  // tags:reorder - Apply a drag result: tag assignments and/or category order, in one transaction
  ipcMain.handle(
    TagsChannels.invoke.REORDER,
    (
      _e,
      {
        tags,
        categories
      }: { tags?: TagAssignment[]; categories?: { id: string; sortOrder: number }[] }
    ) => {
      try {
        const dataDb = requireDatabase()

        if (tags?.length) {
          reorderTags(dataDb, tags)
          for (const assignment of tags) {
            syncTagDefinitionUpdate(assignment.tag.toLowerCase().trim())
          }
        }

        if (categories?.length) {
          reorderCategories(dataDb, categories)
          for (const category of categories) {
            syncTagCategoryUpdate(category.id)
          }
        }

        emitTagEvent(TagsChannels.events.CATEGORIES_CHANGED, {})
        return { success: true }
      } catch (error) {
        log.error('Failed to reorder tag categories', error)
        trackMainError('tags', 'reorder', error)
        return {
          success: false,
          error: extractErrorMessage(error, getMainI18n().t('errors:tag.reorderFailed'))
        }
      }
    }
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
  ipcMain.removeHandler(TagsChannels.invoke.UPDATE_TAG_ICON)
  ipcMain.removeHandler(TagsChannels.invoke.DELETE_TAG)
  ipcMain.removeHandler(TagsChannels.invoke.REMOVE_TAG_FROM_NOTE)
  ipcMain.removeHandler(TagsChannels.invoke.GET_ALL_WITH_COUNTS)
  ipcMain.removeHandler(TagsChannels.invoke.MERGE_TAG)
  ipcMain.removeHandler(TagsChannels.invoke.LIST_CATEGORIES)
  ipcMain.removeHandler(TagsChannels.invoke.CREATE_CATEGORY)
  ipcMain.removeHandler(TagsChannels.invoke.RENAME_CATEGORY)
  ipcMain.removeHandler(TagsChannels.invoke.DELETE_CATEGORY)
  ipcMain.removeHandler(TagsChannels.invoke.REORDER)
}
