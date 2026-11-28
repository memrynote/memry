import { describe, it, expect, beforeEach, vi } from 'vitest'
import { bookmarksService, onBookmarkDeleted } from './bookmarks-service'
import { recentsService } from './recents-service'

const commands = vi.hoisted(() => ({
  bookmarksCreate: vi.fn(),
  bookmarksDelete: vi.fn(),
  bookmarksList: vi.fn(),
  bookmarksListByType: vi.fn(),
  bookmarksToggle: vi.fn(),
  bookmarksReorder: vi.fn(),
  bookmarksBulkCreate: vi.fn(),
  bookmarksBulkDelete: vi.fn(),
  recentsList: vi.fn(),
  recentsRecord: vi.fn()
}))
const events = vi.hoisted(() => ({
  bookmarkCreatedEvent: { listen: vi.fn() },
  bookmarkDeletedEvent: { listen: vi.fn() },
  bookmarksReorderedEvent: { listen: vi.fn() }
}))

vi.mock('../../../generated/bindings', () => ({ commands, events }))

const row = {
  id: 'bmk_note_n1',
  itemType: 'note',
  itemId: 'n1',
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z'
}

beforeEach(() => {
  for (const command of Object.values(commands)) command.mockReset()
})

describe('bookmarks-service', () => {
  it('answers a list in the contract shape, a meta field the item lacks left out', async () => {
    commands.bookmarksList.mockResolvedValue({
      bookmarks: [
        { ...row, itemTitle: 'Plan', itemExists: true, itemMeta: { path: 'Plan.md' } },
        { ...row, id: 'b2', itemTitle: null, itemExists: false }
      ],
      total: 2,
      hasMore: false
    })

    const listed = await bookmarksService.list()

    expect(commands.bookmarksList).toHaveBeenCalledWith({})
    expect(listed.bookmarks[0].itemMeta).toEqual({
      path: 'Plan.md',
      emoji: undefined,
      tags: undefined
    })
    expect(listed.bookmarks[1]).not.toHaveProperty('itemMeta')
    expect(listed.total).toBe(2)
  })

  it('answers a refused create or delete with its message, as Electron does', async () => {
    commands.bookmarksCreate.mockRejectedValue({
      kind: 'invalid',
      code: 'already_bookmarked',
      message: 'Item is already bookmarked'
    })
    commands.bookmarksDelete.mockRejectedValue({
      kind: 'not_found',
      code: 'not_found',
      message: 'Bookmark not found'
    })

    await expect(bookmarksService.create({ itemType: 'note', itemId: 'n1' })).resolves.toEqual({
      success: false,
      bookmark: null,
      error: 'Item is already bookmarked'
    })
    await expect(bookmarksService.delete('x')).resolves.toEqual({
      success: false,
      error: 'Bookmark not found'
    })
  })

  it('wraps a toggle and the bulk writes in their success shapes', async () => {
    commands.bookmarksToggle.mockResolvedValue({ isBookmarked: true, bookmark: row })
    commands.bookmarksBulkCreate.mockResolvedValue(2)
    commands.bookmarksBulkDelete.mockResolvedValue(1)
    const items = [{ itemType: 'folder', itemId: 'a' }]

    await expect(bookmarksService.toggle({ itemType: 'note', itemId: 'n1' })).resolves.toEqual({
      success: true,
      isBookmarked: true,
      bookmark: row
    })
    await expect(bookmarksService.bulkCreate(items)).resolves.toEqual({
      success: true,
      createdCount: 2
    })
    expect(commands.bookmarksBulkCreate).toHaveBeenCalledWith(items)
    await expect(bookmarksService.bulkDelete(['a'])).resolves.toEqual({
      success: true,
      deletedCount: 1
    })
  })

  it('a toggle that throws still throws, as the Electron handler did', async () => {
    commands.bookmarksToggle.mockRejectedValue({ kind: 'invalid', code: 'no_vault_open' })

    await expect(bookmarksService.toggle({ itemType: 'note', itemId: 'n1' })).rejects.toEqual({
      kind: 'invalid',
      code: 'no_vault_open'
    })
  })

  it('hands a deleted event to the callback with the item it names', async () => {
    let deliver: (event: { payload: unknown }) => void = () => {}
    events.bookmarkDeletedEvent.listen.mockImplementation(
      (handler: (event: { payload: unknown }) => void) => {
        deliver = handler
        return Promise.resolve(() => {})
      }
    )
    const heard = vi.fn()
    const stop = onBookmarkDeleted(heard)

    const payload = { id: 'bmk_note_n1', itemType: 'note', itemId: 'n1' }
    deliver({ payload })
    stop()
    deliver({ payload })

    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard).toHaveBeenCalledWith(payload)
  })
})

describe('recents-service', () => {
  it('lists 50 when no limit is given and answers a record as { recorded }', async () => {
    commands.recentsList.mockResolvedValue([])
    commands.recentsRecord.mockResolvedValue(false)

    await recentsService.list()
    await recentsService.list(8)
    const recorded = await recentsService.record({ itemId: 'n1', itemType: 'note' })

    expect(commands.recentsList.mock.calls).toEqual([[null], [8]])
    expect(commands.recentsRecord).toHaveBeenCalledWith({ itemId: 'n1', itemType: 'note' })
    expect(recorded).toEqual({ recorded: false })
  })
})
