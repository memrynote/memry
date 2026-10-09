import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { encodeSignaturePayload } from '../lib/cbor'
import { errorHandler } from '../lib/errors'
import { cleanupDeletedDocumentBodies } from '../services/cleanup'
import { getSnapshot, getUpdates, storeUpdates } from '../services/crdt'
import { storeSnapshot } from '../services/crdt-snapshot-write'
import { purgeDeletedDocumentBodies } from '../services/document-body-purge'
import type { AppContext, Bindings } from '../types'
import type { RecordSyncItemType } from '@memry/contracts/sync-api'

/**
 * #2986: a deleted journal day comes back under the same id `j<date>`. The
 * server kept the deleted body, and a device pulling the re-created day from
 * sequence 0 merged the deleted text back in. Real routes, services, SQL and
 * schema; only auth is stubbed.
 */

const USER_ID = 'user-body-purge'
const DEVICE_ID = 'device-body-purge'
const VAULT_ID = 'default'
const DAY_ID = 'j2026-05-01'

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', USER_ID)
    c.set('deviceId', DEVICE_ID)
    await next()
  }
}))

const { sync } = await import('../routes/sync')

let harness: SqliteD1
let storage: R2Bucket
let env: Bindings
let signingKey: CryptoKey

const now = () => Math.floor(Date.now() / 1000)
const b64 = (length: number, fill: number) => Buffer.alloc(length, fill).toString('base64')
const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer

const seed = async (): Promise<void> => {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  signingKey = keyPair.privateKey
  const publicKey = Buffer.from(
    (await (crypto.subtle.exportKey as (format: string, key: CryptoKey) => Promise<ArrayBuffer>)(
      'raw',
      keyPair.publicKey
    )) as ArrayBuffer
  ).toString('base64')

  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 0, ?, ?)`
    )
    .run(USER_ID, 'purge@example.com', now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024, now())
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, 'Purge desktop', 'desktop', '1.0.0', ?, ?, ?)`
    )
    .run(DEVICE_ID, USER_ID, publicKey, now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_vaults (id, user_id, vault_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run('vault-row', USER_ID, VAULT_ID, now(), now())
}

const buildApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/sync', sync)
  return app
}
type App = ReturnType<typeof buildApp>

interface PushSpec {
  id: string
  type: RecordSyncItemType
  clock: Record<string, number>
  operation?: 'create' | 'update'
  deleted?: boolean
}

const signedItem = async ({ id, type, clock, operation = 'update', deleted }: PushSpec) => {
  const base = {
    id,
    type,
    operation: deleted ? ('delete' as const) : operation,
    cryptoVersion: 1,
    encryptedKey: b64(48, 0x11),
    keyNonce: b64(24, 0x22),
    encryptedData: Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64'),
    dataNonce: b64(24, 0x44),
    metadata: { clock },
    ...(deleted ? { deletedAt: now() } : {})
  }
  const signature = Buffer.from(
    await crypto.subtle.sign(
      'Ed25519',
      signingKey,
      encodeSignaturePayload(base, 'SYNC_ITEM') as unknown as ArrayBuffer
    )
  ).toString('base64')
  const { metadata: _metadata, cryptoVersion: _cryptoVersion, ...wire } = base
  return { ...wire, clock, signature, signerDeviceId: DEVICE_ID }
}

const push = async (app: App, spec: PushSpec): Promise<string[]> => {
  const res = await app.request(
    '/sync/push',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [await signedItem(spec)] })
    },
    env as unknown as Record<string, unknown>,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined
    } as unknown as ExecutionContext
  )
  return ((await res.json()) as { accepted: string[] }).accepted
}

const createDay = (app: App, clock: Record<string, number> = { [DEVICE_ID]: 1 }) =>
  push(app, { id: DAY_ID, type: 'journal', operation: 'create', clock })
const deleteDay = (app: App) =>
  push(app, { id: DAY_ID, type: 'journal', clock: { [DEVICE_ID]: 2 }, deleted: true })

const writeBody = async (noteId: string, ...updates: ArrayBuffer[]): Promise<number[]> =>
  storeUpdates(harness.db, USER_ID, VAULT_ID, noteId, DEVICE_ID, updates)
const writeSnapshot = (noteId: string, data: ArrayBuffer) =>
  storeSnapshot(harness.db, storage, USER_ID, VAULT_ID, noteId, DEVICE_ID, data)
const bodyFromZero = async (noteId: string) =>
  (await getUpdates(harness.db, USER_ID, VAULT_ID, noteId, 0)).updates.map((u) => [
    ...new Uint8Array(u.update_data as ArrayBuffer)
  ])

const storageUsed = (): number =>
  (
    harness.raw.prepare('SELECT storage_used FROM users WHERE id = ?').get(USER_ID) as {
      storage_used: number
    }
  ).storage_used
const recordSize = (itemId: string): number =>
  (
    harness.raw.prepare('SELECT size_bytes FROM sync_items WHERE item_id = ?').get(itemId) as {
      size_bytes: number
    }
  ).size_bytes
const count = (table: string): number =>
  (harness.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

beforeEach(async () => {
  harness = createSqliteD1()
  storage = createMemoryR2()
  env = {
    DB: harness.db,
    STORAGE: storage,
    ENVIRONMENT: 'development',
    USER_SYNC_STATE: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) })
    },
    RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ count: 1, windowStart: Math.floor(Date.now() / 1000) })
      })
    }
  } as unknown as Bindings
  await seed()
})

afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
})

describe('a deleted note or journal loses its server body (#2986)', () => {
  // #2986
  it('a re-created journal day serves only its new body', async () => {
    const app = buildApp()
    expect(await createDay(app)).toEqual([DAY_ID])
    const recordOnly = storageUsed()
    await writeBody(DAY_ID, bytes(1, 1), bytes(1, 2))
    await writeSnapshot(DAY_ID, bytes(9, 9, 9))
    expect(storageUsed()).toBeGreaterThan(recordOnly)
    const createdSize = recordSize(DAY_ID)

    expect(await deleteDay(app)).toEqual([DAY_ID])

    expect(await bodyFromZero(DAY_ID)).toEqual([])
    expect(await getSnapshot(harness.db, storage, USER_ID, VAULT_ID, DAY_ID)).toBeNull()
    expect(storageUsed()).toBe(recordOnly + recordSize(DAY_ID) - createdSize)
    expect(count('crdt_snapshots')).toBe(0)

    expect(await createDay(app, { [DEVICE_ID]: 3 })).toEqual([DAY_ID])
    await writeBody(DAY_ID, bytes(2, 1))

    expect(await bodyFromZero(DAY_ID)).toEqual([[2, 1]])
  })

  // #2986: a device offline across the delete and re-create holds the old cursor.
  it('numbers the re-created body after the deleted one', async () => {
    const app = buildApp()
    await createDay(app)
    const oldSequences = await writeBody(DAY_ID, bytes(1, 1), bytes(1, 2))
    await deleteDay(app)
    await createDay(app, { [DEVICE_ID]: 3 })

    const [first] = await writeBody(DAY_ID, bytes(2, 1))

    expect(first).toBeGreaterThan(Math.max(...oldSequences))
    const sinceOldCursor = await getUpdates(
      harness.db,
      USER_ID,
      VAULT_ID,
      DAY_ID,
      Math.max(...oldSequences)
    )
    expect(sinceOldCursor.updates).toHaveLength(1)
  })

  // #2986: an older revision of the snapshot can sit in any snapshot pack.
  it('drops the vault snapshot packs and resets their watermark', async () => {
    const app = buildApp()
    await createDay(app)
    await writeSnapshot(DAY_ID, bytes(9, 9, 9))
    const packKey = `${USER_ID}/vaults/${VAULT_ID}/packs/crdt_snapshot/p1`
    await storage.put(packKey, new Uint8Array([1]))
    harness.raw
      .prepare(
        `INSERT INTO pack_index (id, user_id, vault_id, pack_key, item_kind, min_cursor, max_cursor, item_count, byte_size, created_at)
         VALUES ('p1', ?, ?, ?, 'crdt_snapshot', 0, ?, 1, 1, ?)`
      )
      .run(USER_ID, VAULT_ID, packKey, now(), now())
    harness.raw
      .prepare(
        `INSERT INTO pack_watermarks (user_id, vault_id, item_kind, last_sort_value, last_sort_tiebreak, updated_at)
         VALUES (?, ?, 'crdt_snapshot', ?, ?, ?)`
      )
      .run(USER_ID, VAULT_ID, now(), DAY_ID, now())

    await deleteDay(app)

    expect(count('pack_index')).toBe(0)
    expect(count('pack_watermarks')).toBe(0)
    expect(await storage.get(packKey)).toBeNull()
  })

  // #2986
  it('keeps the body of an id that is live again when the purge runs', async () => {
    const app = buildApp()
    await createDay(app)
    await writeBody(DAY_ID, bytes(1, 1))

    await purgeDeletedDocumentBodies(harness.db, storage, USER_ID, VAULT_ID, [DAY_ID])

    expect(await bodyFromZero(DAY_ID)).toEqual([[1, 1]])
  })

  // #2986: protocol 07 §7.15.2, a purge is keyed by type, never by id shape.
  it('keeps a document body when a non-document item with the same id is deleted', async () => {
    const app = buildApp()
    await push(app, { id: DAY_ID, type: 'tag_definition', operation: 'create', clock: { t: 1 } })
    await writeBody(DAY_ID, bytes(1, 1))

    await push(app, { id: DAY_ID, type: 'tag_definition', clock: { t: 2 }, deleted: true })

    expect(await bodyFromZero(DAY_ID)).toEqual([[1, 1]])
  })

  // #2986: tombstones written before push purged bodies.
  it('the cleanup sweep purges the body of an older tombstone', async () => {
    const app = buildApp()
    await createDay(app)
    await deleteDay(app)
    await writeBody(DAY_ID, bytes(1, 1))

    expect(await cleanupDeletedDocumentBodies(harness.db, storage)).toBe(1)

    expect(await bodyFromZero(DAY_ID)).toEqual([])
    expect(await cleanupDeletedDocumentBodies(harness.db, storage)).toBe(0)
  })
})
