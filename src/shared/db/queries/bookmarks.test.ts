import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestDataDb } from '@tests/utils/test-db'
import {
  insertBookmark,
  deleteBookmark,
  deleteBookmarkByItem,
  getBookmarkById,
  getBookmarkByItem,
  isBookmarked,
  listBookmarks,
  countBookmarks,
  listBookmarksByType,
  reorderBookmarks,
  updateBookmarkPosition,
  bulkCreateBookmarks,
  bulkDeleteBookmarks,
  toggleBookmark,
  deleteOrphanedBookmarks
} from './bookmarks'

describe('bookmarks queries', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('creates, retrieves, and deletes bookmarks', () => {
    const bookmark = insertBookmark(db, {
      id: 'bookmark-1',
      itemType: 'note',
      itemId: 'note-1',
      position: 0
    })

    expect(getBookmarkById(db, bookmark.id)?.itemId).toBe('note-1')
    expect(getBookmarkByItem(db, 'note', 'note-1')?.id).toBe('bookmark-1')
    expect(isBookmarked(db, 'note', 'note-1')).toBe(true)

    expect(deleteBookmarkByItem(db, 'note', 'note-1')).toBe(true)
    expect(deleteBookmark(db, 'bookmark-1')).toBe(false)
  })

  it('lists bookmarks with pagination and filters', () => {
    insertBookmark(db, { id: 'bookmark-2', itemType: 'note', itemId: 'note-2', position: 0 })
    insertBookmark(db, { id: 'bookmark-3', itemType: 'task', itemId: 'task-1', position: 1 })
    insertBookmark(db, { id: 'bookmark-4', itemType: 'note', itemId: 'note-3', position: 2 })

    const listed = listBookmarks(db, { limit: 2, offset: 1 })
    expect(listed).toHaveLength(2)

    const notesOnly = listBookmarks(db, { itemType: 'note' })
    expect(notesOnly.map((b) => b.id)).toEqual(['bookmark-2', 'bookmark-4'])
  })

  it('counts bookmarks and lists by type', () => {
    insertBookmark(db, { id: 'bookmark-5', itemType: 'note', itemId: 'note-4', position: 0 })
    insertBookmark(db, { id: 'bookmark-6', itemType: 'note', itemId: 'note-5', position: 1 })
    insertBookmark(db, { id: 'bookmark-7', itemType: 'task', itemId: 'task-2', position: 2 })

    expect(countBookmarks(db)).toBe(3)
    expect(countBookmarks(db, 'note')).toBe(2)

    const notes = listBookmarksByType(db, 'note')
    expect(notes.map((b) => b.id)).toEqual(['bookmark-5', 'bookmark-6'])
  })

  it('updates bookmark positions and reorders bookmarks', () => {
    insertBookmark(db, { id: 'bookmark-8', itemType: 'note', itemId: 'note-6', position: 0 })
    insertBookmark(db, { id: 'bookmark-9', itemType: 'note', itemId: 'note-7', position: 1 })
    insertBookmark(db, { id: 'bookmark-10', itemType: 'note', itemId: 'note-8', position: 2 })

    expect(updateBookmarkPosition(db, 'bookmark-9', 0)).toBe(true)
    reorderBookmarks(db, ['bookmark-10', 'bookmark-8', 'bookmark-9'])

    const ordered = listBookmarks(db)
    expect(ordered.map((b) => b.id)).toEqual(['bookmark-10', 'bookmark-8', 'bookmark-9'])
  })

  it('bulk creates and deletes bookmarks', () => {
    const created = bulkCreateBookmarks(
      db,
      [
        { itemType: 'note', itemId: 'note-9' },
        { itemType: 'note', itemId: 'note-9' },
        { itemType: 'task', itemId: 'task-3' }
      ],
      () => `bookmark-${Math.random()}`
    )

    expect(created).toBe(2)
    const all = listBookmarks(db)
    expect(bulkDeleteBookmarks(db, all.map((b) => b.id))).toBe(2)
  })

  it('toggles bookmarks and deletes orphaned entries', () => {
    const created = toggleBookmark(db, 'note', 'note-10', () => 'bookmark-11')
    expect(created.isBookmarked).toBe(true)
    expect(created.bookmark?.id).toBe('bookmark-11')

    const removed = toggleBookmark(db, 'note', 'note-10', () => 'bookmark-12')
    expect(removed.isBookmarked).toBe(false)

    insertBookmark(db, { id: 'bookmark-12', itemType: 'note', itemId: 'note-11', position: 0 })
    insertBookmark(db, { id: 'bookmark-13', itemType: 'note', itemId: 'note-12', position: 1 })
    const removedCount = deleteOrphanedBookmarks(db, 'note', new Set(['note-12']))
    expect(removedCount).toBe(1)
  })
})
