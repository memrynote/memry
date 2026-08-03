import { describe, it, expect, vi, afterEach } from 'vitest'
import { CanvasChannels } from '@memry/contracts/canvas-api'
import { registerCanvasHandlers, unregisterCanvasHandlers } from './canvas-handlers'
import { buildAssetServiceContext } from '../canvas/assets/asset-service-context'
import {
  getCanvasAssetRef,
  listCanvasAssetDescriptors,
  injectSceneAssetSidecar,
  reconcileCanvasAssets,
  uploadCanvasAsset
} from '../canvas/assets/asset-service'
import { createCanvas, getCanvas, updateCanvas, deleteCanvas } from '../canvas/store'
import { syncCanvasUpdate, syncCanvasDelete } from '../canvas/sync-bridge'
import { trackMainEvent } from '../telemetry/track'

// Mock electron ipcMain so register/unregister can run in tests
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    fromWebContents: vi.fn()
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
vi.mock('../canvas/sync-bridge', () => ({
  syncCanvasCreate: vi.fn(() => true),
  syncCanvasUpdate: vi.fn(() => true),
  syncCanvasDelete: vi.fn()
}))
vi.mock('../telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))
// Keep the sync/attachment runtime out of this registration test: the real
// context builder pulls the whole attachment + writeback graph. Returning null
// makes the asset handlers degrade to their offline-safe branches.
vi.mock('../canvas/assets/asset-service-context', () => ({
  buildAssetServiceContext: vi.fn(() => null)
}))
// The asset service itself is unit-tested elsewhere (asset-service.test.ts);
// here we only need to verify the handlers call it with the right args.
vi.mock('../canvas/assets/asset-service', () => ({
  getCanvasAssetRef: vi.fn(),
  listCanvasAssetDescriptors: vi.fn(() => []),
  injectSceneAssetSidecar: vi.fn((_ctx: unknown, _id: string, scene: string) => scene),
  reconcileCanvasAssets: vi.fn(async () => {}),
  uploadCanvasAsset: vi.fn(async () => ({
    ref: 'memry-file://local/x/attachments/canvas-assets/hash.png',
    descriptor: {
      fileId: 'file-1',
      attachmentId: 'att-1',
      contentHash: 'hash',
      chunkHashes: ['chunk-1'],
      mimeType: 'image/png',
      sizeBytes: 3,
      filename: 'hash.png'
    },
    deduped: false
  }))
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

type Handler = (event: unknown, input?: unknown) => Promise<unknown>

/** Register the handlers and return a channel -> handler lookup for direct invocation. */
async function registerAndGetHandlers(): Promise<Record<string, Handler>> {
  const { ipcMain } = await import('electron')
  const handleMock = vi.mocked(ipcMain.handle)
  handleMock.mockClear()
  registerCanvasHandlers()
  const map: Record<string, Handler> = {}
  for (const [channel, handler] of handleMock.mock.calls) {
    map[channel as string] = handler as Handler
  }
  return map
}

/** Set up requireDatabase/getOrCreateVaultUuid/getOrInitializeLocalVaultKey to resolve. */
async function withWorkingCanvasContext(): Promise<void> {
  const { requireDatabase } = await import('../database')
  const { getOrCreateVaultUuid } = await import('../agent/storage/vault-id')
  const { getOrInitializeLocalVaultKey } = await import('../crypto')
  vi.mocked(requireDatabase).mockReturnValue({} as never)
  vi.mocked(getOrCreateVaultUuid).mockReturnValue('vault-1')
  vi.mocked(getOrInitializeLocalVaultKey).mockReset().mockResolvedValue(new Uint8Array(32))
}

describe('canvas asset IPC handlers', () => {
  afterEach(() => {
    unregisterCanvasHandlers()
    vi.clearAllMocks()
  })

  describe('canvas:upload-asset', () => {
    it('throws "No vault is open" when buildAssetServiceContext() returns null', async () => {
      vi.mocked(buildAssetServiceContext).mockReturnValue(null)
      const handlers = await registerAndGetHandlers()

      await expect(
        handlers[CanvasChannels.invoke.UPLOAD_ASSET](
          {},
          { canvasId: 'canvas-1', fileId: 'file-1', mimeType: 'image/png', data: [1, 2, 3] }
        )
      ).rejects.toThrow('No vault is open')
      expect(uploadCanvasAsset).not.toHaveBeenCalled()
    })

    it('decodes the number[] payload to bytes and calls uploadCanvasAsset with the context', async () => {
      const fakeCtx = { marker: 'ctx' }
      vi.mocked(buildAssetServiceContext).mockReturnValue(fakeCtx as never)
      const handlers = await registerAndGetHandlers()

      const result = await handlers[CanvasChannels.invoke.UPLOAD_ASSET](
        {},
        { canvasId: 'canvas-1', fileId: 'file-1', mimeType: 'image/png', data: [137, 80, 78, 71] }
      )

      expect(uploadCanvasAsset).toHaveBeenCalledTimes(1)
      const [ctxArg, canvasIdArg, fileIdArg, mimeTypeArg, bytesArg] =
        vi.mocked(uploadCanvasAsset).mock.calls[0]
      expect(ctxArg).toBe(fakeCtx)
      expect(canvasIdArg).toBe('canvas-1')
      expect(fileIdArg).toBe('file-1')
      expect(mimeTypeArg).toBe('image/png')
      expect(bytesArg).toBeInstanceOf(Uint8Array)
      expect(Array.from(bytesArg as Uint8Array)).toEqual([137, 80, 78, 71])
      expect(result).toMatchObject({ deduped: false })
    })
  })

  describe('canvas:get-asset', () => {
    it('returns { ref: null } when buildAssetServiceContext() returns null', async () => {
      vi.mocked(buildAssetServiceContext).mockReturnValue(null)
      const handlers = await registerAndGetHandlers()

      const result = await handlers[CanvasChannels.invoke.GET_ASSET](
        {},
        { canvasId: 'canvas-1', fileId: 'file-1' }
      )

      expect(result).toEqual({ ref: null })
      expect(getCanvasAssetRef).not.toHaveBeenCalled()
    })

    it('resolves the ref via getCanvasAssetRef when a vault is open', async () => {
      const fakeCtx = { marker: 'ctx' }
      vi.mocked(buildAssetServiceContext).mockReturnValue(fakeCtx as never)
      vi.mocked(getCanvasAssetRef).mockReturnValue(
        'memry-file://local/x/attachments/canvas-assets/found.png'
      )
      const handlers = await registerAndGetHandlers()

      const result = await handlers[CanvasChannels.invoke.GET_ASSET](
        {},
        { canvasId: 'canvas-1', fileId: 'file-1' }
      )

      expect(getCanvasAssetRef).toHaveBeenCalledWith(fakeCtx, 'canvas-1', 'file-1')
      expect(result).toEqual({ ref: 'memry-file://local/x/attachments/canvas-assets/found.png' })
    })
  })

  describe('canvas:list-assets', () => {
    it('returns { assets: [] } when buildAssetServiceContext() returns null', async () => {
      vi.mocked(buildAssetServiceContext).mockReturnValue(null)
      const handlers = await registerAndGetHandlers()

      const result = await handlers[CanvasChannels.invoke.LIST_ASSETS]({}, { canvasId: 'canvas-1' })

      expect(result).toEqual({ assets: [] })
      expect(listCanvasAssetDescriptors).not.toHaveBeenCalled()
    })

    it('returns the descriptors via listCanvasAssetDescriptors when a vault is open', async () => {
      const fakeCtx = { marker: 'ctx' }
      vi.mocked(buildAssetServiceContext).mockReturnValue(fakeCtx as never)
      const descriptors = [
        {
          fileId: 'file-1',
          attachmentId: 'att-1',
          contentHash: 'hash-1',
          chunkHashes: ['chunk-1'],
          mimeType: 'image/png',
          sizeBytes: 5,
          filename: 'hash-1.png'
        }
      ]
      vi.mocked(listCanvasAssetDescriptors).mockReturnValue(descriptors)
      const handlers = await registerAndGetHandlers()

      const result = await handlers[CanvasChannels.invoke.LIST_ASSETS]({}, { canvasId: 'canvas-1' })

      expect(listCanvasAssetDescriptors).toHaveBeenCalledWith(fakeCtx, 'canvas-1')
      expect(result).toEqual({ assets: descriptors })
    })
  })

  describe('canvas:update — asset sidecar injection + GC', () => {
    it('injects the sidecar and reconciles assets when a vault is open and scene is provided', async () => {
      await withWorkingCanvasContext()
      const fakeCtx = { marker: 'ctx' }
      vi.mocked(buildAssetServiceContext).mockReturnValue(fakeCtx as never)
      vi.mocked(injectSceneAssetSidecar).mockReturnValue('{"scene":"with-sidecar"}')
      vi.mocked(updateCanvas).mockReturnValue({
        ok: true,
        summary: { id: 'canvas-1', title: null, createdAt: 0, updatedAt: 1 }
      } as never)
      const handlers = await registerAndGetHandlers()

      await handlers[CanvasChannels.invoke.UPDATE]({}, { id: 'canvas-1', scene: '{"scene":"raw"}' })

      expect(injectSceneAssetSidecar).toHaveBeenCalledWith(fakeCtx, 'canvas-1', '{"scene":"raw"}')
      // updateCanvas persists the sidecar-injected scene, not the raw one.
      expect(vi.mocked(updateCanvas).mock.calls[0][3]).toMatchObject({
        scene: '{"scene":"with-sidecar"}'
      })
      expect(syncCanvasUpdate).toHaveBeenCalledWith('canvas-1', '{"scene":"with-sidecar"}')
      expect(reconcileCanvasAssets).toHaveBeenCalledWith(
        fakeCtx,
        'canvas-1',
        '{"scene":"with-sidecar"}'
      )
    })

    it('skips sidecar injection and GC when no vault is open (ctx is null)', async () => {
      await withWorkingCanvasContext()
      vi.mocked(buildAssetServiceContext).mockReturnValue(null)
      vi.mocked(updateCanvas).mockReturnValue({
        ok: true,
        summary: { id: 'canvas-1', title: null, createdAt: 0, updatedAt: 1 }
      } as never)
      const handlers = await registerAndGetHandlers()

      await handlers[CanvasChannels.invoke.UPDATE]({}, { id: 'canvas-1', scene: '{"scene":"raw"}' })

      expect(injectSceneAssetSidecar).not.toHaveBeenCalled()
      expect(vi.mocked(updateCanvas).mock.calls[0][3]).toMatchObject({ scene: '{"scene":"raw"}' })
      expect(reconcileCanvasAssets).not.toHaveBeenCalled()
    })

    it('reports tooLarge when the saved scene could not sync', async () => {
      await withWorkingCanvasContext()
      vi.mocked(buildAssetServiceContext).mockReturnValue(null)
      vi.mocked(updateCanvas).mockReturnValue({
        ok: true,
        summary: { id: 'canvas-1', title: null, createdAt: 0, updatedAt: 1 }
      } as never)
      vi.mocked(syncCanvasUpdate).mockReturnValue(false)
      const handlers = await registerAndGetHandlers()

      const result = await handlers[CanvasChannels.invoke.UPDATE](
        {},
        { id: 'canvas-1', scene: 'x' }
      )

      expect(result).toMatchObject({ id: 'canvas-1', tooLarge: true })
    })

    it('reports tooLarge:false on a scene that synced', async () => {
      await withWorkingCanvasContext()
      vi.mocked(buildAssetServiceContext).mockReturnValue(null)
      vi.mocked(updateCanvas).mockReturnValue({
        ok: true,
        summary: { id: 'canvas-1', title: null, createdAt: 0, updatedAt: 1 }
      } as never)
      vi.mocked(syncCanvasUpdate).mockReturnValue(true)
      const handlers = await registerAndGetHandlers()

      const result = await handlers[CanvasChannels.invoke.UPDATE](
        {},
        { id: 'canvas-1', scene: 'x' }
      )

      expect(result).toMatchObject({ id: 'canvas-1', tooLarge: false })
    })

    it('throws a distinguishable error when the optimistic guard rejects', async () => {
      await withWorkingCanvasContext()
      vi.mocked(buildAssetServiceContext).mockReturnValue(null)
      vi.mocked(updateCanvas).mockReturnValue({ ok: false, reason: 'conflict' } as never)
      const handlers = await registerAndGetHandlers()

      await expect(
        handlers[CanvasChannels.invoke.UPDATE](
          {},
          { id: 'canvas-1', scene: 'x', expectedUpdatedAt: 1 }
        )
      ).rejects.toThrow(/modified/i)
    })
  })

  describe('canvas:delete — asset GC', () => {
    it('reconciles assets before deleting when a vault is open', async () => {
      await withWorkingCanvasContext()
      const fakeCtx = { marker: 'ctx' }
      vi.mocked(buildAssetServiceContext).mockReturnValue(fakeCtx as never)
      vi.mocked(deleteCanvas).mockReturnValue(true)
      const handlers = await registerAndGetHandlers()

      const result = await handlers[CanvasChannels.invoke.DELETE]({}, 'canvas-1')

      expect(reconcileCanvasAssets).toHaveBeenCalledWith(fakeCtx, 'canvas-1', '')
      expect(syncCanvasDelete).toHaveBeenCalledWith('canvas-1')
      expect(result).toEqual({ success: true })
    })

    it('skips reconcile when no vault is open (ctx is null)', async () => {
      await withWorkingCanvasContext()
      vi.mocked(buildAssetServiceContext).mockReturnValue(null)
      vi.mocked(deleteCanvas).mockReturnValue(true)
      const handlers = await registerAndGetHandlers()

      await handlers[CanvasChannels.invoke.DELETE]({}, 'canvas-1')

      expect(reconcileCanvasAssets).not.toHaveBeenCalled()
    })
  })
})

describe('canvas live-ownership handlers', () => {
  afterEach(() => {
    unregisterCanvasHandlers()
    vi.clearAllMocks()
  })

  function fakeWindow(id: number) {
    return { id, once: vi.fn(), webContents: {} }
  }

  it('hooks the window "closed" listener once, however many canvases it opens', async () => {
    // Regression: registering once('closed') per live-opened stacks a listener
    // for every canvas the user visits in that window, which leaks and trips
    // Electron's max-listeners warning.
    const { BrowserWindow } = await import('electron')
    const win = fakeWindow(7)
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win as never)
    const handlers = await registerAndGetHandlers()

    await handlers[CanvasChannels.invoke.LIVE_OPENED]({ sender: win.webContents }, 'canvas-1')
    await handlers[CanvasChannels.invoke.LIVE_OPENED]({ sender: win.webContents }, 'canvas-2')
    await handlers[CanvasChannels.invoke.LIVE_OPENED]({ sender: win.webContents }, 'canvas-3')

    expect(win.once).toHaveBeenCalledTimes(1)
    expect(win.once).toHaveBeenCalledWith('closed', expect.any(Function))
  })

  it('hooks each distinct window separately', async () => {
    const { BrowserWindow } = await import('electron')
    const first = fakeWindow(1)
    const second = fakeWindow(2)
    const handlers = await registerAndGetHandlers()

    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(first as never)
    await handlers[CanvasChannels.invoke.LIVE_OPENED]({ sender: first.webContents }, 'canvas-1')
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(second as never)
    await handlers[CanvasChannels.invoke.LIVE_OPENED]({ sender: second.webContents }, 'canvas-1')

    expect(first.once).toHaveBeenCalledTimes(1)
    expect(second.once).toHaveBeenCalledTimes(1)
  })

  it('re-hooks a window id after its close listener fired', async () => {
    const { BrowserWindow } = await import('electron')
    const win = fakeWindow(3)
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win as never)
    const handlers = await registerAndGetHandlers()

    await handlers[CanvasChannels.invoke.LIVE_OPENED]({ sender: win.webContents }, 'canvas-1')
    // Fire the registered 'closed' callback, as Electron would.
    const onClosed = win.once.mock.calls[0][1] as () => void
    onClosed()
    await handlers[CanvasChannels.invoke.LIVE_OPENED]({ sender: win.webContents }, 'canvas-1')

    expect(win.once).toHaveBeenCalledTimes(2)
  })

  it('ignores a report with no resolvable window or a blank canvas id', async () => {
    const { BrowserWindow } = await import('electron')
    const handlers = await registerAndGetHandlers()

    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null as never)
    expect(await handlers[CanvasChannels.invoke.LIVE_OPENED]({ sender: {} }, 'canvas-1')).toEqual({
      ok: false
    })

    const win = fakeWindow(9)
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win as never)
    expect(
      await handlers[CanvasChannels.invoke.LIVE_CLOSED]({ sender: win.webContents }, '')
    ).toEqual({ ok: false })
    expect(win.once).not.toHaveBeenCalled()
  })
})

describe('canvas rollout telemetry', () => {
  afterEach(() => {
    unregisterCanvasHandlers()
    vi.clearAllMocks()
  })

  it('emits canvas_created when a canvas is created', async () => {
    await withWorkingCanvasContext()
    vi.mocked(createCanvas).mockReturnValue({
      id: 'canvas-1',
      title: 'Board',
      createdAt: 0,
      updatedAt: 0,
      scene: ''
    })
    const handlers = await registerAndGetHandlers()

    await handlers[CanvasChannels.invoke.CREATE]({}, { title: 'Board' })

    expect(trackMainEvent).toHaveBeenCalledWith('canvas_created', {
      surface: 'canvas',
      action: 'created',
      objectType: 'canvas',
      result: 'success'
    })
  })

  it('emits canvas_opened when a canvas is fetched', async () => {
    await withWorkingCanvasContext()
    vi.mocked(getCanvas).mockReturnValue({
      id: 'canvas-1',
      title: null,
      createdAt: 0,
      updatedAt: 0,
      scene: ''
    })
    const handlers = await registerAndGetHandlers()

    await handlers[CanvasChannels.invoke.GET]({}, 'canvas-1')

    expect(trackMainEvent).toHaveBeenCalledWith('canvas_opened', {
      surface: 'canvas',
      action: 'opened',
      objectType: 'canvas',
      result: 'success'
    })
  })

  it('does not emit canvas_opened for a missing canvas', async () => {
    await withWorkingCanvasContext()
    vi.mocked(getCanvas).mockReturnValue(null)
    const handlers = await registerAndGetHandlers()

    await handlers[CanvasChannels.invoke.GET]({}, 'does-not-exist')

    expect(trackMainEvent).not.toHaveBeenCalledWith('canvas_opened', expect.anything())
  })
})
