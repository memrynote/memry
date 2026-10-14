import { describe, it, expect, vi, beforeEach } from 'vitest'

import type * as AssetService from './asset-service'

// vi.mock factories are hoisted above the file body, so the mock fns they reference
// must come from vi.hoisted() (which runs first) — a plain top-level `const` would not
// be initialized yet when the factory executes.
const {
  isDatabaseInitialized,
  getDatabase,
  getVaultStatus,
  getOrCreateVaultUuid,
  getCanvasAssetIO,
  getValidAccessToken,
  getSyncEngine,
  resolveSyncServerUrl,
  markWritebackIgnored,
  trackMainEvent,
  dereferenceChunks,
  getCanvasFilePath,
  readCanvasScene,
  releaseHoldsNotInScene
} = vi.hoisted(() => ({
  isDatabaseInitialized: vi.fn(),
  getDatabase: vi.fn(),
  getVaultStatus: vi.fn(),
  getOrCreateVaultUuid: vi.fn(),
  getCanvasAssetIO: vi.fn(),
  getValidAccessToken: vi.fn(),
  getSyncEngine: vi.fn(),
  resolveSyncServerUrl: vi.fn(),
  markWritebackIgnored: vi.fn(),
  trackMainEvent: vi.fn(),
  dereferenceChunks: vi.fn(),
  getCanvasFilePath: vi.fn(),
  readCanvasScene: vi.fn(),
  releaseHoldsNotInScene: vi.fn()
}))

vi.mock('../../database/client', () => ({ isDatabaseInitialized, getDatabase }))
vi.mock('../../vault/index', () => ({ getStatus: getVaultStatus }))
vi.mock('../../agent/storage/vault-id', () => ({ getOrCreateVaultUuid }))
vi.mock('../../ipc/sync-attachment-handlers', () => ({ getCanvasAssetIO }))
vi.mock('../../sync/token-manager', () => ({ getValidAccessToken }))
vi.mock('../../sync/runtime', () => ({ getSyncEngine }))
vi.mock('@memry/sync-client/sync-server-url', () => ({ resolveSyncServerUrl }))
vi.mock('../../sync/crdt-writeback', () => ({ markWritebackIgnored }))
vi.mock('../../telemetry/track', () => ({ trackMainEvent }))
vi.mock('./attachment-dereference', () => ({ dereferenceChunks }))
vi.mock('../store', () => ({ getCanvasFilePath, readCanvasScene }))
vi.mock('./asset-service', async (importOriginal) => ({
  ...(await importOriginal<typeof AssetService>()),
  releaseHoldsNotInScene
}))

import {
  buildAssetServiceContext,
  canUploadCanvasAssets,
  releaseUnshownCanvasHolds
} from './asset-service-context'

describe('buildAssetServiceContext', () => {
  const fakeDb = { marker: 'db' }

  beforeEach(() => {
    vi.clearAllMocks()
    isDatabaseInitialized.mockReturnValue(true)
    getVaultStatus.mockReturnValue({ path: '/vault/path' })
    getDatabase.mockReturnValue(fakeDb)
    getOrCreateVaultUuid.mockReturnValue('vault-uuid-1')
  })

  it('returns null when the database is not initialized', () => {
    isDatabaseInitialized.mockReturnValue(false)

    expect(buildAssetServiceContext()).toBeNull()
    expect(getVaultStatus).not.toHaveBeenCalled()
  })

  it('returns null when the vault has no path (vault not open)', () => {
    getVaultStatus.mockReturnValue({ path: '' })

    expect(buildAssetServiceContext()).toBeNull()
    expect(getDatabase).not.toHaveBeenCalled()
  })

  it('returns a populated context wired to the vault db/id/path when open', () => {
    const ctx = buildAssetServiceContext()

    expect(ctx).not.toBeNull()
    expect(ctx?.db).toBe(fakeDb)
    expect(ctx?.vaultId).toBe('vault-uuid-1')
    expect(ctx?.vaultPath).toBe('/vault/path')
    expect(ctx?.markWritebackIgnored).toBe(markWritebackIgnored)
    expect(ctx?.trackEvent).toBe(trackMainEvent)
  })

  describe('uploadAttachment', () => {
    it('rejects when getCanvasAssetIO() is null (sync not initialized)', async () => {
      getCanvasAssetIO.mockReturnValue(null)
      const ctx = buildAssetServiceContext()

      await expect(ctx!.uploadAttachment('canvas-1', '/tmp/file.png')).rejects.toThrow(
        'Sync is not initialized'
      )
    })

    it('delegates to the resolved IO when sync is initialized', async () => {
      const uploadResult = { attachmentId: 'att-1', manifest: { chunks: [] } }
      const uploadAttachment = vi.fn().mockResolvedValue(uploadResult)
      getCanvasAssetIO.mockReturnValue({ uploadAttachment, downloadAttachment: vi.fn() })
      const ctx = buildAssetServiceContext()

      const result = await ctx!.uploadAttachment('canvas-1', '/tmp/file.png')

      expect(uploadAttachment).toHaveBeenCalledWith('canvas-1', '/tmp/file.png')
      expect(result).toBe(uploadResult)
    })
  })

  describe('downloadAttachment', () => {
    it('rejects when getCanvasAssetIO() is null (sync not initialized)', async () => {
      getCanvasAssetIO.mockReturnValue(null)
      const ctx = buildAssetServiceContext()

      await expect(ctx!.downloadAttachment('att-1', '/tmp/target.png')).rejects.toThrow(
        'Sync is not initialized'
      )
    })

    it('delegates to the resolved IO when sync is initialized', async () => {
      const downloadAttachment = vi.fn().mockResolvedValue(undefined)
      getCanvasAssetIO.mockReturnValue({ uploadAttachment: vi.fn(), downloadAttachment })
      const ctx = buildAssetServiceContext()

      await ctx!.downloadAttachment('att-1', '/tmp/target.png')

      expect(downloadAttachment).toHaveBeenCalledWith('att-1', '/tmp/target.png')
    })
  })

  describe('dereference', () => {
    it('maps dereferenceChunks({ok}) through, dropping the status field', async () => {
      dereferenceChunks.mockResolvedValue({ ok: true, status: 200 })
      getValidAccessToken.mockResolvedValue('token-abc')
      resolveSyncServerUrl.mockReturnValue('https://sync.example.com')
      const ctx = buildAssetServiceContext()

      const result = await ctx!.dereference(['chunk-1', 'chunk-2'])

      expect(result).toEqual({ ok: true })
      expect(dereferenceChunks).toHaveBeenCalledWith(
        ['chunk-1', 'chunk-2'],
        expect.objectContaining({
          getAccessToken: expect.any(Function),
          getSyncServerUrl: expect.any(Function),
          getVaultId: expect.any(Function)
        })
      )

      const deps = dereferenceChunks.mock.calls[0][1]
      await expect(deps.getAccessToken()).resolves.toBe('token-abc')
      expect(deps.getSyncServerUrl()).toBe('https://sync.example.com')
      expect(deps.getVaultId()).toBe('vault-uuid-1')
    })

    it('surfaces ok:false without throwing (offline / 404 / missing token)', async () => {
      dereferenceChunks.mockResolvedValue({ ok: false, status: 0 })
      const ctx = buildAssetServiceContext()

      const result = await ctx!.dereference(['chunk-1'])

      expect(result).toEqual({ ok: false })
    })
  })
})

describe('canUploadCanvasAssets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('says no — without reading the keychain — while the sync runtime is down', async () => {
    getSyncEngine.mockReturnValue(null)

    await expect(canUploadCanvasAssets()).resolves.toBe(false)
    expect(getValidAccessToken).not.toHaveBeenCalled()
    // Asking must never construct the shared upload queue: it would bind the
    // NetworkMonitor of the moment, which does not exist yet.
    expect(getCanvasAssetIO).not.toHaveBeenCalled()
  })

  it('says no when the session has no access token (signed out / refresh rejected)', async () => {
    getSyncEngine.mockReturnValue({ marker: 'engine' })
    getValidAccessToken.mockResolvedValue(null)

    await expect(canUploadCanvasAssets()).resolves.toBe(false)
  })

  it('says no rather than throwing when the token lookup itself fails', async () => {
    getSyncEngine.mockReturnValue({ marker: 'engine' })
    getValidAccessToken.mockRejectedValue(new Error('keychain unavailable'))

    await expect(canUploadCanvasAssets()).resolves.toBe(false)
  })

  it('says yes when sync is running and the session has a token', async () => {
    getSyncEngine.mockReturnValue({ marker: 'engine' })
    getValidAccessToken.mockResolvedValue('token-abc')

    await expect(canUploadCanvasAssets()).resolves.toBe(true)
  })
})

// #3035: the post-apply release reads the canvas's current scene off disk.
describe('releaseUnshownCanvasHolds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isDatabaseInitialized.mockReturnValue(true)
    getVaultStatus.mockReturnValue({ path: '/vault/path' })
    getDatabase.mockReturnValue({ marker: 'db' })
    getOrCreateVaultUuid.mockReturnValue('vault-uuid-1')
    releaseHoldsNotInScene.mockResolvedValue({ ok: true })
  })

  it('releases against the scene currently on disk', async () => {
    getCanvasFilePath.mockReturnValue('canvases/c1.excalidraw')
    readCanvasScene.mockReturnValue('{"scene":1}')

    await releaseUnshownCanvasHolds('c1')

    expect(readCanvasScene).toHaveBeenCalledWith('/vault/path', 'canvases/c1.excalidraw')
    expect(releaseHoldsNotInScene).toHaveBeenCalledWith(expect.anything(), 'c1', '{"scene":1}')
  })

  it('keeps the holds of a deleted canvas', async () => {
    getCanvasFilePath.mockReturnValue(null)

    await releaseUnshownCanvasHolds('c1')

    expect(releaseHoldsNotInScene).not.toHaveBeenCalled()
  })

  it('never throws when the release fails', async () => {
    getCanvasFilePath.mockReturnValue('canvases/c1.excalidraw')
    readCanvasScene.mockReturnValue('{}')
    releaseHoldsNotInScene.mockResolvedValueOnce({ ok: false })
    await expect(releaseUnshownCanvasHolds('c1')).resolves.toBeUndefined()
    releaseHoldsNotInScene.mockRejectedValueOnce(new Error('boom'))
    await expect(releaseUnshownCanvasHolds('c1')).resolves.toBeUndefined()
  })
})
