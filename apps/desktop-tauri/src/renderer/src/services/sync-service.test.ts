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
      syncInitialSyncProgressEvent: event('progress')
    }
  }
})

import { onInitialSyncProgress, onSyncStatusChanged, syncService } from './sync-service'

describe('sync-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
  })

  it('sends the Electron arguments in the shapes the Rust commands take', async () => {
    mocks.commands.syncPause.mockResolvedValue({ success: true, wasPaused: false })
    mocks.commands.syncResume.mockResolvedValue({ success: true, pendingCount: 0 })
    mocks.commands.syncGetNoteSyncState.mockResolvedValue(null)
    mocks.commands.syncGetHistory.mockResolvedValue({ entries: [], total: 0 })

    await syncService.pause('popover')
    await syncService.resume('settings')
    await syncService.getNoteSyncState('n1')
    await syncService.getHistory({ limit: 50 })

    expect(mocks.commands.syncPause).toHaveBeenCalledWith({ surface: 'popover' })
    expect(mocks.commands.syncResume).toHaveBeenCalledWith({ surface: 'settings' })
    expect(mocks.commands.syncGetNoteSyncState).toHaveBeenCalledWith({ noteId: 'n1' })
    expect(mocks.commands.syncGetHistory).toHaveBeenCalledWith({ limit: 50, offset: null })
  })

  it('answers Sync Now in the contract union, keeping the blocked reason', async () => {
    mocks.commands.syncTrigger
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, reason: 'offline', error: null })

    await expect(syncService.triggerSync()).resolves.toEqual({ success: true })
    await expect(syncService.triggerSync()).resolves.toEqual({ success: false, reason: 'offline' })
  })

  it('delivers a status event with the fields Rust sent', async () => {
    const received = vi.fn()
    onSyncStatusChanged(received)
    await vi.waitFor(() => expect(mocks.listeners.has('status')).toBe(true))

    mocks.listeners.get('status')?.({
      payload: { status: 'error', pendingCount: 3, error: 'boom', errorCategory: 'server_error' }
    })

    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        pendingCount: 3,
        error: 'boom',
        errorCategory: 'server_error',
        lastSyncAt: undefined
      })
    )
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
