/**
 * Saved filters IPC handlers tests
 *
 * @module ipc/saved-filters-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { SavedFiltersChannels } from '@memry/contracts/ipc-channels'

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
  requireDatabase: vi.fn()
}))

vi.mock('../lib/id', () => ({
  generateId: vi.fn(() => 'generated-id-123')
}))

vi.mock('@main/database/queries/settings', () => ({
  listSavedFilters: vi.fn(),
  getNextSavedFilterPosition: vi.fn(),
  insertSavedFilter: vi.fn(),
  updateSavedFilter: vi.fn(),
  deleteSavedFilter: vi.fn(),
  reorderSavedFilters: vi.fn(),
  getSavedFilterById: vi.fn()
}))

vi.mock('../settings/saved-filters-store', () => ({
  listSavedFilters: vi.fn(),
  getNextSavedFilterPosition: vi.fn(),
  insertSavedFilter: vi.fn(),
  updateSavedFilter: vi.fn(),
  deleteSavedFilter: vi.fn(),
  reorderSavedFilters: vi.fn(),
  getSavedFilterById: vi.fn()
}))

vi.mock('../settings/saved-filters-sync', () => ({
  syncFilterCreate: vi.fn(),
  syncFilterUpdate: vi.fn(),
  syncFilterDelete: vi.fn()
}))

vi.mock('@memry/sync-client/filter-sync', () => ({
  getFilterSyncService: vi.fn().mockReturnValue(null)
}))

import {
  registerSavedFiltersHandlers,
  unregisterSavedFiltersHandlers
} from './saved-filters-handlers'
import { getDatabase, requireDatabase } from '../database'
import * as savedFiltersStore from '../settings/saved-filters-store'
import { syncFilterUpdate } from '../settings/saved-filters-sync'

describe('saved-filters-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    mockSend.mockClear()
    ;(getDatabase as Mock).mockReturnValue({})
    ;(requireDatabase as Mock).mockReturnValue({})
  })

  afterEach(() => {
    unregisterSavedFiltersHandlers()
  })

  it('lists saved filters', async () => {
    registerSavedFiltersHandlers()
    ;(savedFiltersStore.listSavedFilters as Mock).mockReturnValue([
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
    ;(savedFiltersStore.getNextSavedFilterPosition as Mock).mockReturnValue(1)
    ;(savedFiltersStore.insertSavedFilter as Mock).mockReturnValue({
      id: 'sf-2',
      name: 'Inbox',
      config: { filters: {}, sort: undefined },
      position: 1,
      createdAt: 'now'
    })
    ;(savedFiltersStore.getSavedFilterById as Mock).mockReturnValue({
      id: 'sf-2',
      name: 'Inbox',
      config: { filters: {} },
      expression: null,
      position: 1,
      createdAt: 'now'
    })
    ;(savedFiltersStore.updateSavedFilter as Mock).mockReturnValue({
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
    ;(savedFiltersStore.getSavedFilterById as Mock).mockReturnValue({
      id: 'sf-2',
      name: 'Inbox',
      config: '{}',
      position: 1,
      createdAt: 'now'
    })

    const deleteResult = await invokeHandler(SavedFiltersChannels.invoke.DELETE, { id: 'sf-2' })
    expect(deleteResult.success).toBe(true)
    expect(savedFiltersStore.deleteSavedFilter).toHaveBeenCalledWith({}, 'sf-2')
    expect(mockSend).toHaveBeenCalledWith(
      SavedFiltersChannels.events.DELETED,
      expect.objectContaining({ id: 'sf-2' })
    )

    const reorderResult = await invokeHandler(SavedFiltersChannels.invoke.REORDER, {
      ids: ['sf-1', 'sf-2'],
      positions: [0, 1]
    })
    expect(reorderResult).toEqual({ success: true })
    expect(savedFiltersStore.reorderSavedFilters).toHaveBeenCalledWith({}, ['sf-1', 'sf-2'], [0, 1])
  })

  it('pushes every reordered filter, so the new order reaches other devices', async () => {
    registerSavedFiltersHandlers()

    await invokeHandler(SavedFiltersChannels.invoke.REORDER, {
      ids: ['sf-1', 'sf-2'],
      positions: [1, 0]
    })

    expect(syncFilterUpdate).toHaveBeenCalledWith('sf-1')
    expect(syncFilterUpdate).toHaveBeenCalledWith('sf-2')
  })

  it('returns errors for missing saved filters', async () => {
    registerSavedFiltersHandlers()
    ;(savedFiltersStore.getSavedFilterById as Mock).mockReturnValue(undefined)

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

  it('merges a config edit into the stored config, keeping keys a newer build wrote', async () => {
    registerSavedFiltersHandlers()
    ;(savedFiltersStore.getSavedFilterById as Mock).mockReturnValue({
      id: 'sf-3',
      name: 'Rules',
      config: {
        filters: { search: '', projectIds: ['p1'], futureFilterKey: 'kept' },
        sort: { field: 'dueDate', direction: 'asc' },
        starred: false,
        futureConfigKey: { a: 1 }
      },
      expression: { match: 'all', rules: [] },
      position: 0,
      createdAt: 'now'
    })
    ;(savedFiltersStore.updateSavedFilter as Mock).mockReturnValue(undefined)

    await invokeHandler(SavedFiltersChannels.invoke.UPDATE, { id: 'sf-3', starred: true })
    expect(savedFiltersStore.updateSavedFilter).toHaveBeenLastCalledWith({}, 'sf-3', {
      config: {
        filters: { search: '', projectIds: ['p1'], futureFilterKey: 'kept' },
        sort: { field: 'dueDate', direction: 'asc' },
        starred: true,
        futureConfigKey: { a: 1 }
      }
    })

    await invokeHandler(SavedFiltersChannels.invoke.UPDATE, {
      id: 'sf-3',
      config: { filters: { search: 'x', projectIds: [], folderPaths: [] } },
      expression: null
    })
    const [, , updates] = (savedFiltersStore.updateSavedFilter as Mock).mock.lastCall!
    expect(updates.config.futureConfigKey).toEqual({ a: 1 })
    expect(updates.config.filters).toMatchObject({
      search: 'x',
      projectIds: [],
      folderPaths: [],
      futureFilterKey: 'kept'
    })
    expect(updates.expression).toBeNull()
  })

  it('stores rules beside config on create and leaves them alone on a rename', async () => {
    registerSavedFiltersHandlers()
    const expression = {
      match: 'any',
      rules: [{ field: 'tags', op: 'none', values: ['someday'] }]
    }
    ;(savedFiltersStore.getNextSavedFilterPosition as Mock).mockReturnValue(0)
    ;(savedFiltersStore.insertSavedFilter as Mock).mockImplementation((_db, row) => ({
      ...row,
      createdAt: 'now'
    }))

    const created = await invokeHandler(SavedFiltersChannels.invoke.CREATE, {
      name: 'Rules',
      config: { filters: {} },
      expression
    })
    expect(created.savedFilter.expression).toEqual(expression)
    expect(savedFiltersStore.insertSavedFilter).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ expression })
    )

    ;(savedFiltersStore.getSavedFilterById as Mock).mockReturnValue({ ...created.savedFilter })
    await invokeHandler(SavedFiltersChannels.invoke.UPDATE, {
      id: created.savedFilter.id,
      name: 'R'
    })
    expect(savedFiltersStore.updateSavedFilter).toHaveBeenLastCalledWith(
      {},
      created.savedFilter.id,
      {
        name: 'R'
      }
    )
  })
})
