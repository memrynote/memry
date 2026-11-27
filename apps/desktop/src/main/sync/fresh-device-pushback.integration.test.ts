/**
 * A fresh device's first sync against a REAL sync-server pushes nothing it did
 * not edit (#5255).
 *
 * A new Electron device that only applied remote state pushed ~80 settings
 * items into the vault on its first pull: the inbox the vault open writes went
 * out before the pull, and every folder the pull wrote into reached the
 * watcher, was pushed as a create, and merged with the remote row the pull
 * delivered later. Both merges were pushed back, and could move a user's
 * value. These specs drive the real engine, a real data.db and the real
 * Worker, and read what the device sent.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import sodium from 'libsodium-wrappers-sumo'

const net = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; url: URL }>,
  beforeRequest: null as ((method: string, url: URL) => void) | null
}))

vi.mock('electron', () => ({
  net: {
    fetch: async (input: RequestInfo, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const url = new URL(typeof input === 'string' ? input : input.url)
      net.requests.push({ method, url })
      net.beforeRequest?.(method, url)
      return fetch(input, init)
    }
  },
  app: { getPath: () => os.tmpdir(), getVersion: () => '99.0.0', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({ getFixedT: () => (key: string) => key })
}))

import { eq } from 'drizzle-orm'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { resetSyncDecision } from '@memry/sync-client/sync-eligibility'
import {
  initFolderConfigSyncService,
  resetFolderConfigSyncService
} from '@memry/sync-client/folder-config-sync'
import { initProjectSyncService, resetProjectSyncService } from '@memry/sync-client/project-sync'
import {
  initPropertyDefinitionSyncService,
  resetPropertyDefinitionSyncService
} from '@memry/sync-client/property-definition-sync'
import {
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import { projects } from '@memry/db-schema/schema/projects'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { vaultMetadata } from '@memry/db-schema/data-schema'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createMockNetwork, createMockWs } from '@tests/utils/engine-mocks'
import {
  closeDatabase,
  closeIndexDatabase,
  getDatabase,
  initDatabase,
  initIndexDatabase
} from '../database/client'
import { ensureDefaultTaskProject } from '../database/defaults'
import { runIndexMigrations, runMigrations } from '../database/migrate'
import { syncFolderConfigDiscovered } from '../notes/folder-config-effects'
import { recoverDirtyItems } from './dirty-recovery'
import { SyncEngine } from './engine'

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
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memry-pushback-int-'))
  net.requests.length = 0
  net.beforeRequest = null
})

afterEach(async () => {
  resetSyncDecision()
  resetProjectSyncService()
  resetFolderConfigSyncService()
  resetTagDefinitionSyncService()
  resetPropertyDefinitionSyncService()
  closeDatabase()
  closeIndexDatabase()
  await rm(tmpDir, { recursive: true, force: true })
})

type Device = { deviceId: string; token: string; signing: sodium.KeyPair }
type Account = { vaultId: string; vaultKey: Uint8Array; devices: [Device, Device] }

/** One user with two devices: a writer and a fresh reader. */
async function seedAccount(): Promise<Account> {
  const db = await server.getD1()
  const userId = randomUUID()
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
    .prepare('INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0)')
    .bind(userId)
    .run()
  const devices: Device[] = []
  for (const name of ['writer', 'fresh']) {
    const deviceId = randomUUID()
    const signing = sodium.crypto_sign_keypair()
    await db
      .prepare(
        `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, vault_id, created_at, updated_at)
         VALUES (?, ?, ?, 'test', '99.0.0', ?, 'default', ?, ?)`
      )
      .bind(
        deviceId,
        userId,
        name,
        // oxlint-disable-next-line import/no-named-as-default-member -- default import required: tests vi.mock libsodium-wrappers-sumo with only a default export
        sodium.to_base64(signing.publicKey, sodium.base64_variants.ORIGINAL),
        now,
        now
      )
      .run()
    devices.push({ deviceId, signing, token: await server.createAccessToken(userId, deviceId) })
  }
  return {
    vaultId: randomUUID(),
    vaultKey: sodium.randombytes_buf(32),
    devices: devices as [Device, Device]
  }
}

/** A device's databases as the runtime opens them, and its local sync services. */
function openDevice(name: string, account: Account, device: Device): SyncQueueManager {
  closeDatabase()
  closeIndexDatabase()
  const dbPath = path.join(tmpDir, `${name}-data.db`)
  runMigrations(dbPath)
  initDatabase(dbPath)
  const indexPath = path.join(tmpDir, `${name}-index.db`)
  runIndexMigrations(indexPath)
  initIndexDatabase(indexPath)
  getDatabase()
    .insert(syncDevices)
    .values({
      id: device.deviceId,
      name: 'This device',
      platform: 'darwin',
      appVersion: '99.0.0',
      linkedAt: new Date(),
      isCurrentDevice: true,
      // oxlint-disable-next-line import/no-named-as-default-member -- default import required: tests vi.mock libsodium-wrappers-sumo with only a default export
      signingPublicKey: sodium.to_base64(device.signing.publicKey)
    } as never)
    .run()
  const now = Date.now()
  getDatabase()
    .insert(vaultMetadata)
    .values({ id: 'singleton', vaultUuid: account.vaultId, createdAt: now, updatedAt: now })
    .run()

  const db = getDatabase() as unknown as DrizzleDb
  const queue = new SyncQueueManager(db)
  const deps = { queue, db, getDeviceId: () => getCurrentDeviceId(db) }
  initProjectSyncService(deps)
  initFolderConfigSyncService(deps)
  initTagDefinitionSyncService(deps)
  initPropertyDefinitionSyncService(deps)
  // The vault open writes the default inbox before sync starts.
  ensureDefaultTaskProject(getDatabase())
  return queue
}

function startSync(account: Account, device: Device, queue: SyncQueueManager): SyncEngine {
  return new SyncEngine({
    queue,
    network: createMockNetwork(),
    ws: createMockWs(),
    getAccessToken: async () => device.token,
    getVaultKey: async () => account.vaultKey.slice(),
    getSigningKeys: async () => ({
      secretKey: device.signing.privateKey.slice(),
      publicKey: device.signing.publicKey,
      deviceId: device.deviceId
    }),
    getDevicePublicKey: async (id) =>
      account.devices.find((d) => d.deviceId === id)?.signing.publicKey ?? null,
    db: getDatabase(),
    emitToRenderer: () => {}
  })
}

/** The account's settings, as another device made and synced them. */
async function writeSettings(account: Account): Promise<void> {
  const writer = account.devices[0]
  const queue = openDevice('writer', account, writer)
  const db = getDatabase()
  const engine = startSync(account, writer, queue)
  // Sync start's sweep pushes the inbox; the user renamed it before that.
  db.update(projects)
    .set({ name: 'Capture', color: '#ff0000', description: 'Everything first lands here' })
    .where(eq(projects.id, 'inbox'))
    .run()
  db.update(projects)
    .set({ clock: { [writer.deviceId]: 1 } })
    .where(eq(projects.id, 'inbox'))
    .run()
  db.insert(folderConfigs)
    .values({ path: 'Work', icon: 'briefcase', clock: { [writer.deviceId]: 1 } } as never)
    .run()
  db.insert(tagDefinitions)
    .values({
      name: 'reading',
      color: '#123456',
      colorAuthored: true,
      clock: { [writer.deviceId]: 1 }
    } as never)
    .run()
  db.insert(propertyDefinitions)
    .values({
      name: 'status',
      type: 'select',
      options: JSON.stringify(['todo', 'done']),
      color: '#00ff00',
      clock: { [writer.deviceId]: 1 }
    } as never)
    .run()
  recoverDirtyItems(db)
  for (const [type, id] of [
    ['folder_config', 'Work'],
    ['tag_definition', 'reading'],
    ['property_definition', 'status']
  ] as const) {
    queue.enqueue({ type, itemId: id, operation: 'create', payload: '{}', priority: 0 })
  }
  await expect(engine.fullSync()).resolves.toEqual({ status: 'delivered' })
  expect(queue.getPendingCount()).toBe(0)
  await engine.stop()
  resetSyncDecision()
}

const settingsOf = () => {
  const db = getDatabase()
  const inbox = db.select().from(projects).where(eq(projects.id, 'inbox')).get()
  const folder = db.select().from(folderConfigs).where(eq(folderConfigs.path, 'Work')).get()
  const tag = db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'reading')).get()
  const property = db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.name, 'status'))
    .get()
  return {
    inbox: {
      name: inbox?.name,
      color: inbox?.color,
      description: inbox?.description,
      clock: inbox?.clock
    },
    folder: { icon: folder?.icon, clock: folder?.clock },
    tag: { color: tag?.color, colorAuthored: tag?.colorAuthored, clock: tag?.clock },
    property: {
      type: property?.type,
      options: property?.options,
      color: property?.color,
      clock: property?.clock
    }
  }
}

const writes = () =>
  net.requests
    .filter(({ method }) => method === 'POST')
    .map(({ url }) => url.pathname)
    .filter((p) => /\/sync\/(push|crdt\/updates|crdt\/snapshot|attachments\/upload)/.test(p))

describe('a fresh device that only applied remote state (#5255)', () => {
  it('pushes nothing on its first sync, and every remote value wins over its seeds', async () => {
    const account = await seedAccount()
    await writeSettings(account)
    const writerSettings = settingsOf()
    expect(writerSettings.inbox.name).toBe('Capture')

    const fresh = account.devices[1]
    const queue = openDevice('fresh', account, fresh)
    const db = getDatabase()
    // Seeds this device made from what it indexed: a tag a note uses, in a
    // palette colour, and a property its frontmatter carries.
    db.insert(tagDefinitions)
      .values({ name: 'reading', color: '#ef4444', colorAuthored: false })
      .run()
    db.insert(propertyDefinitions).values({ name: 'status', type: 'text' }).run()

    // Sync start, then the first pull. The pull writes a note into Work, which
    // the watcher sees before the folder's own row arrives.
    recoverDirtyItems(db)
    net.requests.length = 0
    let discovered = false
    net.beforeRequest = (_method, url) => {
      if (!discovered && url.pathname.endsWith('/sync/changes')) {
        discovered = true
        syncFolderConfigDiscovered('Work')
      }
    }
    const engine = startSync(account, fresh, queue)
    await expect(engine.fullSync()).resolves.toEqual({ status: 'delivered' })
    expect(discovered).toBe(true)

    expect(writes()).toEqual([])
    expect(queue.getPendingCount()).toBe(0)
    expect(settingsOf()).toEqual(writerSettings)
    await engine.stop()
  }, 180_000)
})
