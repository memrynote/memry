import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
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
import { initTaskSyncService, resetTaskSyncService } from '@memry/sync-client/task-sync'
import { initSettingsSyncManager, resetSettingsSyncManager } from '@memry/sync-client/settings-sync'
import { SyncEngine } from './engine'
import { getRemoteSyncAdapter } from './item-handlers'
import { enqueueLocalSyncDelete, enqueueLocalSyncUpdate } from './local-mutations'
import type { EncryptItemInput } from './encrypt'

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
  })

  it('queues a tag edit, a task delete and a setting, then pushes them under the device id', async () => {
    // #given — a session whose device id and signing keys are missing
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

    // #when — the user edits a sweep-exempt type, deletes a task, and changes a setting
    enqueueLocalSyncUpdate('tag_definition', 'work')
    enqueueLocalSyncDelete(
      'task',
      'task-1',
      JSON.stringify({ id: 'task-1', title: 'Gone', clock: { 'device-1': 2 } })
    )
    settings.updateField('general.theme', 'dark')

    // #then — all three are queued, none dropped
    expect(
      deps.queue
        .peek(10)
        .map((row) => `${row.type}:${row.operation}`)
        .sort()
    ).toEqual(['settings:update', 'tag_definition:update', 'task:delete'])

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
    const engine = new SyncEngine(deps)
    await engine.push()
    expect(post).not.toHaveBeenCalled()

    // #when — the keys are repaired and the device id is back
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
    getSigningKeys.mockResolvedValue({
      secretKey: new Uint8Array(64),
      publicKey: new Uint8Array(32),
      deviceId: 'device-1'
    })
    await engine.push()

    // #then — each change goes out under the device id, never `_offline`
    const byType = new Map(
      sent.map((input) => [
        input.type,
        JSON.parse(new TextDecoder().decode(input.content)) as {
          clock?: VectorClock
          fieldClocks?: Record<string, VectorClock>
        }
      ])
    )
    expect(byType.get('tag_definition')?.clock).toEqual({ 'device-1': 3 })
    expect(byType.get('task')?.clock).toEqual({ 'device-1': 3 })
    expect(byType.get('settings')?.fieldClocks).toEqual({ 'general.theme': { 'device-1': 1 } })
    for (const input of sent) expect(JSON.stringify(input.clock ?? {})).not.toContain('_offline')
    expect(deps.queue.getPendingCount()).toBe(0)

    // #then — the stored clocks match what was sent, so the echo is not a conflict
    expect(
      db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'work')).get()?.clock
    ).toEqual({ 'device-1': 3 })
    expect(settings.getPayload().fieldClocks).toEqual({ 'general.theme': { 'device-1': 1 } })
  })
})
