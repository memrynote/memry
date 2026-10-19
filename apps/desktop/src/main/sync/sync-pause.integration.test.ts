/**
 * A paused device against a REAL sync-server (#3382).
 *
 * A Mac paused sync, kept writing, and restarted. Its status said Synced for
 * three days while 831 changes went nowhere, and Sync Now ran a full sync that
 * moved nothing and reported success. This spec drives that device through the
 * real engine, a real data.db, and the real Worker: the pause must survive the
 * restart in the status the app reads, and Sync Now must end it and deliver
 * the queued change.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import sodium from 'libsodium-wrappers-sumo'

vi.mock('electron', () => ({
  // Real HTTP against the miniflare listener.
  net: { fetch: (input: RequestInfo, init?: RequestInit) => fetch(input, init) },
  app: { getPath: () => os.tmpdir(), getVersion: () => '99.0.0', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({ getFixedT: () => (key: string) => key })
}))

import { createSyncAdapterRegistry } from '@memry/sync-core'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createMockNetwork, createMockWs } from '@tests/utils/engine-mocks'
import {
  closeDatabase,
  closeIndexDatabase,
  getDatabase,
  initDatabase,
  initIndexDatabase
} from '../database/client'
import { runIndexMigrations, runMigrations } from '../database/migrate'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import { SyncEngine } from './engine'
import { getRemoteSyncAdapter } from './item-handlers'
import { enqueueLocalSyncUpdate } from './local-mutations'

type Harness = {
  start(): Promise<void>
  stop(): Promise<void>
  getD1(): Promise<D1Database>
  getDirectUrl(): Promise<URL>
  createAccessToken(userId: string, deviceId: string): Promise<string>
}

let server: Harness
let tmpDir: string
let dbPath: string
const savedUrl = process.env.SYNC_SERVER_URL

beforeAll(async () => {
  await sodium.ready
  const mod = await import('@memry/sync-harness/simulated-server')
  server = new mod.SimulatedServer() as Harness
  await server.start()
  process.env.SYNC_SERVER_URL = (await server.getDirectUrl()).origin
}, 180_000)

afterAll(async () => {
  process.env.SYNC_SERVER_URL = savedUrl
  await server?.stop()
})

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memry-pause-int-'))
  dbPath = path.join(tmpDir, 'data.db')
})

afterEach(async () => {
  resetTagDefinitionSyncService()
  closeDatabase()
  closeIndexDatabase()
  await rm(tmpDir, { recursive: true, force: true })
})

async function seedAccount(publicKey: Uint8Array): Promise<{ deviceId: string; token: string }> {
  const db = await server.getD1()
  const userId = randomUUID()
  const deviceId = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 5368709120, ?, ?)`
    )
    .bind(userId, `${userId}@example.test`, now, now)
    .run()
  await db
    .prepare(
      `INSERT INTO sync_entitlements (
         user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at
       ) VALUES (?, 'believer', 'active', 'test_seed', 53687091200, 209715200, NULL, 365, ?)`
    )
    .bind(userId, now)
    .run()
  await db
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, vault_id, created_at, updated_at)
       VALUES (?, ?, 'test-device', 'test', '99.0.0', ?, 'default', ?, ?)`
    )
    .bind(deviceId, userId, sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL), now, now)
    .run()
  await db
    .prepare('INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0)')
    .bind(userId)
    .run()
  return { deviceId, token: await server.createAccessToken(userId, deviceId) }
}

describe('a paused device against a real sync server', () => {
  it('reports the pause after a restart, and Sync Now ends it and delivers the queued change', async () => {
    const signing = sodium.crypto_sign_keypair()
    const vaultKey = sodium.randombytes_buf(32)
    const { deviceId, token } = await seedAccount(signing.publicKey)

    /** The sync stack the runtime wires up, over the open data.db. */
    const startSync = (): SyncEngine => {
      resetTagDefinitionSyncService()
      const db = getDatabase() as unknown as DrizzleDb
      const queue = new SyncQueueManager(db)
      const tags = initTagDefinitionSyncService({
        queue,
        db,
        getDeviceId: () => getCurrentDeviceId(db)
      })
      return new SyncEngine({
        queue,
        network: createMockNetwork(),
        ws: createMockWs(),
        getAccessToken: async () => token,
        getVaultKey: async () => vaultKey.slice(),
        getSigningKeys: async () => ({
          secretKey: signing.privateKey.slice(),
          publicKey: signing.publicKey,
          deviceId
        }),
        getDevicePublicKey: async () => signing.publicKey,
        db,
        emitToRenderer: () => {},
        adapters: createSyncAdapterRegistry([
          {
            type: 'tag_definition',
            kind: 'record',
            local: tags as never,
            remote: getRemoteSyncAdapter('tag_definition')
          }
        ])
      })
    }
    const serverTags = async (): Promise<string[]> => {
      const d1 = await server.getD1()
      const { results } = await d1
        .prepare('SELECT item_id FROM sync_items WHERE item_type = ? ORDER BY item_id')
        .bind('tag_definition')
        .all<{ item_id: string }>()
      return results.map((row) => row.item_id)
    }

    runMigrations(dbPath)
    initDatabase(dbPath)
    // The full sync seeds unclocked notes from the note index.
    const indexPath = path.join(tmpDir, 'index.db')
    runIndexMigrations(indexPath)
    initIndexDatabase(indexPath)
    getDatabase()
      .insert(syncDevices)
      .values({
        id: deviceId,
        name: 'This device',
        platform: 'darwin',
        appVersion: '99.0.0',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: sodium.to_base64(signing.publicKey)
      } as never)
      .run()
    getOrCreateVaultUuid(getDatabase())

    // The user pauses and keeps writing. A full sync now touches nothing.
    const before = startSync()
    before.pause('popover')
    getDatabase()
      .insert(tagDefinitions)
      .values({ name: 'written-while-paused', color: 'red', clock: { [deviceId]: 1 } } as never)
      .run()
    enqueueLocalSyncUpdate('tag_definition', 'written-while-paused')
    await expect(before.fullSync()).resolves.toEqual({ status: 'skipped', reason: 'paused' })
    await before.stop()

    // The app restarts. The status read at launch is the one every surface
    // shows; before #3382 it said idle, so the Mac showed Synced.
    const after = startSync()
    expect(after.getStatus()).toMatchObject({ status: 'paused', pendingCount: 1 })
    expect(await serverTags()).toEqual([])

    await expect(after.syncNow()).resolves.toEqual({ success: true })

    expect(after.getStatus()).toMatchObject({ status: 'idle', pendingCount: 0 })
    expect(await serverTags()).toEqual(['written-while-paused'])
    await after.stop()
  }, 180_000)
})
