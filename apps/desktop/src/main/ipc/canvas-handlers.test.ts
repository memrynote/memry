import { describe, it, expect, vi } from 'vitest'
import { CanvasChannels } from '@memry/contracts/canvas-api'
import { registerCanvasHandlers, unregisterCanvasHandlers } from './canvas-handlers'

// Mock electron ipcMain so register/unregister can run in tests
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}))

// Registration must never touch the DB or keychain eagerly
vi.mock('../database', () => ({
  requireDatabase: vi.fn(() => {
    throw new Error('No vault is open')
  })
}))
vi.mock('../crypto', () => ({
  getOrInitializeLocalVaultKey: vi.fn(() => {
    throw new Error('keychain must not be touched at registration')
  })
}))
vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: vi.fn(() => {
    throw new Error('db must not be touched at registration')
  })
}))

const INVOKE_CHANNELS = Object.values(CanvasChannels.invoke)

describe('canvas handlers registration', () => {
  it('registers every canvas invoke channel without touching the DB', async () => {
    const { ipcMain } = await import('electron')
    const handleMock = vi.mocked(ipcMain.handle)
    handleMock.mockClear()

    expect(() => registerCanvasHandlers()).not.toThrow()

    const registered = handleMock.mock.calls.map(([channel]) => channel)
    expect(registered.sort()).toEqual([...INVOKE_CHANNELS].sort())
  })

  it('unregisters every canvas invoke channel', async () => {
    const { ipcMain } = await import('electron')
    const removeMock = vi.mocked(ipcMain.removeHandler)
    removeMock.mockClear()

    unregisterCanvasHandlers()

    const removed = removeMock.mock.calls.map(([channel]) => channel)
    expect(removed.sort()).toEqual([...INVOKE_CHANNELS].sort())
  })
})
