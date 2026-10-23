import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadwiseImportChannels } from '@memry/contracts/import-channels'

const electronMock = vi.hoisted(() => ({
  ipcRenderer: { invoke: vi.fn(async () => ({})), on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('electron', () => electronMock)

import { importApi } from './import'

describe('importApi.readwise', () => {
  beforeEach(() => electronMock.ipcRenderer.invoke.mockClear())

  it.each([
    ['status', ReadwiseImportChannels.invoke.STATUS, []],
    ['connect', ReadwiseImportChannels.invoke.CONNECT, [{ token: 't' }]],
    ['disconnect', ReadwiseImportChannels.invoke.DISCONNECT, []],
    ['syncNow', ReadwiseImportChannels.invoke.SYNC_NOW, []],
    ['setOptions', ReadwiseImportChannels.invoke.SET_OPTIONS, [{ cadence: 'daily' }]],
    ['reimportBook', ReadwiseImportChannels.invoke.REIMPORT_BOOK, [{ noteId: 'n1' }]],
    ['refreshBook', ReadwiseImportChannels.invoke.REFRESH_BOOK, [{ noteId: 'n1' }]],
    ['listDeleted', ReadwiseImportChannels.invoke.LIST_DELETED, []],
    ['restoreBook', ReadwiseImportChannels.invoke.RESTORE_BOOK, [{ readwiseBookId: 7 }]],
    ['takeOver', ReadwiseImportChannels.invoke.TAKE_OVER, [{ token: 't' }]]
  ] as const)('%s invokes its channel', async (method, channel, args) => {
    await (importApi.readwise[method] as (...a: unknown[]) => Promise<unknown>)(...args)
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...args)
  })
})
