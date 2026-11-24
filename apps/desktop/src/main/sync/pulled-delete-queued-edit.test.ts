import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { tagCategories } from '@memry/db-schema/schema/tag-categories'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { createSyncAdapterRegistry } from '@memry/sync-core'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import type { VectorClock } from '@memry/contracts/sync-api'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'
import { asSyncDb } from '@tests/utils/test-db'
import {
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'
import { recordTombstoneClock } from '@memry/sync-client/tombstone-clocks'
import { SyncEngine } from './engine'
import { ItemApplier } from './apply-item'
import { getHandler, getRemoteSyncAdapter } from './item-handlers'
import { enqueueLocalSyncUpdate } from './local-mutations'
import type { EncryptItemInput } from './encrypt'

/**
 * #5428: a queued edit of an item a pulled delete removed. Pushed, the frozen
 * payload is an `update` the server stores over its tombstone (`deleted_at =
 * NULL`), and for a clockless tombstone nothing refuses it: the item comes back
 * on every device. Chapter 05 §5.8: the delete wins unless the local clock
 * happens after it, and only then is the local edit (a re-create) still sent.
 * Real tag service, real queue, real apply and engine push; only crypto and
 * HTTP are stubbed.
 */
describe('a queued edit of an item a pulled delete removed (#5428)', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    resetTagDefinitionSyncService()
    vi.restoreAllMocks()
  })

  async function sessionWithQueuedTagEdit(localClock: VectorClock) {
    const db = asSyncDb(getDb().db)
    db.insert(syncDevices)
      .values({
        id: 'device-1',
        name: 'This device',
        platform: 'darwin',
        appVersion: '2026.11.21',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'pk'
      })
      .run()
    const getSigningKeys = vi.fn().mockResolvedValue({
      secretKey: new Uint8Array(64),
      publicKey: new Uint8Array(32),
      deviceId: 'device-1'
    })
    const base = createMockDeps(getDb(), { getSigningKeys })
    const tagSync = initTagDefinitionSyncService({
      queue: base.queue,
      db,
      getDeviceId: () => getCurrentDeviceId(db)
    })
    const remote = getRemoteSyncAdapter('tag_definition')!
    const adapters = createSyncAdapterRegistry([
      {
        type: 'tag_definition',
        kind: 'record' as const,
        local: tagSync as never,
        remote
      }
    ])
    const deps = { ...base, adapters }
    db.insert(tagDefinitions)
      .values({ name: 'work', color: 'red', clock: localClock } as never)
      .run()
    enqueueLocalSyncUpdate('tag_definition', 'work')

    const sent: EncryptItemInput[] = []
    vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation((input) => {
      sent.push(input)
      return {
        pushItem: {
          id: input.id,
          type: input.type,
          operation: input.operation,
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: input.signerDeviceId,
          clock: input.clock
        },
        sizeBytes: 100
      }
    })
    const post = vi.fn().mockImplementation((_path: string, body: { items: { id: string }[] }) =>
      Promise.resolve({
        accepted: body.items.map((item) => item.id),
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000)
      })
    )
    vi.spyOn(await import('./http-client'), 'postToServer').mockImplementation(post)

    const applier = new ItemApplier(db, vi.fn(), adapters)
    const pullDelete = (clock: VectorClock | undefined) =>
      applier.apply({
        itemId: 'work',
        type: 'tag_definition',
        operation: 'delete',
        content: new Uint8Array(),
        clock,
        deletedAt: Math.floor(Date.now() / 1000)
      })
    const pushed = () =>
      post.mock.calls
        .flatMap(([, body]) => (body as { items: { id: string; operation: string }[] }).items)
        .map((item) => `${item.id}:${item.operation}`)

    expect(deps.queue.peek(10).map((row) => `${row.itemId}:${row.operation}`)).toEqual([
      'work:update'
    ])
    return { db, deps, remote, engine: new SyncEngine(deps), pullDelete, pushed, sent }
  }

  it('never pushes the edit over a clockless tombstone', async () => {
    const s = await sessionWithQueuedTagEdit({ 'device-1': 2 })

    expect(s.pullDelete(undefined)).toBe('applied')
    await s.engine.push()

    expect(s.pushed()).toEqual([])
    expect(s.deps.queue.getSize()).toBe(0)
  })

  it('never pushes the edit over a tombstone concurrent with it (the delete wins)', async () => {
    const s = await sessionWithQueuedTagEdit({ 'device-1': 2 })

    expect(s.pullDelete({ 'device-1': 1, 'device-2': 1 })).toBe('applied')
    await s.engine.push()

    expect(s.pushed()).toEqual([])
    expect(s.deps.queue.getSize()).toBe(0)
  })

  it('never pushes the edit when an older build already removed the row (re-delivered delete)', async () => {
    const s = await sessionWithQueuedTagEdit({ 'device-1': 2 })
    // A pre-upgrade build applied the delete but left the queued edit behind.
    s.db.delete(tagDefinitions).where(eq(tagDefinitions.name, 'work')).run()

    expect(s.pullDelete({ 'device-1': 1, 'device-2': 1 })).toBe('skipped')
    await s.engine.push()

    expect(s.pushed()).toEqual([])
    expect(s.deps.queue.getSize()).toBe(0)
  })

  it('keeps the edit queued when a skipped delete finds a live row that builds no payload', async () => {
    const s = await sessionWithQueuedTagEdit({ 'device-1': 3, 'device-2': 1 })
    vi.spyOn(s.remote, 'buildPushPayload').mockReturnValue(null)

    expect(s.pullDelete({ 'device-1': 1, 'device-2': 1 })).toBe('skipped')

    expect(s.deps.queue.peek(10).map((row) => `${row.itemId}:${row.operation}`)).toEqual([
      'work:update'
    ])
  })

  describe('an older build applied the delete and the pull is already past it', () => {
    function removedByOlderBuild(s: Awaited<ReturnType<typeof sessionWithQueuedTagEdit>>) {
      s.db.delete(tagDefinitions).where(eq(tagDefinitions.name, 'work')).run()
      recordTombstoneClock(s.db, 'tag_definition', 'work', { 'device-1': 1, 'device-2': 1 })
    }

    it('retires the frozen edit instead of pushing it over the tombstone', async () => {
      const s = await sessionWithQueuedTagEdit({ 'device-1': 2 })
      removedByOlderBuild(s)

      await s.engine.push()

      expect(s.pushed()).toEqual([])
      expect(s.deps.queue.getSize()).toBe(0)
    })

    it('still sends an edit whose clock happens after the tombstone (a re-create)', async () => {
      const s = await sessionWithQueuedTagEdit({ 'device-1': 3, 'device-2': 1 })
      removedByOlderBuild(s)

      await s.engine.push()

      expect(s.pushed()).toEqual(['work:update'])
    })

    it('retires the edit of a tag category it soft-deleted (no tombstone clock is recorded)', async () => {
      const s = await sessionWithQueuedTagEdit({ 'device-1': 2 })
      s.db
        .insert(tagCategories)
        .values({ id: 'cat-1', name: 'Work', clock: { 'device-1': 2 } })
        .run()
      const handler = getHandler('tag_category')!
      s.deps.queue.enqueue({
        type: 'tag_category',
        itemId: 'cat-1',
        operation: 'update',
        payload: handler.buildPushPayload!(s.db, 'cat-1', '', 'update')!
      })
      s.db.delete(syncQueue).where(eq(syncQueue.itemId, 'work')).run()
      expect(
        handler.applyDelete({ db: s.db, emit: vi.fn() }, 'cat-1', { 'device-1': 1, 'device-2': 1 })
      ).toBe('applied')

      await s.engine.push()

      expect(s.pushed()).toEqual([])
      expect(s.deps.queue.getSize()).toBe(0)
    })

    it('still sends the edit of a soft-deleted tag category when its clock happens after the row clock', async () => {
      const s = await sessionWithQueuedTagEdit({ 'device-1': 2 })
      s.db
        .insert(tagCategories)
        .values({ id: 'cat-1', name: 'Work', clock: { 'device-1': 3, 'device-2': 1 } })
        .run()
      const handler = getHandler('tag_category')!
      s.deps.queue.enqueue({
        type: 'tag_category',
        itemId: 'cat-1',
        operation: 'update',
        payload: handler.buildPushPayload!(s.db, 'cat-1', '', 'update')!
      })
      s.db.delete(syncQueue).where(eq(syncQueue.itemId, 'work')).run()
      // No shipped apply path stores this row: applyDelete keeps a clock at or
      // after the queued edit's. Written directly to pin the re-create escape.
      s.db
        .update(tagCategories)
        .set({ deletedAt: new Date().toISOString(), clock: { 'device-1': 1, 'device-2': 1 } })
        .where(eq(tagCategories.id, 'cat-1'))
        .run()

      await s.engine.push()

      expect(s.pushed()).toEqual(['cat-1:update'])
    })

    it('sends the edit as before when the local row lookup throws', async () => {
      const s = await sessionWithQueuedTagEdit({ 'device-1': 2 })
      removedByOlderBuild(s)
      vi.spyOn(s.remote, 'fetchLocal').mockImplementation(() => {
        throw new Error('lookup failed')
      })

      await s.engine.push()

      expect(s.pushed()).toEqual(['work:update'])
    })
  })

  it('keeps a queued settings edit when a settings delete is pulled', async () => {
    const s = await sessionWithQueuedTagEdit({ 'device-1': 2 })
    s.deps.queue.enqueue({
      type: 'settings',
      itemId: 'settings',
      operation: 'update',
      payload: JSON.stringify({ clock: { 'device-1': 1 } })
    })
    const applier = new ItemApplier(s.db, vi.fn(), undefined)

    expect(
      applier.apply({
        itemId: 'settings',
        type: 'settings',
        operation: 'delete',
        content: new Uint8Array(),
        clock: { 'device-2': 1 }
      })
    ).toBe('skipped')

    expect(s.deps.queue.peek(10).map((row) => `${row.type}:${row.operation}`)).toContain(
      'settings:update'
    )
  })

  it('still sends a re-create whose clock happens after the delete', async () => {
    const s = await sessionWithQueuedTagEdit({ 'device-1': 3, 'device-2': 1 })

    expect(s.pullDelete({ 'device-1': 1, 'device-2': 1 })).toBe('skipped')
    await s.engine.push()

    expect(s.pushed()).toEqual(['work:update'])
    expect(s.deps.queue.getSize()).toBe(0)
  })
})
