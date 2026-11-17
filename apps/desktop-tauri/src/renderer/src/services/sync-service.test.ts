import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  commands: {
    syncGetStatus: vi.fn(),
    syncTrigger: vi.fn(),
    syncGetHistory: vi.fn(),
    syncPause: vi.fn(),
    syncResume: vi.fn(),
    syncGetNoteSyncState: vi.fn()
  },
  listeners: new Map<string, (event: { payload: unknown }) => void>()
}))

vi.mock('../../../generated/bindings', () => {
  const event = (name: string) => ({
    listen: vi.fn(async (handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, handler)
      return () => mocks.listeners.delete(name)
    })
  })
  return {
    commands: mocks.commands,
    events: {
      syncStatusChangedEvent: event('status'),
      syncItemSyncedEvent: event('item'),
      syncInitialSyncProgressEvent: event('progress')
    }
  }
})

import {
  onInitialSyncProgress,
  onItemSynced,
  onSyncStatusChanged,
  syncService
} from './sync-service'

describe('sync-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
  })

  it('answers Sync Now in the contract union, keeping the blocked reason', async () => {
    mocks.commands.syncTrigger
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, reason: 'offline', error: null })

    await expect(syncService.triggerSync()).resolves.toEqual({ success: true })
    await expect(syncService.triggerSync()).resolves.toEqual({ success: false, reason: 'offline' })
  })

  it('delivers a status event with the absent fields Rust sent as null left undefined', async () => {
    const received = vi.fn()
    onSyncStatusChanged(received)
    await vi.waitFor(() => expect(mocks.listeners.has('status')).toBe(true))

    mocks.listeners.get('status')?.({
      payload: {
        status: 'error',
        pendingCount: 3,
        lastSyncAt: null,
        error: 'boom',
        errorCategory: 'server_error',
        offlineSince: null
      }
    })

    expect(received).toHaveBeenCalledWith({
      status: 'error',
      pendingCount: 3,
      lastSyncAt: undefined,
      error: 'boom',
      errorCategory: 'server_error',
      offlineSince: undefined
    })
  })

  it('delivers an item-synced event without a null item operation', async () => {
    const received = vi.fn()
    onItemSynced(received)
    await vi.waitFor(() => expect(mocks.listeners.has('item')).toBe(true))

    mocks.listeners.get('item')?.({
      payload: { itemId: 'n1', type: 'note', operation: 'pull', itemOperation: null }
    })
    mocks.listeners.get('item')?.({
      payload: { itemId: 'n2', type: 'note', operation: 'push', itemOperation: 'delete' }
    })

    expect(received.mock.calls[0][0]).toStrictEqual({
      itemId: 'n1',
      type: 'note',
      operation: 'pull'
    })
    expect(received.mock.calls[1][0]).toStrictEqual({
      itemId: 'n2',
      type: 'note',
      operation: 'push',
      itemOperation: 'delete'
    })
  })

  it('delivers initial sync progress without a null item type', async () => {
    const received = vi.fn()
    onInitialSyncProgress(received)
    await vi.waitFor(() => expect(mocks.listeners.has('progress')).toBe(true))

    mocks.listeners.get('progress')?.({
      payload: { phase: 'notes', totalItems: 10, processedItems: 4, currentItemType: null }
    })

    expect(received).toHaveBeenCalledWith({ phase: 'notes', totalItems: 10, processedItems: 4 })
  })
})
