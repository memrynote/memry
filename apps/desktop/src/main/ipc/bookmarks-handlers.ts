/**
 * Bookmarks IPC handlers.
 * Handles all bookmark-related IPC communication from renderer.
 *
 * @module ipc/bookmarks-handlers
 */

import { ipcMain, BrowserWindow } from 'electron'
import {
  BookmarksChannels,
  BookmarkItemTypes,
  BookmarkCreateSchema,
  BookmarkCheckSchema,
  BookmarkToggleSchema,
  BookmarkReorderSchema,
  BookmarkListSchema,
  BookmarkBulkDeleteSchema,
  BookmarkBulkCreateSchema,
  type Bookmark,
  type BookmarkWithItem,
  type BookmarkListResponse,
  type BookmarkItemMeta
} from '@memry/contracts/bookmarks-api'
import { bookmarkSyncId } from '@memry/contracts/bookmark-types'
import { createValidatedHandler, createStringHandler } from './validate'
import { requireDatabase, getIndexDatabase } from '../database'
import { bookmarkQueries, notesQueries, tasksQueries } from '../bookmarks/store'
import {
  enqueueBookmarkCreate,
  enqueueBookmarkDelete,
  enqueueBookmarkUpdate
} from '../bookmarks/runtime-effects'
import { getMainI18n } from '../lib/main-i18n'

/**
 * Emit bookmark event to all windows
 */
function emitBookmarkEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

/**
 * Helper to get index database for resolving note/journal titles
 */
function getIndexDb() {
  try {
    return getIndexDatabase()
  } catch {
    return null
  }
}

/**
 * Resolve item details for display in bookmark list
 */
function resolveBookmarkItem(bookmark: Bookmark): BookmarkWithItem {
  const indexDb = getIndexDb()
  const dataDb = requireDatabase()

  let itemTitle: string | null = null
  let itemExists = false
  let itemMeta: BookmarkItemMeta | undefined = undefined

  switch (bookmark.itemType) {
    case BookmarkItemTypes.NOTE:
    case BookmarkItemTypes.JOURNAL: {
      if (indexDb) {
        const note = notesQueries.getNoteCacheById(indexDb, bookmark.itemId)
        if (note) {
          itemTitle = note.title
          itemExists = true
          itemMeta = {
            path: note.path,
            emoji: note.emoji ?? undefined
          }
          // Get tags for the note
          const tags = notesQueries.getNoteTags(indexDb, bookmark.itemId)
          if (tags.length > 0) {
            itemMeta.tags = tags
          }
        }
      }
      break
    }

    case BookmarkItemTypes.TASK: {
      const task = tasksQueries.getTaskById(dataDb, bookmark.itemId)
      if (task) {
        itemTitle = task.title
        itemExists = true
        // Get tags for the task
        const tags = tasksQueries.getTaskTags(dataDb, bookmark.itemId)
        if (tags.length > 0) {
          itemMeta = { tags }
        }
      }
      break
    }

    case BookmarkItemTypes.FOLDER: {
      // Folder identity is its path; title is the last path segment.
      // ponytail: skip an existence check — a stale folder bookmark just opens
      // an empty folder view; add a check if dead links become a problem.
      const path = bookmark.itemId
      itemTitle = path.split('/').pop() || path
      itemExists = true
      itemMeta = { path }
      break
    }

    case BookmarkItemTypes.TAG: {
      // Tag identity is its name; no DB lookup needed.
      // ponytail: see FOLDER note re: existence check.
      itemTitle = bookmark.itemId
      itemExists = true
      break
    }

    // For future item types (image, pdf, audio, etc.)
    // We'll add resolution logic when those features are implemented
    default: {
      // For unknown types, mark as not existing (will show as orphan)
      // In the future, each new item type will have its own resolution logic
      itemExists = false
      itemTitle = null
    }
  }

  return {
    ...bookmark,
    itemTitle,
    itemExists,
    itemMeta
  }
}

/**
 * Build a BookmarkListResponse with resolved items
 */
function buildListResponse(
  bookmarks: Bookmark[],
  total: number,
  _limit: number,
  offset: number
): BookmarkListResponse {
  return {
    bookmarks: bookmarks.map(resolveBookmarkItem),
    total,
    hasMore: offset + bookmarks.length < total
  }
}

/**
 * Register all bookmark-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerBookmarksHandlers(): void {
  // ============================================================================
  // Bookmark CRUD
  // ============================================================================

  // bookmarks:create - Create a new bookmark
  ipcMain.handle(
    BookmarksChannels.invoke.CREATE,
    createValidatedHandler(BookmarkCreateSchema, (input) => {
      const db = requireDatabase()

      // Check if already bookmarked
      if (bookmarkQueries.isBookmarked(db, input.itemType, input.itemId)) {
        return {
          success: false,
          bookmark: null,
          error: getMainI18n().t('errors:bookmark.alreadyBookmarked')
        }
      }

      const id = bookmarkSyncId(input.itemType, input.itemId)
      const position = bookmarkQueries.getNextBookmarkPosition(db)

      const bookmark = bookmarkQueries.insertBookmark(db, {
        id,
        itemType: input.itemType,
        itemId: input.itemId,
        position
      })

      enqueueBookmarkCreate(id)

      emitBookmarkEvent(BookmarksChannels.events.CREATED, { bookmark })

      return { success: true, bookmark }
    })
  )

  // bookmarks:delete - Delete a bookmark by ID
  ipcMain.handle(
    BookmarksChannels.invoke.DELETE,
    createStringHandler((id) => {
      const db = requireDatabase()

      const bookmark = bookmarkQueries.getBookmarkById(db, id)
      if (!bookmark) {
        return { success: false, error: getMainI18n().t('errors:bookmark.notFound') }
      }

      bookmarkQueries.deleteBookmark(db, id)

      enqueueBookmarkDelete(id, bookmark)

      emitBookmarkEvent(BookmarksChannels.events.DELETED, {
        id,
        itemType: bookmark.itemType,
        itemId: bookmark.itemId
      })

      return { success: true }
    })
  )

  // bookmarks:get - Get a bookmark by ID
  ipcMain.handle(
    BookmarksChannels.invoke.GET,
    createStringHandler((id) => {
      const db = requireDatabase()
      return bookmarkQueries.getBookmarkById(db, id) ?? null
    })
  )

  // bookmarks:list - List bookmarks with optional filters
  ipcMain.handle(
    BookmarksChannels.invoke.LIST,
    createValidatedHandler(BookmarkListSchema, (input) => {
      const db = requireDatabase()

      const bookmarks = bookmarkQueries.listBookmarks(db, {
        itemType: input.itemType,
        sortBy: input.sortBy,
        sortOrder: input.sortOrder,
        limit: input.limit,
        offset: input.offset
      })

      const total = bookmarkQueries.countBookmarks(db, input.itemType)

      return buildListResponse(bookmarks, total, input.limit, input.offset)
    })
  )

  // ============================================================================
  // Quick Operations
  // ============================================================================

  // bookmarks:is-bookmarked - Check if an item is bookmarked
  ipcMain.handle(
    BookmarksChannels.invoke.IS_BOOKMARKED,
    createValidatedHandler(BookmarkCheckSchema, (input) => {
      const db = requireDatabase()
      return bookmarkQueries.isBookmarked(db, input.itemType, input.itemId)
    })
  )

  // bookmarks:toggle - Toggle bookmark status (create or delete)
  ipcMain.handle(
    BookmarksChannels.invoke.TOGGLE,
    createValidatedHandler(BookmarkToggleSchema, (input) => {
      const db = requireDatabase()

      // Capture existing bookmark BEFORE toggle (since toggle deletes it)
      const existing = bookmarkQueries.getBookmarkByItem(db, input.itemType, input.itemId)

      const result = bookmarkQueries.toggleBookmark(db, input.itemType, input.itemId, () =>
        bookmarkSyncId(input.itemType, input.itemId)
      )

      // Emit appropriate event
      if (result.isBookmarked && result.bookmark) {
        enqueueBookmarkCreate(result.bookmark.id)
        emitBookmarkEvent(BookmarksChannels.events.CREATED, { bookmark: result.bookmark })
      } else if (existing) {
        // Use the 'existing' we captured before toggle deleted it
        enqueueBookmarkDelete(existing.id, existing)
        emitBookmarkEvent(BookmarksChannels.events.DELETED, {
          id: existing.id,
          itemType: input.itemType,
          itemId: input.itemId
        })
      }

      return {
        success: true,
        isBookmarked: result.isBookmarked,
        bookmark: result.bookmark
      }
    })
  )

  // bookmarks:get-by-item - Get bookmark for a specific item
  ipcMain.handle(
    BookmarksChannels.invoke.GET_BY_ITEM,
    createValidatedHandler(BookmarkCheckSchema, (input) => {
      const db = requireDatabase()
      return bookmarkQueries.getBookmarkByItem(db, input.itemType, input.itemId) ?? null
    })
  )

  // ============================================================================
  // Organization
  // ============================================================================

  // bookmarks:reorder - Reorder bookmarks
  ipcMain.handle(
    BookmarksChannels.invoke.REORDER,
    createValidatedHandler(BookmarkReorderSchema, (input) => {
      const db = requireDatabase()
      bookmarkQueries.reorderBookmarks(db, input.bookmarkIds)

      input.bookmarkIds.forEach((id) => {
        enqueueBookmarkUpdate(id)
      })

      emitBookmarkEvent(BookmarksChannels.events.REORDERED, {
        bookmarkIds: input.bookmarkIds
      })

      return { success: true }
    })
  )

  // bookmarks:list-by-type - List bookmarks by item type
  ipcMain.handle(
    BookmarksChannels.invoke.LIST_BY_TYPE,
    createStringHandler((itemType) => {
      const db = requireDatabase()

      const bookmarks = bookmarkQueries.listBookmarksByType(db, itemType)
      const total = bookmarkQueries.countBookmarks(db, itemType)

      return buildListResponse(bookmarks, total, 1000, 0)
    })
  )

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  // bookmarks:bulk-delete - Delete multiple bookmarks
  ipcMain.handle(
    BookmarksChannels.invoke.BULK_DELETE,
    createValidatedHandler(BookmarkBulkDeleteSchema, (input) => {
      const db = requireDatabase()

      // Capture snapshots BEFORE deleting: enqueueBookmarkDelete no-ops without one.
      const bookmarksToDelete = input.bookmarkIds.flatMap((id) => {
        const bookmark = bookmarkQueries.getBookmarkById(db, id)
        return bookmark ? [bookmark] : []
      })

      const deletedCount = bookmarkQueries.bulkDeleteBookmarks(db, input.bookmarkIds)

      bookmarksToDelete.forEach((bookmark) => {
        enqueueBookmarkDelete(bookmark.id, bookmark)
      })

      // Emit event for each deleted bookmark
      // (In a real scenario, you might want a bulk event instead)
      input.bookmarkIds.forEach((id) => {
        emitBookmarkEvent(BookmarksChannels.events.DELETED, { id, itemType: '', itemId: '' })
      })

      return { success: true, deletedCount }
    })
  )

  // bookmarks:bulk-create - Create multiple bookmarks
  ipcMain.handle(
    BookmarksChannels.invoke.BULK_CREATE,
    createValidatedHandler(BookmarkBulkCreateSchema, (input) => {
      const db = requireDatabase()
      const createdBookmarks = bookmarkQueries.bulkCreateBookmarks(db, input.items, bookmarkSyncId)

      createdBookmarks.forEach((bookmark) => {
        enqueueBookmarkCreate(bookmark.id)
      })

      return { success: true, createdCount: createdBookmarks.length }
    })
  )
}

/**
 * Unregister all bookmark-related IPC handlers.
 */
export function unregisterBookmarksHandlers(): void {
  ipcMain.removeHandler(BookmarksChannels.invoke.CREATE)
  ipcMain.removeHandler(BookmarksChannels.invoke.DELETE)
  ipcMain.removeHandler(BookmarksChannels.invoke.GET)
  ipcMain.removeHandler(BookmarksChannels.invoke.LIST)
  ipcMain.removeHandler(BookmarksChannels.invoke.IS_BOOKMARKED)
  ipcMain.removeHandler(BookmarksChannels.invoke.TOGGLE)
  ipcMain.removeHandler(BookmarksChannels.invoke.REORDER)
  ipcMain.removeHandler(BookmarksChannels.invoke.LIST_BY_TYPE)
  ipcMain.removeHandler(BookmarksChannels.invoke.GET_BY_ITEM)
  ipcMain.removeHandler(BookmarksChannels.invoke.BULK_DELETE)
  ipcMain.removeHandler(BookmarksChannels.invoke.BULK_CREATE)
}
