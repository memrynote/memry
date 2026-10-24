/**
 * The manifest check against a REAL sync-server (#3391).
 *
 * A Mac's manifest check kept finding the same 17 server items missing. Every
 * check, every 30 minutes, reset its cursor to 0 and re-read its whole history,
 * 28k items, to get them back. The re-read outlived the 15-minute stale-lock
 * watchdog and ended refused, and the 17 never stayed. This spec drives such a
 * device through the real engine, a real data.db, and the real Worker, and
 * reads what the device asked the server for.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import sodium from 'libsodium-wrappers-sumo'
import { eq } from 'drizzle-orm'

const requests = vi.hoisted(() => [] as Array<{ method: string; url: URL; body: unknown }>)

vi.mock('electron', () => ({
  // Real HTTP against the miniflare listener, recorded.
  net: {
    fetch: (input: RequestInfo, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? 'GET',
        url: new URL(typeof input === 'string' ? input : input.url),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      })
      return fetch(input, init)
    }
  },
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
import { syncState } from '@memry/db-schema/schema/sync-state'
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
import { SYNC_STATE_KEYS } from './engine/sync-context'
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
const savedUrl = process.env.SYNC_SERVER_URL

beforeAll(async () => {
  // oxlint-disable-next-line import/no-named-as-default-member -- default import required: tests vi.mock libsodium-wrappers-sumo with only a default export
  await sodium.ready
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
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memry-manifest-int-'))
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
    // oxlint-disable-next-line import/no-named-as-default-member -- default import required: tests vi.mock libsodium-wrappers-sumo with only a default export
    .bind(deviceId, userId, sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL), now, now)
    .run()
  await db
    .prepare('INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0)')
    .bind(userId)
    .run()
  return { deviceId, token: await server.createAccessToken(userId, deviceId) }
}

describe('a device that cannot keep a server item, against a real sync server', () => {
  it('fetches the item by id at every manifest check and never re-reads its history', async () => {
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
    const localTags = (): string[] =>
      getDatabase()
        .select({ name: tagDefinitions.name })
        .from(tagDefinitions)
        .all()
        .map((row) => row.name)
        .toSorted()

    const dbPath = path.join(tmpDir, 'data.db')
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
        // oxlint-disable-next-line import/no-named-as-default-member -- default import required: tests vi.mock libsodium-wrappers-sumo with only a default export
        signingPublicKey: sodium.to_base64(signing.publicKey)
      } as never)
      .run()
    getOrCreateVaultUuid(getDatabase())

    // The vault's history: four items on the server, all held here.
    const first = startSync()
    for (const name of ['alpha', 'beta', 'gamma', 'kept-elsewhere']) {
      getDatabase()
        .insert(tagDefinitions)
        .values({ name, color: 'red', clock: { [deviceId]: 1 } } as never)
        .run()
      enqueueLocalSyncUpdate('tag_definition', name)
    }
    await expect(first.fullSync()).resolves.toEqual({ status: 'delivered' })
    await expect(first.pull()).resolves.toEqual({ status: 'delivered' })
    const cursor = getDatabase()
      .select({ value: syncState.value })
      .from(syncState)
      .where(eq(syncState.key, SYNC_STATE_KEYS.LAST_CURSOR))
      .get()?.value
    expect(Number(cursor)).toBeGreaterThan(0)
    await first.stop()

    // Two manifest checks, half an hour apart, each finding the same item gone:
    // this device drops it after every apply, so no pull makes it stay.
    for (const check of [1, 2]) {
      getDatabase().delete(tagDefinitions).where(eq(tagDefinitions.name, 'kept-elsewhere')).run()
      getDatabase()
        .delete(syncState)
        .where(eq(syncState.key, SYNC_STATE_KEYS.LAST_MANIFEST_CHECK_AT))
        .run()
      requests.length = 0
      const engine = startSync()

      await expect(engine.fullSync(), `check ${check}`).resolves.toEqual({ status: 'delivered' })

      const historyReads = requests.filter(
        ({ url }) =>
          url.pathname.endsWith('/sync/changes') && (url.searchParams.get('cursor') ?? '0') === '0'
      )
      expect(historyReads, `check ${check}`).toEqual([])
      const pulledIds = requests
        .filter(({ method, url }) => method === 'POST' && url.pathname.endsWith('/sync/pull'))
        .map(({ body }) => (body as { itemIds: string[] }).itemIds)
      expect(pulledIds, `check ${check}`).toEqual([['kept-elsewhere']])
      expect(localTags(), `check ${check}`).toEqual(['alpha', 'beta', 'gamma', 'kept-elsewhere'])
      await engine.stop()
    }
  }, 180_000)
})
