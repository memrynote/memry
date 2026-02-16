/**
 * Saved filters IPC handlers tests
 *
 * @module ipc/saved-filters-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { SavedFiltersChannels } from '@shared/ipc-channels'

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
  getDatabase: vi.fn()
}))

vi.mock('../lib/id', () => ({
  generateId: vi.fn(() => 'generated-id-123')
}))

vi.mock('@shared/db/queries/settings', () => ({
  listSavedFilters: vi.fn(),
  getNextSavedFilterPosition: vi.fn(),
  insertSavedFilter: vi.fn(),
  savedFilterExists: vi.fn(),
  updateSavedFilter: vi.fn(),
  deleteSavedFilter: vi.fn(),
  reorderSavedFilters: vi.fn(),
  getSavedFilterById: vi.fn()
}))

vi.mock('../sync/filter-sync', () => ({
  getFilterSyncService: vi.fn().mockReturnValue(null)
}))

import {
  registerSavedFiltersHandlers,
  unregisterSavedFiltersHandlers
} from './saved-filters-handlers'
import { getDatabase } from '../database'
import * as settingsQueries from '@shared/db/queries/settings'

describe('saved-filters-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    mockSend.mockClear()
    ;(getDatabase as Mock).mockReturnValue({})
  })

  afterEach(() => {
    unregisterSavedFiltersHandlers()
  })

  it('lists saved filters', async () => {
    registerSavedFiltersHandlers()
    ;(settingsQueries.listSavedFilters as Mock).mockReturnValue([
      {
        id: 'sf-1',
        name: 'Today',
        config: { filters: {}, sort: undefined },
        position: 0,
        createdAt: 'now'
      }
    ])

    const result = await invokeHandler(SavedFiltersChannels.invoke.LIST)
    expect(result.savedFilters).toHaveLength(1)
    expect(result.savedFilters[0]?.id).toBe('sf-1')
  })

  it('creates, updates, deletes, and reorders saved filters', async () => {
    registerSavedFiltersHandlers()
    ;(settingsQueries.getNextSavedFilterPosition as Mock).mockReturnValue(1)
    ;(settingsQueries.insertSavedFilter as Mock).mockReturnValue({
      id: 'sf-2',
      name: 'Inbox',
      config: { filters: {}, sort: undefined },
      position: 1,
      createdAt: 'now'
    })
    ;(settingsQueries.savedFilterExists as Mock).mockReturnValue(true)
    ;(settingsQueries.updateSavedFilter as Mock).mockReturnValue({
      id: 'sf-2',
      name: 'Inbox Updated',
      config: { filters: {}, sort: undefined },
      position: 1,
      createdAt: 'now'
    })

    const createResult = await invokeHandler(SavedFiltersChannels.invoke.CREATE, {
      name: 'Inbox',
      config: { filters: {}, sort: undefined }
    })
    expect(createResult.success).toBe(true)
    expect(mockSend).toHaveBeenCalledWith(
      SavedFiltersChannels.events.CREATED,
      expect.objectContaining({ savedFilter: expect.objectContaining({ id: 'sf-2' }) })
    )

    const updateResult = await invokeHandler(SavedFiltersChannels.invoke.UPDATE, {
      id: 'sf-2',
      name: 'Inbox Updated'
    })
    expect(updateResult.success).toBe(true)
    expect(mockSend).toHaveBeenCalledWith(
      SavedFiltersChannels.events.UPDATED,
      expect.objectContaining({ id: 'sf-2' })
    )
    ;(settingsQueries.getSavedFilterById as Mock).mockReturnValue({
      id: 'sf-2',
      name: 'Inbox',
      config: '{}',
      position: 1,
      createdAt: 'now'
    })

    const deleteResult = await invokeHandler(SavedFiltersChannels.invoke.DELETE, { id: 'sf-2' })
    expect(deleteResult.success).toBe(true)
    expect(settingsQueries.deleteSavedFilter).toHaveBeenCalledWith({}, 'sf-2')
    expect(mockSend).toHaveBeenCalledWith(
      SavedFiltersChannels.events.DELETED,
      expect.objectContaining({ id: 'sf-2' })
    )

    const reorderResult = await invokeHandler(SavedFiltersChannels.invoke.REORDER, {
      ids: ['sf-1', 'sf-2'],
      positions: [0, 1]
    })
    expect(reorderResult).toEqual({ success: true })
    expect(settingsQueries.reorderSavedFilters).toHaveBeenCalledWith({}, ['sf-1', 'sf-2'], [0, 1])
  })

  it('returns errors for missing saved filters', async () => {
    registerSavedFiltersHandlers()
    ;(settingsQueries.savedFilterExists as Mock).mockReturnValue(false)

    const updateResult = await invokeHandler(SavedFiltersChannels.invoke.UPDATE, {
      id: 'missing',
      name: 'Nope'
    })
    expect(updateResult).toEqual({
      success: false,
      savedFilter: null,
      error: 'Saved filter not found'
    })

    const deleteResult = await invokeHandler(SavedFiltersChannels.invoke.DELETE, { id: 'missing' })
    expect(deleteResult).toEqual({ success: false, error: 'Saved filter not found' })
  })
})
