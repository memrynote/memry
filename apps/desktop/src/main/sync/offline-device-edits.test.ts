import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { createSyncAdapterRegistry } from '@memry/sync-core'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import type { VectorClock } from '@memry/contracts/sync-api'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'
import { asSyncDb } from '@tests/utils/test-db'
import {
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'
import { initTaskSyncService, resetTaskSyncService } from '@memry/sync-client/task-sync'
import { initSettingsSyncManager, resetSettingsSyncManager } from '@memry/sync-client/settings-sync'
import { SyncEngine } from './engine'
import { getRemoteSyncAdapter } from './item-handlers'
import { enqueueLocalSyncDelete, enqueueLocalSyncUpdate } from './local-mutations'
import type { EncryptItemInput } from './encrypt'
import type * as RebindModule from './engine/offline-queue-rebind'

const rebind = vi.hoisted(() => ({ fail: false }))
vi.mock('./engine/offline-queue-rebind', async (importOriginal) => {
  const actual = await importOriginal<typeof RebindModule>()
  return {
    rebindQueuedOfflineEdits: (...args: Parameters<typeof actual.rebindQueuedOfflineEdits>) => {
      if (rebind.fail) throw new Error('rebind failed')
      return actual.rebindQueuedOfflineEdits(...args)
    }
  }
})

/**
 * #2897: a session with no device id (device keys missing, #2866) keeps
 * editing. Those edits and deletes must queue, and once the device id is back
 * they must reach the server under it, with no `_offline` tick (chapter 06
 * §6.6). Real services, real queue, real engine push; only the crypto and
 * HTTP edges are stubbed so the outgoing payloads can be read.
 */
describe('edits made while the device id is missing (#2897)', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    resetTagDefinitionSyncService()
    resetTaskSyncService()
    resetSettingsSyncManager()
    vi.restoreAllMocks()
    rebind.fail = false
  })

  const keys = (deviceId: string) => ({
    secretKey: new Uint8Array(64),
    publicKey: new Uint8Array(32),
    deviceId
  })

  /** No device row and no signing keys; a tag edit, a task delete and a setting queued. */
  async function sessionWithOfflineEdits() {
    const getSigningKeys = vi.fn().mockResolvedValue(null)
    const db = asSyncDb(getDb().db)
    const base = createMockDeps(getDb(), { getSigningKeys })
    const services = { queue: base.queue, db, getDeviceId: () => getCurrentDeviceId(db) }
    const tagSync = initTagDefinitionSyncService(services)
    const taskSync = initTaskSyncService(services)
    const settings = initSettingsSyncManager(services)
    const record = (type: 'tag_definition' | 'task' | 'settings', local: object) => ({
      type,
      kind: 'record' as const,
      local: local as never,
      remote: getRemoteSyncAdapter(type)
    })
    const deps = {
      ...base,
      adapters: createSyncAdapterRegistry([
        record('tag_definition', tagSync),
        record('task', taskSync),
        record('settings', settings)
      ])
    }
    db.insert(tagDefinitions)
      .values({ name: 'work', color: 'red', clock: { 'device-1': 1 } } as never)
      .run()

    enqueueLocalSyncUpdate('tag_definition', 'work')
    enqueueLocalSyncDelete(
      'task',
      'task-1',
      JSON.stringify({ id: 'task-1', title: 'Gone', clock: { 'device-1': 2 } })
    )
    settings.updateField('general.theme', 'dark')

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

    const registerDevice = (): void => {
      db.insert(syncDevices)
        .values({
          id: 'device-1',
          name: 'This device',
          platform: 'darwin',
          appVersion: '2026.10.9',
          linkedAt: new Date(),
          isCurrentDevice: true,
          signingPublicKey: 'pk'
        })
        .run()
    }
    /** What reached the server: encrypt inputs whose id was in a POST body. */
    const sentBodies = () => {
      const posted = new Set(
        post.mock.calls
          .flatMap(([, body]) => (body as { items: { id: string }[] }).items)
          .map((item) => item.id)
      )
      return sent
        .filter((input) => posted.has(input.id))
        .map((input) => ({
          type: input.type,
          body: JSON.parse(new TextDecoder().decode(input.content)) as {
            clock?: VectorClock
            fieldClocks?: Record<string, VectorClock>
          }
        }))
    }
    const queuedTypes = () =>
      deps.queue
        .peek(10)
        .map((row) => `${row.type}:${row.operation}`)
        .sort()

    return {
      db,
      deps,
      settings,
      getSigningKeys,
      engine: new SyncEngine(deps),
      post,
      registerDevice,
      sentBodies,
      queuedTypes
    }
  }

  it('queues a tag edit, a task delete and a setting, then pushes them under the device id', async () => {
    const s = await sessionWithOfflineEdits()

    // #then — all three are queued, none dropped, and nothing is sent unsigned
    expect(s.queuedTypes()).toEqual(['settings:update', 'tag_definition:update', 'task:delete'])
    await s.engine.push()
    expect(s.post).not.toHaveBeenCalled()

    // #when — the keys are repaired and the device id is back
    s.registerDevice()
    s.getSigningKeys.mockResolvedValue(keys('device-1'))
    await s.engine.push()

    // #then — each change goes out under the device id, never `_offline`
    const byType = new Map(s.sentBodies().map(({ type, body }) => [type, body]))
    expect(byType.get('tag_definition')?.clock).toEqual({ 'device-1': 3 })
    expect(byType.get('task')?.clock).toEqual({ 'device-1': 3 })
    expect(byType.get('settings')?.fieldClocks).toEqual({ 'general.theme': { 'device-1': 1 } })
    expect(JSON.stringify(s.sentBodies())).not.toContain('_offline')
    expect(s.deps.queue.getPendingCount()).toBe(0)

    // #then — the stored clocks match what was sent, so the echo is not a conflict
    expect(
      s.db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'work')).get()?.clock
    ).toEqual({ 'device-1': 3 })
    expect(s.settings.getPayload().fieldClocks).toEqual({ 'general.theme': { 'device-1': 1 } })
  })

  it('rebinds _offline rows that already failed a push, leaving no stale copy behind', async () => {
    const s = await sessionWithOfflineEdits()
    // #given — every row already burned an attempt, so a fresh enqueue cannot
    // coalesce into it (`SyncQueueManager.enqueue` only reuses attempts = 0).
    // `created_at` has 1 s resolution, so a stale row can sort after its
    // rebound copy; date them later to make the push's dedupe prefer them.
    s.db
      .update(syncQueue)
      .set({ attempts: 1, createdAt: new Date(Date.now() + 5_000) })
      .run()

    s.registerDevice()
    s.getSigningKeys.mockResolvedValue(keys('device-1'))
    await s.engine.push()

    // #then — one item per change, none `_offline`, and the queue drained
    expect(
      s
        .sentBodies()
        .map(({ type }) => type)
        .sort()
    ).toEqual(['settings', 'tag_definition', 'task'])
    expect(JSON.stringify(s.sentBodies())).not.toContain('_offline')
    expect(s.deps.queue.getSize()).toBe(0)
  })

  describe('the push holds back _offline clocks when the rebind cannot run', () => {
    it('while the signing keys name a device the device row does not (#2866 repair window)', async () => {
      const s = await sessionWithOfflineEdits()
      s.getSigningKeys.mockResolvedValue(keys('device-1'))

      await s.engine.push()

      expect(JSON.stringify(s.sentBodies())).not.toContain('_offline')
      expect(s.queuedTypes()).toEqual(['settings:update', 'tag_definition:update', 'task:delete'])
    })

    it('while the rebind throws', async () => {
      const s = await sessionWithOfflineEdits()
      s.registerDevice()
      s.getSigningKeys.mockResolvedValue(keys('device-1'))
      rebind.fail = true

      await s.engine.push()

      expect(JSON.stringify(s.sentBodies())).not.toContain('_offline')
      expect(s.queuedTypes()).toEqual(['settings:update', 'tag_definition:update', 'task:delete'])
    })
  })
})
