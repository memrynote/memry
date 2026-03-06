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
    getAllWindows: vi.fn(() => [{ webContents: { send: mockSend } }])
  }
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))

vi.mock('../lib/id', () => ({
  generateId: vi.fn(() => 'bookmark-id')
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
import { getDatabase, getIndexDatabase } from '../database'
import * as bookmarkQueries from '@main/database/queries/bookmarks'
import * as notesQueries from '@main/database/queries/notes'
import * as tasksQueries from '@main/database/queries/tasks'

describe('bookmarks-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    mockSend.mockClear()
    ;(getDatabase as Mock).mockReturnValue({})
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
    ;(bookmarkQueries.bulkCreateBookmarks as Mock).mockReturnValue(2)
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
})
