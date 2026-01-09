/**
 * Bookmarks IPC handlers.
 * Handles all bookmark-related IPC communication from renderer.
 *
 * @module ipc/bookmarks-handlers
 */

import { ipcMain, BrowserWindow } from 'electron'
import { BookmarksChannels } from '@shared/ipc-channels'
import {
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
} from '@shared/contracts/bookmarks-api'
import { BookmarkItemTypes } from '@shared/db/schema/bookmarks'
import { createValidatedHandler, createStringHandler } from './validate'
import { getDatabase, getIndexDatabase } from '../database'
import { generateId } from '../lib/id'
import * as bookmarkQueries from '@shared/db/queries/bookmarks'
import * as notesQueries from '@shared/db/queries/notes'
import * as tasksQueries from '@shared/db/queries/tasks'

/**
 * Emit bookmark event to all windows
 */
function emitBookmarkEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
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
          error: 'Item is already bookmarked'
        }
      }

      const id = generateId()
      const position = bookmarkQueries.getNextBookmarkPosition(db)

      const bookmark = bookmarkQueries.insertBookmark(db, {
        id,
        itemType: input.itemType,
        itemId: input.itemId,
        position
      })

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
        return { success: false, error: 'Bookmark not found' }
      }

      bookmarkQueries.deleteBookmark(db, id)

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

      const result = bookmarkQueries.toggleBookmark(db, input.itemType, input.itemId, generateId)

      // Emit appropriate event
      if (result.isBookmarked && result.bookmark) {
        emitBookmarkEvent(BookmarksChannels.events.CREATED, { bookmark: result.bookmark })
      } else {
        const existing = bookmarkQueries.getBookmarkByItem(db, input.itemType, input.itemId)
        if (existing) {
          emitBookmarkEvent(BookmarksChannels.events.DELETED, {
            id: existing.id,
            itemType: input.itemType,
            itemId: input.itemId
          })
        }
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
      const deletedCount = bookmarkQueries.bulkDeleteBookmarks(db, input.bookmarkIds)

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
      const createdCount = bookmarkQueries.bulkCreateBookmarks(db, input.items, generateId)

      return { success: true, createdCount }
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
