/**
 * Bookmarks IPC handlers tests
 *
 * @module ipc/bookmarks-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { BookmarksChannels, BookmarkItemTypes } from '@memry/contracts/bookmarks-api'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []
const mockSend = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send: mockSend } }])
  }
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

vi.mock('@main/database/queries/bookmarks', () => ({
  isBookmarked: vi.fn(),
  getNextBookmarkPosition: vi.fn(),
  insertBookmark: vi.fn(),
  getBookmarkById: vi.fn(),
  deleteBookmark: vi.fn(),
  listBookmarks: vi.fn(),
  countBookmarks: vi.fn(),
  toggleBookmark: vi.fn(),
  getBookmarkByItem: vi.fn(),
  reorderBookmarks: vi.fn(),
  listBookmarksByType: vi.fn(),
  bulkDeleteBookmarks: vi.fn(),
  bulkCreateBookmarks: vi.fn()
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: vi.fn(),
  getNoteTags: vi.fn()
}))

vi.mock('@main/database/queries/tasks', () => ({
  getTaskById: vi.fn(),
  getTaskTags: vi.fn()
}))

import { registerBookmarksHandlers, unregisterBookmarksHandlers } from './bookmarks-handlers'
import { getDatabase, requireDatabase, getIndexDatabase } from '../database'
import * as bookmarkQueries from '@main/database/queries/bookmarks'
import * as notesQueries from '@main/database/queries/notes'
import * as tasksQueries from '@main/database/queries/tasks'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

describe('bookmarks-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    mockSend.mockClear()
    ;(getDatabase as Mock).mockReturnValue({})
    ;(requireDatabase as Mock).mockReturnValue({})
    ;(getIndexDatabase as Mock).mockReturnValue({})
  })

  afterEach(() => {
    unregisterBookmarksHandlers()
  })

  it('creates and deletes bookmarks with events', async () => {
    registerBookmarksHandlers()
    ;(bookmarkQueries.isBookmarked as Mock).mockReturnValue(false)
    ;(bookmarkQueries.getNextBookmarkPosition as Mock).mockReturnValue(0)
    ;(bookmarkQueries.insertBookmark as Mock).mockReturnValue({
      id: 'bookmark-1',
      itemType: BookmarkItemTypes.NOTE,
      itemId: 'note-1',
      position: 0
    })

    const createResult = await invokeHandler(BookmarksChannels.invoke.CREATE, {
      itemType: BookmarkItemTypes.NOTE,
      itemId: 'note-1'
    })
    expect(createResult.success).toBe(true)
    expect(mockSend).toHaveBeenCalledWith(
      BookmarksChannels.events.CREATED,
      expect.objectContaining({ bookmark: expect.objectContaining({ id: 'bookmark-1' }) })
    )
    ;(bookmarkQueries.getBookmarkById as Mock).mockReturnValue({
      id: 'bookmark-1',
      itemType: BookmarkItemTypes.NOTE,
      itemId: 'note-1'
    })

    const deleteResult = await invokeHandler(BookmarksChannels.invoke.DELETE, 'bookmark-1')
    expect(deleteResult).toEqual({ success: true })
    expect(bookmarkQueries.deleteBookmark).toHaveBeenCalledWith({}, 'bookmark-1')
  })

  it('lists bookmarks with resolved item info', async () => {
    registerBookmarksHandlers()
    ;(bookmarkQueries.listBookmarks as Mock).mockReturnValue([
      { id: 'bookmark-1', itemType: BookmarkItemTypes.NOTE, itemId: 'note-1', position: 0 }
    ])
    ;(bookmarkQueries.countBookmarks as Mock).mockReturnValue(1)
    ;(notesQueries.getNoteCacheById as Mock).mockReturnValue({
      id: 'note-1',
      title: 'Note Title',
      path: 'notes/note.md',
      emoji: null
    })
    ;(notesQueries.getNoteTags as Mock).mockReturnValue(['tag-1'])

    const result = await invokeHandler(BookmarksChannels.invoke.LIST, {
      itemType: BookmarkItemTypes.NOTE,
      limit: 10,
      offset: 0
    })

    expect(result.bookmarks[0]).toEqual(
      expect.objectContaining({ itemTitle: 'Note Title', itemExists: true })
    )
  })

  it('toggles and reorders bookmarks, supports bulk operations', async () => {
    registerBookmarksHandlers()
    ;(bookmarkQueries.toggleBookmark as Mock).mockReturnValue({
      isBookmarked: true,
      bookmark: { id: 'bookmark-2', itemType: BookmarkItemTypes.TASK, itemId: 'task-1' }
    })

    const toggleResult = await invokeHandler(BookmarksChannels.invoke.TOGGLE, {
      itemType: BookmarkItemTypes.TASK,
      itemId: 'task-1'
    })
    expect(toggleResult).toEqual({
      success: true,
      isBookmarked: true,
      bookmark: { id: 'bookmark-2', itemType: BookmarkItemTypes.TASK, itemId: 'task-1' }
    })

    const reorderResult = await invokeHandler(BookmarksChannels.invoke.REORDER, {
      bookmarkIds: ['bookmark-2']
    })
    expect(reorderResult).toEqual({ success: true })
    expect(mockSend).toHaveBeenCalledWith(BookmarksChannels.events.REORDERED, {
      bookmarkIds: ['bookmark-2']
    })
    ;(bookmarkQueries.bulkDeleteBookmarks as Mock).mockReturnValue(2)
    const bulkDelete = await invokeHandler(BookmarksChannels.invoke.BULK_DELETE, {
      bookmarkIds: ['b1', 'b2']
    })
    expect(bulkDelete).toEqual({ success: true, deletedCount: 2 })
    ;(bookmarkQueries.bulkCreateBookmarks as Mock).mockReturnValue([
      { id: 'bookmark-3', itemType: BookmarkItemTypes.NOTE, itemId: 'note-1', position: 0 },
      { id: 'bookmark-4', itemType: BookmarkItemTypes.TASK, itemId: 'task-1', position: 1 }
    ])
    const bulkCreate = await invokeHandler(BookmarksChannels.invoke.BULK_CREATE, {
      items: [
        { itemType: BookmarkItemTypes.NOTE, itemId: 'note-1' },
        { itemType: BookmarkItemTypes.TASK, itemId: 'task-1' }
      ]
    })
    expect(bulkCreate).toEqual({ success: true, createdCount: 2 })
  })

  it('emits DELETED event when un-bookmarking via toggle', async () => {
    registerBookmarksHandlers()

    // Setup: bookmark exists before toggle
    const existingBookmark = {
      id: 'bookmark-to-remove',
      itemType: BookmarkItemTypes.NOTE,
      itemId: 'note-123',
      position: 0
    }
    ;(bookmarkQueries.getBookmarkByItem as Mock).mockReturnValue(existingBookmark)

    // Toggle returns isBookmarked: false (bookmark was removed)
    ;(bookmarkQueries.toggleBookmark as Mock).mockReturnValue({
      isBookmarked: false,
      bookmark: null
    })

    mockSend.mockClear()

    const toggleResult = await invokeHandler(BookmarksChannels.invoke.TOGGLE, {
      itemType: BookmarkItemTypes.NOTE,
      itemId: 'note-123'
    })

    expect(toggleResult).toEqual({
      success: true,
      isBookmarked: false,
      bookmark: null
    })

    // Verify DELETED event was emitted with correct data
    expect(mockSend).toHaveBeenCalledWith(BookmarksChannels.events.DELETED, {
      id: 'bookmark-to-remove',
      itemType: BookmarkItemTypes.NOTE,
      itemId: 'note-123'
    })
  })

  it('emits CREATED event when bookmarking via toggle', async () => {
    registerBookmarksHandlers()

    // Setup: no existing bookmark
    ;(bookmarkQueries.getBookmarkByItem as Mock).mockReturnValue(undefined)

    const newBookmark = {
      id: 'new-bookmark',
      itemType: BookmarkItemTypes.JOURNAL,
      itemId: 'j2026-01-13',
      position: 0
    }
    ;(bookmarkQueries.toggleBookmark as Mock).mockReturnValue({
      isBookmarked: true,
      bookmark: newBookmark
    })

    mockSend.mockClear()

    const toggleResult = await invokeHandler(BookmarksChannels.invoke.TOGGLE, {
      itemType: BookmarkItemTypes.JOURNAL,
      itemId: 'j2026-01-13'
    })

    expect(toggleResult).toEqual({
      success: true,
      isBookmarked: true,
      bookmark: newBookmark
    })

    // Verify CREATED event was emitted
    expect(mockSend).toHaveBeenCalledWith(BookmarksChannels.events.CREATED, {
      bookmark: newBookmark
    })
  })

  describe('bookmark sync enqueue', () => {
    it('creates bookmarks with a deterministic id', async () => {
      registerBookmarksHandlers()
      ;(bookmarkQueries.isBookmarked as Mock).mockReturnValue(false)
      ;(bookmarkQueries.getNextBookmarkPosition as Mock).mockReturnValue(0)
      ;(bookmarkQueries.insertBookmark as Mock).mockImplementation((_db, bookmark) => bookmark)

      const result = await invokeHandler(BookmarksChannels.invoke.CREATE, {
        itemType: BookmarkItemTypes.NOTE,
        itemId: 'note_1'
      })

      expect(result.bookmark?.id).toBe('bmk_note_note_1')
    })

    it('enqueues a create on bookmark create', async () => {
      registerBookmarksHandlers()
      ;(bookmarkQueries.isBookmarked as Mock).mockReturnValue(false)
      ;(bookmarkQueries.getNextBookmarkPosition as Mock).mockReturnValue(0)
      ;(bookmarkQueries.insertBookmark as Mock).mockImplementation((_db, bookmark) => bookmark)

      await invokeHandler(BookmarksChannels.invoke.CREATE, {
        itemType: BookmarkItemTypes.NOTE,
        itemId: 'note_1'
      })

      expect(enqueueLocalSyncCreate).toHaveBeenCalledWith('bookmark', 'bmk_note_note_1')
    })

    it('enqueues a delete with a snapshot payload on bookmark delete', async () => {
      registerBookmarksHandlers()
      const existingBookmark = {
        id: 'bmk_note_note_1',
        itemType: BookmarkItemTypes.NOTE,
        itemId: 'note_1',
        position: 0
      }
      ;(bookmarkQueries.getBookmarkById as Mock).mockReturnValue(existingBookmark)

      await invokeHandler(BookmarksChannels.invoke.DELETE, 'bmk_note_note_1')

      expect(enqueueLocalSyncDelete).toHaveBeenCalledWith(
        'bookmark',
        'bmk_note_note_1',
        JSON.stringify(existingBookmark)
      )
      // The snapshot must be read BEFORE the row is deleted — deleteBookmark
      // wipes the row, so fetching it after would enqueue an empty/undefined
      // snapshot and enqueueLocalSyncDelete would silently no-op. Pinning both
      // the order AND the call count: order alone doesn't catch a regression
      // that keeps the existing pre-delete fetch but adds a second, later
      // fetch and uses that one for the snapshot instead.
      expect(bookmarkQueries.getBookmarkById).toHaveBeenCalledTimes(1)
      expect((bookmarkQueries.getBookmarkById as Mock).mock.invocationCallOrder[0]).toBeLessThan(
        (bookmarkQueries.deleteBookmark as Mock).mock.invocationCallOrder[0]
      )
    })

    it('creates bookmarks with a deterministic id on the toggle create branch and enqueues a create', async () => {
      registerBookmarksHandlers()
      ;(bookmarkQueries.getBookmarkByItem as Mock).mockReturnValue(undefined)
      ;(bookmarkQueries.toggleBookmark as Mock).mockImplementation(
        (_db, itemType, itemId, generateId) => ({
          isBookmarked: true,
          bookmark: { id: generateId(), itemType, itemId, position: 0 }
        })
      )

      const result = await invokeHandler(BookmarksChannels.invoke.TOGGLE, {
        itemType: BookmarkItemTypes.NOTE,
        itemId: 'note_1'
      })

      expect(result.bookmark?.id).toBe('bmk_note_note_1')
      expect(enqueueLocalSyncCreate).toHaveBeenCalledWith('bookmark', 'bmk_note_note_1')
    })

    it('enqueues a delete with a snapshot payload on the toggle delete branch', async () => {
      registerBookmarksHandlers()
      const existingBookmark = {
        id: 'bmk_note_note_1',
        itemType: BookmarkItemTypes.NOTE,
        itemId: 'note_1',
        position: 0
      }
      ;(bookmarkQueries.getBookmarkByItem as Mock).mockReturnValue(existingBookmark)
      ;(bookmarkQueries.toggleBookmark as Mock).mockReturnValue({
        isBookmarked: false,
        bookmark: null
      })

      await invokeHandler(BookmarksChannels.invoke.TOGGLE, {
        itemType: BookmarkItemTypes.NOTE,
        itemId: 'note_1'
      })

      expect(enqueueLocalSyncDelete).toHaveBeenCalledWith(
        'bookmark',
        'bmk_note_note_1',
        JSON.stringify(existingBookmark)
      )
      // 'existing' must be captured BEFORE toggleBookmark runs — toggleBookmark
      // deletes the row internally, so fetching it after would see nothing.
      expect((bookmarkQueries.getBookmarkByItem as Mock).mock.invocationCallOrder[0]).toBeLessThan(
        (bookmarkQueries.toggleBookmark as Mock).mock.invocationCallOrder[0]
      )
    })

    it('enqueues an update per row on reorder', async () => {
      registerBookmarksHandlers()

      await invokeHandler(BookmarksChannels.invoke.REORDER, {
        bookmarkIds: ['bmk_note_note_2', 'bmk_note_note_1']
      })

      expect(enqueueLocalSyncUpdate).toHaveBeenCalledTimes(2)
      expect(enqueueLocalSyncUpdate).toHaveBeenNthCalledWith(1, 'bookmark', 'bmk_note_note_2')
      expect(enqueueLocalSyncUpdate).toHaveBeenNthCalledWith(2, 'bookmark', 'bmk_note_note_1')
    })

    it('creates bulk bookmarks with deterministic ids and enqueues a create per row', async () => {
      registerBookmarksHandlers()
      ;(bookmarkQueries.bulkCreateBookmarks as Mock).mockImplementation(
        (_db, items: Array<{ itemType: string; itemId: string }>, generateId) =>
          items.map((item, index) => ({
            id: generateId(item.itemType, item.itemId),
            itemType: item.itemType,
            itemId: item.itemId,
            position: index
          }))
      )

      const result = await invokeHandler(BookmarksChannels.invoke.BULK_CREATE, {
        items: [
          { itemType: BookmarkItemTypes.NOTE, itemId: 'note_1' },
          { itemType: BookmarkItemTypes.TASK, itemId: 'task_1' }
        ]
      })

      expect(result).toEqual({ success: true, createdCount: 2 })
      expect(enqueueLocalSyncCreate).toHaveBeenCalledWith('bookmark', 'bmk_note_note_1')
      expect(enqueueLocalSyncCreate).toHaveBeenCalledWith('bookmark', 'bmk_task_task_1')
    })

    it('enqueues a delete with a snapshot payload for each bulk-deleted bookmark', async () => {
      registerBookmarksHandlers()
      const bookmark1 = {
        id: 'bmk_note_note_1',
        itemType: BookmarkItemTypes.NOTE,
        itemId: 'note_1',
        position: 0
      }
      const bookmark2 = {
        id: 'bmk_task_task_1',
        itemType: BookmarkItemTypes.TASK,
        itemId: 'task_1',
        position: 1
      }
      ;(bookmarkQueries.getBookmarkById as Mock).mockImplementation((_db, id) => {
        if (id === bookmark1.id) return bookmark1
        if (id === bookmark2.id) return bookmark2
        return undefined
      })
      ;(bookmarkQueries.bulkDeleteBookmarks as Mock).mockReturnValue(2)

      const result = await invokeHandler(BookmarksChannels.invoke.BULK_DELETE, {
        bookmarkIds: [bookmark1.id, bookmark2.id]
      })

      expect(result).toEqual({ success: true, deletedCount: 2 })
      expect(enqueueLocalSyncDelete).toHaveBeenCalledWith(
        'bookmark',
        bookmark1.id,
        JSON.stringify(bookmark1)
      )
      expect(enqueueLocalSyncDelete).toHaveBeenCalledWith(
        'bookmark',
        bookmark2.id,
        JSON.stringify(bookmark2)
      )
      // Every snapshot fetch must happen BEFORE the bulk delete runs —
      // bulkDeleteBookmarks wipes all the rows in one statement, so fetching
      // any snapshot after it would return undefined and silently drop sync.
      const getBookmarkByIdMock = bookmarkQueries.getBookmarkById as Mock
      const bulkDeleteMock = bookmarkQueries.bulkDeleteBookmarks as Mock
      const lastSnapshotFetchOrder = Math.max(...getBookmarkByIdMock.mock.invocationCallOrder)
      expect(lastSnapshotFetchOrder).toBeLessThan(bulkDeleteMock.mock.invocationCallOrder[0])
    })
  })
})
