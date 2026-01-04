/**
 * Bookmarks IPC handlers tests
 *
 * @module ipc/bookmarks-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { BookmarksChannels } from '@shared/ipc-channels'
import { BookmarkItemTypes } from '@shared/db/schema/bookmarks'

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

vi.mock('@shared/db/queries/bookmarks', () => ({
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

vi.mock('@shared/db/queries/notes', () => ({
  getNoteCacheById: vi.fn(),
  getNoteTags: vi.fn()
}))

vi.mock('@shared/db/queries/tasks', () => ({
  getTaskById: vi.fn(),
  getTaskTags: vi.fn()
}))

import { registerBookmarksHandlers, unregisterBookmarksHandlers } from './bookmarks-handlers'
import { getDatabase, getIndexDatabase } from '../database'
import * as bookmarkQueries from '@shared/db/queries/bookmarks'
import * as notesQueries from '@shared/db/queries/notes'
import * as tasksQueries from '@shared/db/queries/tasks'

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
})
