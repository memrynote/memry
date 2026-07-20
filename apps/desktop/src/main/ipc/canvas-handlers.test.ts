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
  }),
  secureCleanup: vi.fn()
}))
vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: vi.fn(() => {
    throw new Error('db must not be touched at registration')
  })
}))
vi.mock('../canvas/store', () => ({
  createCanvas: vi.fn(),
  deleteCanvas: vi.fn(),
  getCanvas: vi.fn(),
  listCanvases: vi.fn(() => []),
  updateCanvas: vi.fn()
}))
// Keep the sync/attachment runtime out of this registration test: the real
// context builder pulls the whole attachment + writeback graph. Returning null
// makes the asset handlers degrade to their offline-safe branches.
vi.mock('../canvas/assets/asset-service-context', () => ({
  buildAssetServiceContext: vi.fn(() => null)
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

describe('canvas vault key memoization', () => {
  // The keychain may only be consulted once per process (agent bootstrap
  // parity): under NODE_ENV=test the keychain degrades to not-found after the
  // first call, so per-invoke resolution would throw "verifier exists but
  // master key is missing" on every call after the first.
  async function registerWithWorkingContext() {
    const { ipcMain } = await import('electron')
    const { requireDatabase } = await import('../database')
    const { getOrCreateVaultUuid } = await import('../agent/storage/vault-id')
    const { getOrInitializeLocalVaultKey } = await import('../crypto')

    vi.mocked(requireDatabase).mockReturnValue({} as never)
    vi.mocked(getOrCreateVaultUuid).mockReturnValue('vault-1')
    const initMock = vi.mocked(getOrInitializeLocalVaultKey)
    initMock.mockReset()

    const handleMock = vi.mocked(ipcMain.handle)
    handleMock.mockClear()
    registerCanvasHandlers()
    const listEntry = handleMock.mock.calls.find(
      ([channel]) => channel === CanvasChannels.invoke.LIST
    )
    const listHandler = listEntry?.[1] as (event: unknown) => Promise<unknown>
    return { listHandler, initMock }
  }

  it('resolves the vault key once across multiple invokes', async () => {
    const { listHandler, initMock } = await registerWithWorkingContext()
    initMock.mockResolvedValue(new Uint8Array(32))

    await listHandler({})
    await listHandler({})
    await listHandler({})

    expect(initMock).toHaveBeenCalledTimes(1)
    unregisterCanvasHandlers()
  })

  it('does not cache a failed resolution; the next invoke retries', async () => {
    const { listHandler, initMock } = await registerWithWorkingContext()
    initMock
      .mockRejectedValueOnce(new Error('keychain hiccup'))
      .mockResolvedValue(new Uint8Array(32))

    await expect(listHandler({})).rejects.toThrow('keychain hiccup')
    await listHandler({})
    await listHandler({})

    expect(initMock).toHaveBeenCalledTimes(2)
    unregisterCanvasHandlers()
  })
})
