/**
 * A fresh device's first sync against a REAL sync-server (#5234).
 *
 * A quit 97 s into the first bootstrap of a 10k-item vault relaunched into
 * `cursor-skip repair, re-pulling from cursor 0` and read the whole feed again,
 * at steady-state pacing: the socket's `connected` scheduled a pull while the
 * full sync opened its bootstrap session, that pull took the lock, and the
 * #2382 repair was never recorded as done. A pull that kept applying pages
 * was also aborted by the stale-lock watchdog once it had held the lock for 15
 * minutes. These specs drive the real engine, a real data.db and the real
 * Worker, and read what the device asked the server for.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import sodium from 'libsodium-wrappers-sumo'

const net = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; url: URL }>,
  aborted: [] as string[],
  /** Runs before a request goes out; a rejection fails it like a dead network. */
  beforeRequest: null as ((method: string, url: URL) => void | Promise<void>) | null
}))

vi.mock('electron', () => ({
  net: {
    fetch: async (input: RequestInfo, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const url = new URL(typeof input === 'string' ? input : input.url)
      net.requests.push({ method, url })
      await net.beforeRequest?.(method, url)
      try {
        return await fetch(input, init)
      } catch (error) {
        if (init?.signal?.aborted) net.aborted.push(url.pathname)
        throw error
      }
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
import { runIndexMigrations, runMigrations } from '../database/migrate'
import { isBootstrapActive, resetBootstrapMetrics } from './bootstrap-metrics'
import type { CrdtProvider } from './crdt-provider'
import { SyncEngine, SYNC_LOCK_STALE_MS } from './engine'
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

const TAGS = Array.from({ length: 12 }, (_, i) => `tag-${String(i).padStart(2, '0')}`)
const PAGE = 3

let server: Harness
let tmpDir: string
const savedUrl = process.env.SYNC_SERVER_URL

beforeAll(async () => {
  // oxlint-disable-next-line import/no-named-as-default-member -- default import required: tests vi.mock libsodium-wrappers-sumo with only a default export
  await sodium.ready
  const mod = await import('@memry/sync-harness/simulated-server')
  server = new mod.SimulatedServer()
  await server.start({ bindings: { BOOTSTRAP_SESSION_HMAC_KEY: 'bootstrap-resume-key' } })
  process.env.SYNC_SERVER_URL = (await server.getDirectUrl()).origin
}, 180_000)

afterAll(async () => {
  process.env.SYNC_SERVER_URL = savedUrl
  await server?.stop()
})

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memry-bootstrap-int-'))
  net.requests.length = 0
  net.aborted.length = 0
  net.beforeRequest = null
})

afterEach(async () => {
  vi.useRealTimers()
  resetTagDefinitionSyncService()
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

/** A device's data.db and index.db, opened as the runtime opens them. */
function openDevice(name: string, account: Account, device: Device): void {
  closeDatabase()
  closeIndexDatabase()
  const dbPath = path.join(tmpDir, `${name}-data.db`)
  runMigrations(dbPath)
  initDatabase(dbPath)
  const indexPath = path.join(tmpDir, `${name}-index.db`)
  runIndexMigrations(indexPath)
  initIndexDatabase(indexPath)
  if (getDatabase().select().from(syncDevices).all().length > 0) return
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
  // One vault on two devices: the linked device adopts the writer's uuid.
  const now = Date.now()
  getDatabase()
    .insert(vaultMetadata)
    .values({ id: 'singleton', vaultUuid: account.vaultId, createdAt: now, updatedAt: now })
    .run()
}

/** The sync stack the runtime wires up, over the open data.db. */
function startSync(
  account: Account,
  device: Device,
  ws = createMockWs(),
  getVaultKey: () => Promise<Uint8Array> = async () => account.vaultKey.slice(),
  crdtProvider?: CrdtProvider
): SyncEngine {
  resetTagDefinitionSyncService()
  const db = getDatabase() as unknown as DrizzleDb
  const queue = new SyncQueueManager(db)
  const tags = initTagDefinitionSyncService({
    queue,
    db,
    getDeviceId: () => getCurrentDeviceId(db)
  })
  return new SyncEngine(
    {
      queue,
      network: createMockNetwork(),
      ws,
      getAccessToken: async () => device.token,
      getVaultKey,
      getSigningKeys: async () => ({
        secretKey: device.signing.privateKey.slice(),
        publicKey: device.signing.publicKey,
        deviceId: device.deviceId
      }),
      getDevicePublicKey: async (id) =>
        account.devices.find((d) => d.deviceId === id)?.signing.publicKey ?? null,
      db,
      ...(crdtProvider ? { crdtProvider } : {}),
      emitToRenderer: () => {},
      adapters: createSyncAdapterRegistry([
        {
          type: 'tag_definition',
          kind: 'record',
          local: tags as never,
          remote: getRemoteSyncAdapter('tag_definition')
        }
      ])
    },
    { pullPageLimit: PAGE }
  )
}

/** The writer device puts the vault's history on the server. */
async function writeHistory(account: Account): Promise<void> {
  const writer = account.devices[0]
  openDevice('writer', account, writer)
  const engine = startSync(account, writer)
  for (const name of TAGS) {
    getDatabase()
      .insert(tagDefinitions)
      .values({ name, color: 'red', clock: { [writer.deviceId]: 1 } } as never)
      .run()
    enqueueLocalSyncUpdate('tag_definition', name)
  }
  await expect(engine.fullSync()).resolves.toEqual({ status: 'delivered' })
  await engine.stop()
}

const localTags = (): string[] =>
  getDatabase()
    .select({ name: tagDefinitions.name })
    .from(tagDefinitions)
    .all()
    .map((row) => row.name)
    .toSorted()

const stateValue = (key: string): string | undefined =>
  getDatabase()
    .select()
    .from(syncState)
    .all()
    .find((row) => row.key === key)?.value

const changesCursors = (): string[] =>
  net.requests
    .filter(({ url }) => url.pathname.endsWith('/sync/changes'))
    .map(({ url }) => url.searchParams.get('cursor') ?? '0')

describe('a fresh device whose first sync a quit interrupts, against a real sync server', () => {
  it('resumes from its cursor under a bootstrap session instead of re-reading from 0', async () => {
    const account = await seedAccount()
    await writeHistory(account)
    const fresh = account.devices[1]
    openDevice('fresh', account, fresh)

    // First launch: the socket comes up while the bootstrap session opens.
    // The third feed page stays in flight while the rest of the full sync runs
    // (the real app spends 90 s in packs there), then the process dies.
    const ws = createMockWs()
    let pages = 0
    let dead = false
    let parked: (() => void) | null = null
    net.requests.length = 0
    net.beforeRequest = async (method, url) => {
      if (dead) throw new TypeError('fetch failed')
      if (method === 'POST' && url.pathname.endsWith('/sync/bootstrap')) ws.simulateConnected()
      if (url.pathname.endsWith('/sync/changes') && ++pages === 3) {
        await new Promise<void>((resolve) => (parked = resolve))
        throw new TypeError('fetch failed')
      }
    }
    const first = startSync(account, fresh, ws)
    const run = first.start().catch(() => {})
    await vi.waitUntil(() => parked !== null, { interval: 5 })
    // A full sync that lost the lock moves on to its push; one that holds it
    // stays parked behind its own page.
    await vi
      .waitUntil(() => net.requests.some(({ url }) => url.pathname.endsWith('/sync/push')), {
        timeout: 2000,
        interval: 5
      })
      .catch(() => {})
    dead = true
    parked!()
    await run
    await first.stop({ skipFinalPush: true })
    const interruptedAt = stateValue(SYNC_STATE_KEYS.LAST_CURSOR)
    expect(Number(interruptedAt)).toBeGreaterThan(0)
    expect(localTags().length).toBeLessThan(TAGS.length)

    // Relaunch.
    net.beforeRequest = null
    net.requests.length = 0
    const relaunched = startSync(account, fresh)
    await expect(relaunched.fullSync()).resolves.toEqual({ status: 'delivered' })

    expect(changesCursors()[0]).toBe(interruptedAt)
    expect(changesCursors()).not.toContain('0')
    expect(
      net.requests.some(
        ({ method, url }) => method === 'POST' && url.pathname.endsWith('/sync/bootstrap')
      )
    ).toBe(true)
    expect(localTags()).toEqual(TAGS)
    expect(stateValue('bootstrapPending')).toBeUndefined()
    await relaunched.stop()

    // Bootstrapped: a later launch is a steady-state device.
    net.requests.length = 0
    const later = startSync(account, fresh)
    await expect(later.fullSync()).resolves.toEqual({ status: 'delivered' })
    expect(net.requests.some(({ url }) => url.pathname.endsWith('/sync/bootstrap'))).toBe(false)
    await later.stop()
  }, 180_000)
})

/** A CRDT store holding no documents: the body phase runs and finds nothing to pull. */
const emptyCrdtStore = (): CrdtProvider =>
  ({
    storeId: null,
    inactiveDocCapacity: 32,
    getOpenNoteIds: () => [],
    hasPersistence: () => false,
    isNoteLocalOnly: () => false
  }) as unknown as CrdtProvider

const bootstrapSessionsOf = async (device: Device): Promise<number> => {
  const row = await (
    await server.getD1()
  )
    .prepare('SELECT COUNT(*) AS n FROM bootstrap_sessions WHERE device_id = ?')
    .bind(device.deviceId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

describe('a fresh device killed after its record pull delivered (#5328)', () => {
  it('resumes elevated, frees the killed session and closes the bootstrap', async () => {
    const account = await seedAccount()
    await writeHistory(account)
    const fresh = account.devices[1]
    openDevice('fresh', account, fresh)

    // First launch: the record pull reaches the head of the feed, then the
    // process dies in the closing checks, before the body phase finishes.
    let dead = false
    let parked = false
    net.requests.length = 0
    net.beforeRequest = async (_method, url) => {
      if (dead) throw new TypeError('fetch failed')
      if (url.pathname.endsWith('/sync/manifest')) {
        parked = true
        await new Promise<never>(() => {})
      }
    }
    void startSync(account, fresh, createMockWs(), undefined, emptyCrdtStore()).fullSync()
    await vi.waitUntil(() => parked, { timeout: 30_000, interval: 5 })
    dead = true
    expect(stateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBeDefined()
    expect(localTags()).toEqual(TAGS)
    expect(await bootstrapSessionsOf(fresh)).toBe(1)

    // Relaunch: a new process, with no telemetry window of its own yet.
    resetBootstrapMetrics()
    openDevice('fresh', account, fresh)
    net.requests.length = 0
    let windowAtOpen = false
    net.beforeRequest = (method, url) => {
      if (method === 'POST' && url.pathname.endsWith('/sync/bootstrap')) {
        windowAtOpen = isBootstrapActive()
      }
    }
    const relaunched = startSync(account, fresh, createMockWs(), undefined, emptyCrdtStore())
    await expect(relaunched.fullSync()).resolves.toEqual({ status: 'delivered' })

    expect(
      net.requests.some(
        ({ method, url }) => method === 'POST' && url.pathname.endsWith('/sync/bootstrap')
      )
    ).toBe(true)
    expect(windowAtOpen).toBe(true)
    expect(isBootstrapActive()).toBe(false)
    expect(stateValue('bootstrapPending')).toBeUndefined()
    // The relaunch's open replaced the killed session, and its close freed the slot.
    await vi.waitUntil(async () => (await bootstrapSessionsOf(fresh)) === 0, {
      timeout: 5000,
      interval: 20
    })
    await relaunched.stop()
  }, 180_000)
})

describe('the stale-lock watchdog, against a real sync server', () => {
  it('leaves a pull that keeps applying pages past the bound alone', async () => {
    const account = await seedAccount()
    await writeHistory(account)
    const fresh = account.devices[1]
    openDevice('fresh', account, fresh)
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })

    // Each page after the first lands six minutes after the one before: the
    // pull holds the lock for 18 minutes and makes progress the whole time.
    let pages = 0
    net.requests.length = 0
    net.beforeRequest = (_method, url) => {
      if (url.pathname.endsWith('/sync/changes') && ++pages > 1) {
        vi.advanceTimersByTime(6 * 60_000)
      }
    }
    const engine = startSync(account, fresh)
    await engine.start()

    expect(pages * 6 * 60_000).toBeGreaterThan(SYNC_LOCK_STALE_MS)
    expect(net.aborted).toEqual([])
    // One pull read each page once: no second pull ran beside a released lock.
    expect(new Set(changesCursors()).size).toBe(changesCursors().length)
    expect(stateValue('bootstrapPending')).toBeUndefined()
    expect(localTags()).toEqual(TAGS)
    await engine.stop()
  }, 180_000)

  it('still recovers a lock that makes no progress', async () => {
    const account = await seedAccount()
    await writeHistory(account)
    const fresh = account.devices[1]
    openDevice('fresh', account, fresh)
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })

    let hang = false
    const engine = startSync(account, fresh, createMockWs(), () =>
      hang ? new Promise<Uint8Array>(() => {}) : Promise.resolve(account.vaultKey.slice())
    )
    await engine.start()
    expect(localTags()).toEqual(TAGS)

    // A pull whose await never settles leaks the lock.
    hang = true
    void engine.pull()
    await vi.waitUntil(() => engine['ctx'].syncing, { interval: 5 })
    await expect(engine.pull()).resolves.toEqual({ status: 'skipped', reason: 'busy' })

    // The 60 s tick pulls again once the watchdog frees the lock.
    hang = false
    vi.advanceTimersByTime(SYNC_LOCK_STALE_MS + 2 * 60_000)
    await vi.waitUntil(() => !engine['ctx'].syncing, { interval: 5 })

    await expect(engine.pull()).resolves.toEqual({ status: 'delivered' })
    await engine.stop()
  }, 180_000)

  it('recovers a hung pull while the user keeps editing', async () => {
    const account = await seedAccount()
    await writeHistory(account)
    const fresh = account.devices[1]
    openDevice('fresh', account, fresh)
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })

    let hang = false
    const hung: Array<() => void> = []
    const engine = startSync(account, fresh, createMockWs(), async () => {
      if (hang) await new Promise<void>((resolve) => hung.push(resolve))
      return account.vaultKey.slice()
    })
    await engine.start()

    hang = true
    void engine.pull()
    await vi.waitUntil(() => engine['ctx'].syncing, { interval: 5 })

    // A local edit every five minutes grows the push queue; none of it is the
    // hung pull's work. The tick that frees the lock starts the next pull.
    for (let minute = 1; minute <= 40; minute++) {
      if (minute % 5 === 0) {
        const name = `edit-${minute}`
        getDatabase()
          .insert(tagDefinitions)
          .values({ name, color: 'red', clock: { [fresh.deviceId]: 1 } } as never)
          .run()
        enqueueLocalSyncUpdate('tag_definition', name)
      }
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()
    }

    await vi.waitUntil(() => hung.length > 1, { timeout: 2000, interval: 5 }).catch(() => {})
    expect(hung.length).toBeGreaterThan(1)
    hang = false
    for (const resolve of hung) resolve()
    await engine.stop()
  }, 180_000)
})
