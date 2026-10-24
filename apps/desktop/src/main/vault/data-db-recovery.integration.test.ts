/**
 * data.db recovery against a REAL sync-server (#3248, follow-up to #2595).
 *
 * Recovery replaces data.db with a fresh one. The vault's identity lives in
 * that file (`vault_metadata`), and the sync header, the server's vault slot
 * and the CRDT store are all keyed on it. This spec drives the real recovery
 * entry point (`offerDataDbRecovery`, dialog answered "Recover") between two
 * real sync rounds against the real Worker, and checks that the rebuilt
 * database syncs the SAME vault: everything pushed before comes back from
 * cursor 0, and the change that was still queued is pushed exactly once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import sodium, { base64_variants, ready, to_base64 } from 'libsodium-wrappers-sumo'

vi.mock('electron', () => ({
  // Real HTTP against the miniflare listener.
  net: { fetch: (input: RequestInfo, init?: RequestInit) => fetch(input, init) },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  app: { getPath: () => os.tmpdir(), getVersion: () => '99.0.0', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({ getFixedT: () => (key: string) => key })
}))

import { eq } from 'drizzle-orm'
import { createSyncAdapterRegistry } from '@memry/sync-core'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { createMockNetwork, createMockWs } from '@tests/utils/engine-mocks'
import { closeDatabase, getDatabase, initDatabase } from '../database/client'
import { runMigrations } from '../database/migrate'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { SyncEngine } from '../sync/engine'
import { getRemoteSyncAdapter } from '../sync/item-handlers'
import { enqueueLocalSyncUpdate } from '../sync/local-mutations'
import { offerDataDbRecovery } from './data-db-recovery-prompt'

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
  await ready
  const mod = await import('@memry/sync-harness/simulated-server')
  server = new mod.SimulatedServer()
  await server.start()
  process.env.SYNC_SERVER_URL = (await server.getDirectUrl()).origin
}, 180_000)

afterAll(async () => {
  process.env.SYNC_SERVER_URL = savedUrl
  await server?.stop()
})

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memry-recovery-int-'))
  dbPath = path.join(tmpDir, 'data.db')
})

afterEach(async () => {
  resetTagDefinitionSyncService()
  closeDatabase()
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
    .bind(deviceId, userId, to_base64(publicKey, base64_variants.ORIGINAL), now, now)
    .run()
  await db
    .prepare('INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0)')
    .bind(userId)
    .run()
  return { deviceId, token: await server.createAccessToken(userId, deviceId) }
}

describe('data.db recovery followed by a real sync round trip', () => {
  it('keeps the vault identity, pulls every synced item from cursor 0 and pushes the replayed queue once', async () => {
    const signing = sodium.crypto_sign_keypair()
    const vaultKey = sodium.randombytes_buf(32)
    const { deviceId, token } = await seedAccount(signing.publicKey)

    /** The sync stack the runtime wires up, over whatever data.db is open now. */
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
    const addTag = (name: string): void => {
      getDatabase()
        .insert(tagDefinitions)
        .values({ name, color: 'red', clock: { [deviceId]: 1 } } as never)
        .run()
      enqueueLocalSyncUpdate('tag_definition', name)
    }

    // A synced device: registered, with two tags on the server and one still queued.
    runMigrations(dbPath)
    initDatabase(dbPath)
    getDatabase()
      .insert(syncDevices)
      .values({
        id: deviceId,
        name: 'This device',
        platform: 'darwin',
        appVersion: '99.0.0',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: to_base64(signing.publicKey)
      } as never)
      .run()
    const vaultUuid = getOrCreateVaultUuid(getDatabase())
    const before = startSync()
    addTag('synced-a')
    addTag('synced-b')
    await before.push()
    expect(getDatabase().select().from(syncQueue).all()).toEqual([])
    addTag('pending-c')
    expect(getDatabase().select().from(syncQueue).all()).toHaveLength(1)

    // The corrupt-db prompt, answered "Recover".
    expect(await offerDataDbRecovery(dbPath)).toBe(true)

    expect(getOrCreateVaultUuid(getDatabase())).toBe(vaultUuid)
    expect(getDatabase().select().from(tagDefinitions).all()).toEqual([])
    expect(getDatabase().select().from(syncQueue).all()).toHaveLength(1)

    const after = startSync()
    await after.pull()
    const names = (): string[] =>
      getDatabase()
        .select({ name: tagDefinitions.name })
        .from(tagDefinitions)
        .all()
        .map((row) => row.name)
        .toSorted()
    expect(names()).toEqual(['synced-a', 'synced-b'])

    // The replayed row carries its own payload; the tag row itself is gone
    // with the old file, so recreate it as the user's vault would.
    getDatabase()
      .insert(tagDefinitions)
      .values({ name: 'pending-c', color: 'red', clock: { [deviceId]: 1 } } as never)
      .run()
    await after.push()
    expect(getDatabase().select().from(syncQueue).all()).toEqual([])

    // Server view of the vault: each tag exactly once, all under the same vault.
    const d1 = await server.getD1()
    const { results } = await d1
      .prepare('SELECT item_id, vault_id FROM sync_items WHERE item_type = ? ORDER BY item_id')
      .bind('tag_definition')
      .all<{ item_id: string; vault_id: string }>()
    expect(results).toEqual(
      ['pending-c', 'synced-a', 'synced-b'].map((item_id) => ({ item_id, vault_id: vaultUuid }))
    )
    expect(
      getDatabase().select().from(tagDefinitions).where(eq(tagDefinitions.name, 'pending-c')).get()
    ).toBeDefined()
  }, 180_000)
})
