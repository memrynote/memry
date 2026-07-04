import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bulkFileToFolder: vi.fn(),
  bulkSnoozeItems: vi.fn(),
  getStaleItemIds: vi.fn(),
  generateId: vi.fn(() => 'generated-id')
}))

vi.mock('./filing', () => ({
  bulkFileToFolder: mocks.bulkFileToFolder
}))

vi.mock('./snooze', () => ({
  bulkSnoozeItems: mocks.bulkSnoozeItems
}))

vi.mock('./stats', () => ({
  getStaleItemIds: mocks.getStaleItemIds
}))

vi.mock('../lib/id', () => ({
  generateId: mocks.generateId
}))

import { createInboxBatchHandlers } from './batch'

function createDb(existingIds = new Set<string>(), existingTags = new Set<string>()) {
  const inserts: unknown[] = []
  let selectGetCount = 0
  return {
    inserts,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          get: vi.fn(() => {
            void table
            selectGetCount += 1
            if (selectGetCount === 1) return existingIds.size ? { id: 'item-1' } : null
            return existingTags.size ? { id: 'tag-1' } : null
          })
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn((value: unknown) => {
        inserts.push(value)
        return { run: vi.fn() }
      })
    }))
  }
}

function createHandlers(db = createDb(new Set(['item-1']))) {
  return {
    emitInboxEvent: vi.fn(),
    archiveItem: vi.fn(async (itemId: string) => ({
      success: itemId !== 'bad',
      error: itemId === 'bad' ? 'archive failed' : undefined
    })),
    handlers: createInboxBatchHandlers({
      requireDatabase: () => db as never,
      emitInboxEvent: vi.fn(),
      archiveItem: vi.fn(async (itemId: string) => ({
        success: itemId !== 'bad',
        error: itemId === 'bad' ? 'archive failed' : undefined
      }))
    })
  }
}

describe('inbox batch handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.bulkFileToFolder.mockResolvedValue({ success: true, processedCount: 2, errors: [] })
    mocks.bulkSnoozeItems.mockResolvedValue({ success: true, processedCount: 2, errors: [] })
    mocks.getStaleItemIds.mockReturnValue(['stale-1', 'stale-2'])
  })

  it('bulk archives each item and returns per-item errors', async () => {
    const archiveItem = vi.fn(async (itemId: string) => ({
      success: itemId !== 'bad',
      error: itemId === 'bad' ? 'archive failed' : undefined
    }))
    const handlers = createInboxBatchHandlers({
      requireDatabase: () => createDb(new Set(['item-1'])) as never,
      emitInboxEvent: vi.fn(),
      archiveItem
    })

    await expect(handlers.handleBulkArchive({ itemIds: ['good', 'bad'] })).resolves.toEqual({
      success: false,
      processedCount: 1,
      errors: [{ itemId: 'bad', error: 'archive failed' }]
    })
  })

  it('validates bulk snooze input and delegates valid requests', async () => {
    const { handlers } = createHandlers()

    await expect(handlers.handleBulkSnooze(null)).resolves.toEqual({
      success: false,
      processedCount: 0,
      errors: [{ itemId: '', error: 'Invalid input' }]
    })
    await expect(handlers.handleBulkSnooze({ itemIds: [] })).resolves.toEqual({
      success: false,
      processedCount: 0,
      errors: [{ itemId: '', error: 'itemIds array is required' }]
    })
    await expect(handlers.handleBulkSnooze({ itemIds: ['item-1'] })).resolves.toEqual({
      success: false,
      processedCount: 0,
      errors: [{ itemId: '', error: 'snoozeUntil is required' }]
    })

    await expect(
      handlers.handleBulkSnooze({
        itemIds: ['item-1'],
        snoozeUntil: '2026-05-11T00:00:00.000Z',
        reason: 'later'
      })
    ).resolves.toEqual({ success: true, processedCount: 2, errors: [] })
    expect(mocks.bulkSnoozeItems).toHaveBeenCalledWith(
      ['item-1'],
      '2026-05-11T00:00:00.000Z',
      'later'
    )
  })

  it('bulk-files only folder destinations and files stale items', async () => {
    const { handlers } = createHandlers()

    await expect(
      handlers.handleBulkFile({
        itemIds: ['item-1'],
        destination: { type: 'note', noteId: 'note-1' },
        tags: []
      })
    ).resolves.toEqual({
      success: false,
      processedCount: 0,
      errors: [{ itemId: '', error: 'Bulk filing only supports folder destination' }]
    })

    await handlers.handleBulkFile({
      itemIds: ['item-1'],
      destination: { type: 'folder', path: 'Read Later' },
      tags: ['work']
    })
    expect(mocks.bulkFileToFolder).toHaveBeenCalledWith(['item-1'], 'Read Later', ['work'])

    await expect(handlers.handleFileAllStale()).resolves.toEqual({
      success: true,
      processedCount: 2,
      errors: []
    })
    expect(mocks.bulkFileToFolder).toHaveBeenCalledWith(['stale-1', 'stale-2'], 'Unsorted', [])

    mocks.getStaleItemIds.mockReturnValueOnce([])
    await expect(handlers.handleFileAllStale()).resolves.toEqual({
      success: true,
      processedCount: 0,
      errors: []
    })

    mocks.getStaleItemIds.mockImplementationOnce(() => {
      throw new Error('stats failed')
    })
    await expect(handlers.handleFileAllStale()).resolves.toEqual({
      success: false,
      processedCount: 0,
      errors: [{ itemId: 'batch', error: 'stats failed' }]
    })
  })

  it('adds normalized tags, reports missing items, and emits item updates', async () => {
    const db = createDb(new Set(['item-1']))
    const emitInboxEvent = vi.fn()
    const handlers = createInboxBatchHandlers({
      requireDatabase: () => db as never,
      emitInboxEvent,
      archiveItem: vi.fn()
    })

    await expect(
      handlers.handleBulkTag({ itemIds: ['item-1'], tags: [' Work ', '', 'Ideas'] })
    ).resolves.toEqual({ success: true, processedCount: 1, errors: [] })
    expect(db.inserts).toEqual([
      { id: 'generated-id', itemId: 'item-1', tag: 'Work' },
      { id: 'generated-id', itemId: 'item-1', tag: 'Ideas' }
    ])
    expect(emitInboxEvent).toHaveBeenCalledWith(expect.any(String), {
      id: 'item-1',
      changes: { tags: [' Work ', '', 'Ideas'] }
    })

    const missingDb = createDb()
    const missingHandlers = createInboxBatchHandlers({
      requireDatabase: () => missingDb as never,
      emitInboxEvent: vi.fn(),
      archiveItem: vi.fn()
    })
    await expect(
      missingHandlers.handleBulkTag({ itemIds: ['missing'], tags: ['work'] })
    ).resolves.toEqual({
      success: false,
      processedCount: 0,
      errors: [{ itemId: 'missing', error: 'Item not found' }]
    })
  })
})
