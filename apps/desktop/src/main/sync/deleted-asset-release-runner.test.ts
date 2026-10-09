/**
 * #3015 review: the deleted-asset sweep trusts the local view of the vault, so
 * it must wait for a full sync this session. A real SyncEngine (only the HTTP
 * client faked) gates the real runner; the release itself runs on a real data DB.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine } from './engine'
import { deletedAssetReleases } from '@memry/db-schema'
import { createMockDeps, createMockNetwork, setupTestDb } from '@tests/utils/engine-mocks'
import { deletedAssetReleaseRunner } from './deleted-asset-release-runner'

const ctx = vi.hoisted(() => ({
  db: null as unknown,
  dereference: vi.fn(async () => ({ ok: true }))
}))

vi.mock('../canvas/assets/asset-service-context', () => ({
  buildAssetServiceContext: () => ({
    db: ctx.db,
    vaultPath: '/vault',
    dereference: ctx.dereference,
    markWritebackIgnored: () => {}
  })
}))
vi.mock('../vault/init', () => ({ isVaultReachable: () => true }))
vi.mock('../ipc/sync-attachment-handlers', () => ({
  getAttachmentChunkHashes: async (id: string) => [`chunk-of-${id}`]
}))

describe('deleted-asset release runner', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    deletedAssetReleaseRunner.stop()
    vi.restoreAllMocks()
  })

  it('dereferences nothing until a full sync succeeded this session', async () => {
    const http = await import('./http-client')
    // A 400 on the first pull: start() returns normally, nothing was delivered.
    const get = vi
      .spyOn(http, 'getFromServer')
      .mockRejectedValue(new http.SyncServerError('Bad request', 400, 'VALIDATION_ERROR'))
    const testDb = getDb()
    ctx.db = testDb.db
    ctx.dereference.mockClear()
    // A note deleted 40 days ago whose attachment no local note references.
    testDb.db
      .insert(deletedAssetReleases)
      .values({ itemType: 'note', itemId: 'gone', deletedAt: 0, attachmentIds: ['a-1'] })
      .run()

    const engine = new SyncEngine(createMockDeps(testDb, { network: createMockNetwork(true) }))
    await engine.start()

    deletedAssetReleaseRunner.start(() => engine.isCaughtUpWithServer())
    await new Promise((r) => setTimeout(r, 20))
    expect(ctx.dereference).not.toHaveBeenCalled()
    expect(testDb.db.select().from(deletedAssetReleases).all()).toHaveLength(1)

    // Paused: still nothing, even after a sync that delivered.
    get.mockResolvedValue({ items: [], deleted: [], hasMore: false, nextCursor: 0 })
    await engine.fullSync()
    engine.pause()
    deletedAssetReleaseRunner.start(() => engine.isCaughtUpWithServer())
    await new Promise((r) => setTimeout(r, 20))
    expect(ctx.dereference).not.toHaveBeenCalled()

    engine.resume()
    deletedAssetReleaseRunner.start(() => engine.isCaughtUpWithServer())
    await vi.waitFor(() => expect(ctx.dereference).toHaveBeenCalledWith(['chunk-of-a-1']))
    await engine.stop({ skipFinalPush: true })
  })

  it('stops counting as caught up once a later full sync fails', async () => {
    const http = await import('./http-client')
    const get = vi
      .spyOn(http, 'getFromServer')
      .mockResolvedValue({ items: [], deleted: [], hasMore: false, nextCursor: 0 })
    const testDb = getDb()
    ctx.db = testDb.db
    ctx.dereference.mockClear()
    testDb.db
      .insert(deletedAssetReleases)
      .values({ itemType: 'note', itemId: 'gone', deletedAt: 0, attachmentIds: ['a-1'] })
      .run()

    const engine = new SyncEngine(createMockDeps(testDb, { network: createMockNetwork(true) }))
    await engine.start()
    await engine.fullSync()
    expect(engine.isCaughtUpWithServer()).toBe(true)

    // Sync breaks afterwards, still online and not paused.
    get.mockRejectedValue(new http.SyncServerError('Bad request', 400, 'VALIDATION_ERROR'))
    await engine.fullSync().catch(() => {})

    deletedAssetReleaseRunner.start(() => engine.isCaughtUpWithServer())
    await new Promise((r) => setTimeout(r, 20))
    expect(ctx.dereference).not.toHaveBeenCalled()
    expect(testDb.db.select().from(deletedAssetReleases).all()).toHaveLength(1)
    await engine.stop({ skipFinalPush: true })
  })
})
