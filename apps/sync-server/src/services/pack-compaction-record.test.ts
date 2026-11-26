import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { encodeSignaturePayload } from '../lib/cbor'
import { errorHandler } from '../lib/errors'
import type { AppContext, Bindings } from '../types'
import { cleanupExpiredTombstones } from './cleanup'
import { createMemoryQueue } from '../__tests__/pack-queue-memory'
import { runBackfillMessage } from './pack-backfill'
import { compactOneRange, compactVault } from './pack-compaction'
import { listPacks } from './pack-list'
import { extractEntry, parsePack, type PackedEntry } from './pack-format'
import { PACK_SETTLE_SECONDS } from './pack-sizing'
import { rewritePurgedPacks } from './pack-purge-rewrite'
import { deleteReplacedPackObjects } from './pack-replaced-objects'
import {
  RECORD_SYNC_ITEM_TYPES,
  RecordPackEntryMetaSchema,
  RecordPullItemResponseSchema,
  type RecordPullItemResponse,
  type RecordSyncItemType
} from '@memry/contracts/sync-api'

/**
 * #5227: a record pack entry is one POST /sync/pull item split into identity,
 * meta and payload (protocol 08 §8.4.2). Real push and pull routes, services,
 * SQL and schema; only auth is stubbed.
 */

const USER_ID = 'user-record-pack'
const DEVICE_ID = 'device-record-pack'
const VAULT_ID = 'default'
const SCOPE = { userId: USER_ID, vaultId: VAULT_ID }

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

const seedAccount = async (): Promise<void> => {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  signingKey = keyPair.privateKey
  const publicKey = Buffer.from(
    await (crypto.subtle.exportKey as (format: string, key: CryptoKey) => Promise<ArrayBuffer>)(
      'raw',
      keyPair.publicKey
    )
  ).toString('base64')
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, 'record-pack@example.com', 1, 'otp', 0, 0, ?, ?)`
    )
    .run(USER_ID, now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024, now())
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, 'Record pack desktop', 'desktop', '1.0.0', ?, ?, ?)`
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
  type?: RecordSyncItemType
  operation?: 'create' | 'update'
  clock?: Record<string, number>
  deletedAt?: number
}

const signedItem = async ({ id, type = 'task', operation, clock, deletedAt }: PushSpec) => {
  const base = {
    id,
    type,
    operation: deletedAt === undefined ? (operation ?? ('update' as const)) : ('delete' as const),
    cryptoVersion: 1,
    encryptedKey: b64(48, 0x11),
    keyNonce: b64(24, 0x22),
    encryptedData: Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64'),
    dataNonce: b64(24, 0x44),
    ...(clock ? { metadata: { clock } } : {}),
    ...(deletedAt === undefined ? {} : { deletedAt })
  }
  const signature = Buffer.from(
    await crypto.subtle.sign(
      'Ed25519',
      signingKey,
      encodeSignaturePayload(base, 'SYNC_ITEM') as unknown as ArrayBuffer
    )
  ).toString('base64')
  const { metadata: _metadata, cryptoVersion: _cryptoVersion, ...wire } = base
  return { ...wire, ...(clock ? { clock } : {}), signature, signerDeviceId: DEVICE_ID }
}

const request = (app: App, path: string, body?: unknown) =>
  app.request(
    path,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Memry-Sync-Types': [...RECORD_SYNC_ITEM_TYPES, 'purged_tombstones'].join(',')
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    },
    env,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined
    } as unknown as ExecutionContext
  )

const push = async (app: App, specs: PushSpec[]): Promise<void> => {
  const items = await Promise.all(specs.map(signedItem))
  const res = await request(app, '/sync/push', { items })
  const body = (await res.json()) as { accepted: string[] }
  expect(body.accepted).toEqual(specs.map((spec) => spec.id))
}

const pull = async (app: App, itemIds: string[]): Promise<RecordPullItemResponse[]> => {
  const res = await request(app, '/sync/pull', { itemIds })
  expect(res.status).toBe(200)
  const body: { items: RecordPullItemResponse[] } = await res.json()
  return body.items
}

/** Every record entry of every record pack, rebuilt into a pull item (§8.4.2). */
const packedRecordItems = async (): Promise<
  Array<{ entry: PackedEntry; item: RecordPullItemResponse }>
> => {
  const keys = harness.raw
    .prepare(`SELECT pack_key FROM pack_index WHERE item_kind = 'record' ORDER BY min_cursor`)
    .all() as Array<{ pack_key: string }>
  const out: Array<{ entry: PackedEntry; item: RecordPullItemResponse }> = []
  for (const { pack_key: key } of keys) {
    const bytes = new Uint8Array(await (await storage.get(key))!.arrayBuffer())
    for (const entry of (await parsePack(bytes)).entries) {
      const at = entry.id.indexOf(':')
      const meta = RecordPackEntryMetaSchema.parse(entry.meta)
      const blob = JSON.parse(new TextDecoder().decode(extractEntry(bytes, entry))) as unknown
      const item = RecordPullItemResponseSchema.parse({
        ...meta,
        id: entry.id.slice(at + 1),
        type: entry.id.slice(0, at),
        blob
      })
      out.push({ entry, item })
    }
  }
  return out
}

/** Item ids GET /sync/manifest lists as live; a deleted item is absent. */
const manifestIds = async (app: App): Promise<string[]> => {
  const res = await request(app, '/sync/manifest')
  expect(res.status).toBe(200)
  const body: { items: Array<{ id: string }> } = await res.json()
  return body.items.map((item) => item.id).toSorted()
}

/** Delete `itemId`, then age the tombstone past the 30-day retention so the shed takes it. */
const expiredTombstone = async (app: App, itemId: string): Promise<void> => {
  await push(app, [{ id: itemId, clock: { [DEVICE_ID]: 2 }, deletedAt: now() }])
  harness.raw
    .prepare('UPDATE sync_items SET deleted_at = ? WHERE user_id = ? AND item_id = ?')
    .run(now() - 40 * 86_400, USER_ID, itemId)
}

const recordWatermark = (): number | null =>
  (
    harness.raw
      .prepare(`SELECT last_sort_value FROM pack_watermarks WHERE item_kind = 'record'`)
      .get() as { last_sort_value: number } | undefined
  )?.last_sort_value ?? null

const rowOf = (itemId: string) =>
  harness.raw
    .prepare('SELECT blob_key, server_cursor FROM sync_items WHERE user_id = ? AND item_id = ?')
    .get(USER_ID, itemId) as { blob_key: string; server_cursor: number }

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
  await seedAccount()
})

afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
})

// Rows written a settle interval ago, so a build meets the minimum fill (#5229).
const settleRecords = (): void => {
  harness.raw.prepare('UPDATE sync_items SET updated_at = updated_at - ?').run(PACK_SETTLE_SECONDS)
}

describe('record packs carry the pull item (#5227)', () => {
  it('packs every record, tombstones included, exactly as POST /sync/pull returns it', async () => {
    const app = buildApp()
    await push(app, [
      { id: 'task-live', operation: 'create', clock: { [DEVICE_ID]: 1 } },
      { id: 'task-gone', operation: 'create', clock: { [DEVICE_ID]: 1 } },
      { id: 'folder/a:b', type: 'folder_config', operation: 'create', clock: { [DEVICE_ID]: 1 } },
      { id: 'tag-1', type: 'tag_definition', operation: 'create', clock: { [DEVICE_ID]: 1 } }
    ])
    await push(app, [
      { id: 'task-live', clock: { [DEVICE_ID]: 2 } },
      { id: 'task-gone', clock: { [DEVICE_ID]: 2 }, deletedAt: now() }
    ])

    settleRecords()
    await compactVault(harness.db, storage, SCOPE)

    const packed = await packedRecordItems()
    const ids = ['task-live', 'task-gone', 'folder/a:b', 'tag-1']
    const pulled = await pull(app, ids)
    expect(pulled).toHaveLength(ids.length)
    expect(packed.map(({ item }) => item.id).toSorted()).toEqual(ids.toSorted())
    for (const expected of pulled) {
      const match = packed.find(
        ({ item }) => item.id === expected.id && item.type === expected.type
      )
      expect(match?.item).toEqual(expected)
      expect(match?.entry.sortKey).toBe(rowOf(expected.id).server_cursor)
      expect(match?.entry.sourceKey).toBe(rowOf(expected.id).blob_key)
    }
    const tombstone = packed.find(({ item }) => item.id === 'task-gone')!.item
    expect(tombstone.operation).toBe('delete')
    expect(tombstone.deletedAt).toBeGreaterThan(0)
  })

  it('a push racing compaction leaves the entry out, and its new version above the pack', async () => {
    const app = buildApp()
    await push(app, [
      { id: 'task-a', operation: 'create', clock: { [DEVICE_ID]: 1 } },
      { id: 'task-b', operation: 'create', clock: { [DEVICE_ID]: 1 } }
    ])
    const raced = rowOf('task-a')
    // The push lands after selection read task-a's row and before its R2 GET.
    const realGet = storage.get.bind(storage)
    vi.spyOn(storage, 'get').mockImplementation(async (key: string) => {
      if (key === raced.blob_key) await push(app, [{ id: 'task-a', clock: { [DEVICE_ID]: 2 } }])
      return realGet(key)
    })

    settleRecords()
    const result = await compactOneRange(harness.db, storage, SCOPE, 'record')
    vi.mocked(storage.get).mockRestore()

    expect(result.holes).toEqual(['task:task-a'])
    expect((await packedRecordItems()).map(({ item }) => item)).toEqual(await pull(app, ['task-b']))
    expect(rowOf('task-a').server_cursor).toBeGreaterThan(result.maxSortValue)
  })

  it('an entry whose old payload outlived the race is that old version, whole', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-a', operation: 'create', clock: { [DEVICE_ID]: 1 } }])
    const before = await pull(app, ['task-a'])
    const raced = rowOf('task-a')
    const oldBytes = await (await storage.get(raced.blob_key))!.arrayBuffer()
    // Push Stage 8 deletes the replaced object best-effort; here the GET
    // reaches it before that delete does.
    const realGet = storage.get.bind(storage)
    vi.spyOn(storage, 'get').mockImplementation(async (key: string) => {
      if (key === raced.blob_key) {
        await push(app, [{ id: 'task-a', clock: { [DEVICE_ID]: 2 } }])
        await storage.put(raced.blob_key, oldBytes)
      }
      return realGet(key)
    })

    settleRecords()
    await compactOneRange(harness.db, storage, SCOPE, 'record')
    vi.mocked(storage.get).mockRestore()

    expect((await packedRecordItems()).map(({ item }) => item)).toEqual(before)
  })

  // REVIEW-5253 probe b: the shed empties a tombstone in place, keeping its
  // cursor, between selection and the R2 GET. A hole there would move the
  // watermark past a row that never moves again.
  it('abandons the range when a tombstone is shed during the build', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-x', operation: 'create', clock: { [DEVICE_ID]: 1 } }])
    await expiredTombstone(app, 'task-x')
    await push(app, [{ id: 'task-y', operation: 'create', clock: { [DEVICE_ID]: 1 } }])
    const shedding = rowOf('task-x')
    let shed = 0
    const realGet = storage.get.bind(storage)
    vi.spyOn(storage, 'get').mockImplementation(async (key: string) => {
      if (key === shedding.blob_key) shed = await cleanupExpiredTombstones(harness.db, storage)
      return realGet(key)
    })

    settleRecords()
    const raced = await compactOneRange(harness.db, storage, SCOPE, 'record')
    vi.mocked(storage.get).mockRestore()

    expect(shed).toBe(1)
    expect(raced.built).toBe(false)
    expect(recordWatermark()).toBeNull()
    expect(rowOf('task-x')).toEqual({ blob_key: '', server_cursor: shedding.server_cursor })

    // The next run reads the marker as it now is: no payload, no entry.
    settleRecords()
    await compactOneRange(harness.db, storage, SCOPE, 'record')
    expect((await packedRecordItems()).map(({ item }) => item)).toEqual(await pull(app, ['task-y']))
    expect(recordWatermark()).toBe(rowOf('task-y').server_cursor)
  })

  // VERIFY-5253: the shed deletes the R2 object before its D1 update. A GET
  // between the two re-reads an unchanged row, which the shed still empties
  // in place on its next tick.
  it('abandons the range when an expired tombstone 404s before the shed marks it', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-x', operation: 'create', clock: { [DEVICE_ID]: 1 } }])
    await expiredTombstone(app, 'task-x')
    await push(app, [{ id: 'task-y', operation: 'create', clock: { [DEVICE_ID]: 1 } }])
    const shedding = rowOf('task-x')
    const realGet = storage.get.bind(storage)
    vi.spyOn(storage, 'get').mockImplementation(async (key: string) => {
      if (key === shedding.blob_key) await storage.delete(key)
      return realGet(key)
    })

    settleRecords()
    const raced = await compactOneRange(harness.db, storage, SCOPE, 'record')
    vi.mocked(storage.get).mockRestore()

    expect(raced.built).toBe(false)
    expect(recordWatermark()).toBeNull()
    expect(rowOf('task-x')).toEqual(shedding)
  })

  // VERIFY-5253: a tombstone inside retention never sheds, so a lost blob is
  // an ordinary hole, left to the manifest reconcile (#5254). It must not
  // hold back the vault's record packs until it expires.
  it('keeps a hole for an unexpired tombstone whose blob is lost', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-x', operation: 'create', clock: { [DEVICE_ID]: 1 } }])
    await push(app, [{ id: 'task-x', clock: { [DEVICE_ID]: 2 }, deletedAt: now() }])
    await push(app, [{ id: 'task-y', operation: 'create', clock: { [DEVICE_ID]: 1 } }])
    await storage.delete(rowOf('task-x').blob_key)

    settleRecords()
    const result = await compactOneRange(harness.db, storage, SCOPE, 'record')

    expect(result.built).toBe(true)
    expect(result.holes).toEqual(['task:task-x'])
    expect(recordWatermark()).toBe(rowOf('task-y').server_cursor)
  })

  // REVIEW-5253 probe a (#5254): a tombstone shed before it was packed is
  // never an entry. Its live version used to stay packed, so only GET
  // /sync/manifest said the item is gone. The shed now first rewrites the
  // record packs that hold the item (#5247, protocol 08 §8.13), so no pack
  // keeps the shed tombstone's item live.
  it('the shed rewrites the record packs holding the item first, so no pack keeps a shed tombstone live', async () => {
    const app = buildApp()
    await push(app, [
      { id: 'task-x', operation: 'create', clock: { [DEVICE_ID]: 1 } },
      { id: 'task-y', operation: 'create', clock: { [DEVICE_ID]: 1 } }
    ])
    settleRecords()
    await compactVault(harness.db, storage, SCOPE)
    await expiredTombstone(app, 'task-x')
    await push(app, [{ id: 'task-z', operation: 'create', clock: { [DEVICE_ID]: 1 } }])
    expect(await cleanupExpiredTombstones(harness.db, storage)).toBe(0)
    await rewritePurgedPacks(harness.db, storage, SCOPE)
    await deleteReplacedPackObjects(harness.db, storage, SCOPE)
    expect(await cleanupExpiredTombstones(harness.db, storage)).toBe(1)
    settleRecords()
    await compactVault(harness.db, storage, SCOPE)

    const packedX = (await packedRecordItems()).filter(({ item }) => item.id === 'task-x')
    expect(packedX).toEqual([])
    expect(recordWatermark()).toBe(rowOf('task-z').server_cursor)
    expect(rowOf('task-x').server_cursor).toBeLessThan(rowOf('task-z').server_cursor)
    expect(await manifestIds(app)).toEqual(['task-y', 'task-z'])
  })
})

describe('record coverage (#5230)', () => {
  const recordPacks = () =>
    harness.raw
      .prepare(
        `SELECT pack_key, cover_from, cover_through FROM pack_index WHERE item_kind = 'record' ORDER BY min_cursor`
      )
      .all() as Array<{ pack_key: string; cover_from: number | null; cover_through: number | null }>

  it('re-anchors a cache-only record chain and states coverage once rebuilt from 0', async () => {
    // #given: a pack built before migration 0023, which left every record
    // watermark without an anchor (all four on staging) and every pack cache-only
    const app = buildApp()
    await push(
      app,
      ['t-1', 't-2', 't-3'].map((id) => ({
        id,
        operation: 'create' as const,
        clock: { [DEVICE_ID]: 1 }
      }))
    )
    settleRecords()
    expect((await compactOneRange(harness.db, storage, SCOPE, 'record')).built).toBe(true)
    harness.raw.prepare('UPDATE pack_watermarks SET covered_through = NULL').run()
    harness.raw.prepare('UPDATE pack_index SET cover_from = NULL, cover_through = NULL').run()
    const [legacy] = recordPacks()
    await push(
      app,
      ['t-4', 't-5'].map((id) => ({ id, operation: 'create' as const, clock: { [DEVICE_ID]: 1 } }))
    )
    expect((await listPacks(harness.db, USER_ID, VAULT_ID)).coverage).toEqual([])

    // #when: the next record build
    const reanchored = await compactOneRange(harness.db, storage, SCOPE, 'record')

    // #then: the chain leaves the listing, its object waits out the grace period
    expect(reanchored).toMatchObject({ built: false, reason: 'skipped' })
    expect(recordPacks()).toEqual([])
    const replaced = harness.raw
      .prepare('SELECT replaced_by, removed_at FROM pack_replaced_objects WHERE pack_key = ?')
      .get(legacy.pack_key) as { replaced_by: string; removed_at: number }
    expect(replaced.replaced_by).toBe('reanchor')
    expect(replaced.removed_at).toBeGreaterThan(now() - 5)
    expect(await storage.get(legacy.pack_key)).not.toBeNull()

    // ... and the rebuild tiles from 0, so the listing states record coverage
    settleRecords()
    expect((await compactOneRange(harness.db, storage, SCOPE, 'record')).built).toBe(true)
    const top = rowOf('t-5').server_cursor
    expect(
      recordPacks().map(({ cover_from: from, cover_through: through }) => [from, through])
    ).toEqual([[0, top]])
    expect((await packedRecordItems()).map(({ item }) => item.id).toSorted()).toEqual([
      't-1',
      't-2',
      't-3',
      't-4',
      't-5'
    ])
    const listing = await listPacks(harness.db, USER_ID, VAULT_ID)
    expect(listing.coverage).toEqual([
      { itemKind: 'record', packedThrough: top, coveredThrough: top }
    ])
    expect(listing.packs[0]).toMatchObject({ coverFrom: 0, coverThrough: top })
  })

  it('an anchored chain is never re-anchored', async () => {
    const app = buildApp()
    await push(app, [{ id: 't-1', operation: 'create', clock: { [DEVICE_ID]: 1 } }])
    settleRecords()
    await compactOneRange(harness.db, storage, SCOPE, 'record')
    const before = recordPacks()
    await push(app, [{ id: 't-2', operation: 'create', clock: { [DEVICE_ID]: 1 } }])
    settleRecords()
    await compactOneRange(harness.db, storage, SCOPE, 'record')
    expect(recordPacks().slice(0, 1)).toEqual(before)
    expect(recordPacks()[1].cover_from).toBe(before[0].cover_through)
  })

  // VERIFY-5279 V5: the abandoned range comes back on every build until the
  // daily shed runs, so the chain spent its hops building nothing.
  it('a range abandoned for a tombstone the shed will empty ends the backfill chain', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-x', operation: 'create', clock: { [DEVICE_ID]: 1 } }])
    await expiredTombstone(app, 'task-x')
    await storage.delete(rowOf('task-x').blob_key)
    settleRecords()
    const queue = createMemoryQueue()

    const result = await runBackfillMessage(harness.db, storage, queue, SCOPE, {
      kind: 'record',
      hop: 0
    })

    expect(result).toMatchObject({ packsBuilt: 0, drained: true, continued: false })
    expect(queue.sent).toEqual([])
  })
})
