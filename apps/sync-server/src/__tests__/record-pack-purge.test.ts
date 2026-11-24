import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { encodeSignaturePayload } from '../lib/cbor'
import { errorHandler } from '../lib/errors'
import { cleanupExpiredTombstones } from '../services/cleanup'
import { storeSnapshot } from '../services/crdt-snapshot-write'
import { compactOneRange, compactVault } from '../services/pack-compaction'
import { parsePack } from '../services/pack-format'
import { deleteReplacedPackObjects } from '../services/pack-replaced-objects'
import { rewritePurgedPacks } from '../services/pack-purge-rewrite'
import { rollupKind } from '../services/pack-rollup'
import { PACK_SETTLE_SECONDS } from '../services/pack-sizing'
import type { AppContext, Bindings } from '../types'
import {
  PACK_PURGE_DEADLINE_SECONDS,
  PACK_REPLACED_GRACE_SECONDS,
  RECORD_SYNC_ITEM_TYPES,
  type PackListResponse,
  type RecordChangesResponse,
  type RecordSyncItemType
} from '@memry/contracts/sync-api'

/**
 * Record packs and the purge promise (#5247, protocol 08 §8.13): a deleted
 * note's older record versions leave every pack object within the deadline,
 * and a tombstone's entries leave every pack object before the shed empties
 * it. Real routes, services, SQL, migrations and pack format over an
 * in-memory R2; only auth is stubbed.
 */

const USER_ID = 'user-record-purge'
const DEVICE_ID = 'device-record-purge'
const VAULT_ID = 'default'
const SCOPE = { userId: USER_ID, vaultId: VAULT_ID }
const RETENTION_DAYS = 30

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
let send: ReturnType<typeof vi.fn>

const now = () => Math.floor(Date.now() / 1000)
const b64 = (length: number, fill: number) => Buffer.alloc(length, fill).toString('base64')

const seed = async (): Promise<void> => {
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
       VALUES (?, 'record-purge@example.com', 1, 'otp', 0, 0, ?, ?)`
    )
    .run(USER_ID, now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, ?, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024, RETENTION_DAYS, now())
  harness.raw
    .prepare(
      `INSERT INTO sync_vaults (id, user_id, vault_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run('vault-row', USER_ID, VAULT_ID, now(), now())
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, 'Record purge desktop', 'desktop', '1.0.0', ?, ?, ?)`
    )
    .run(DEVICE_ID, USER_ID, publicKey, now(), now())
}

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined
} as unknown as ExecutionContext

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
  tick: number
  operation: 'create' | 'update' | 'delete'
}

const signed = async ({ id, type, tick, operation }: PushSpec) => {
  const clock = { [DEVICE_ID]: tick }
  const base = {
    id,
    type,
    operation,
    cryptoVersion: 1,
    encryptedKey: b64(48, 0x11),
    keyNonce: b64(24, 0x22),
    encryptedData: Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64'),
    dataNonce: b64(24, 0x44),
    metadata: { clock },
    ...(operation === 'delete' ? { deletedAt: now() } : {})
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

const push = async (app: App, ...specs: PushSpec[]): Promise<void> => {
  const res = await app.request(
    '/sync/push',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: await Promise.all(specs.map(signed)) })
    },
    env,
    executionCtx
  )
  expect(res.status).toBe(200)
  const { accepted } = (await res.json()) as { accepted: string[] }
  expect(accepted).toEqual(specs.map((spec) => spec.id))
}

const getRoute = async <T>(app: App, path: string): Promise<T> => {
  const headers = { 'X-Memry-Sync-Types': RECORD_SYNC_ITEM_TYPES.join(',') }
  const res = await app.request(path, { headers }, env, executionCtx)
  expect(res.status).toBe(200)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test reader of a route whose shape the assertions check
  return (await res.json()) as T
}

/**
 * A fresh device's record bootstrap through the routes: the listed record
 * packs chained from cursor 0, then the changes feed past the chain. Each item
 * it ends with as `type:id@blob_key`, beside every row the server holds.
 */
const freshDeviceRecords = async (app: App) => {
  const { packs } = await getRoute<PackListResponse>(app, '/sync/packs?limit=50')
  const chain = packs
    .filter((pack) => pack.itemKind === 'record')
    .toSorted((a, b) => (a.coverFrom ?? 0) - (b.coverFrom ?? 0))
  const held = new Map<string, string>()
  let through = 0
  for (const pack of chain) {
    const object = await storage.get(pack.packKey)
    if (pack.coverFrom !== through || pack.coverThrough === undefined || !object) break
    const { entries } = await parsePack(new Uint8Array(await object.arrayBuffer()))
    for (const entry of entries) held.set(entry.id, entry.sourceKey)
    through = pack.coverThrough
  }
  const tail = await getRoute<RecordChangesResponse>(app, `/sync/changes?cursor=${through}`)
  expect(tail.hasMore).toBe(false)
  const rows = harness.raw
    .prepare('SELECT item_type, item_id, blob_key FROM sync_items')
    .all() as Array<{ item_type: string; item_id: string; blob_key: string }>
  for (const id of [...tail.items.map((item) => item.id), ...tail.deleted]) {
    const row = rows.find((candidate) => candidate.item_id === id)
    if (row) held.set(`${row.item_type}:${id}`, row.blob_key)
  }
  return {
    device: [...held].map(([id, key]) => `${id}@${key}`).toSorted(),
    server: rows.map((row) => `${row.item_type}:${row.item_id}@${row.blob_key}`).toSorted()
  }
}

/** Builds the record kind until nothing is left above its watermark. */
const compactAll = async (): Promise<void> => {
  vi.setSystemTime(Date.now() + (PACK_SETTLE_SECONDS + 1) * 1000)
  for (let run = 0; run < 20; run++) {
    if (!(await compactVault(harness.db, storage, SCOPE)).some((result) => result.built)) return
  }
  throw new Error('compaction did not drain')
}

const blobKey = (id: string): string =>
  (
    harness.raw.prepare('SELECT blob_key FROM sync_items WHERE item_id = ?').get(id) as {
      blob_key: string
    }
  ).blob_key

/** Every record pack object in R2, listed or not, with the entries it holds. */
const recordObjects = async (): Promise<Array<{ key: string; entries: string[] }>> => {
  const { objects } = await storage.list({ prefix: `${USER_ID}/vaults/${VAULT_ID}/packs/record/` })
  const out: Array<{ key: string; entries: string[] }> = []
  for (const { key } of objects) {
    const object = await storage.get(key)
    if (!object) continue
    const { entries } = await parsePack(new Uint8Array(await object.arrayBuffer()))
    out.push({ key, entries: entries.map((entry) => `${entry.id}@${entry.sourceKey}`) })
  }
  return out
}

const heldBy = async (needle: string): Promise<string[]> =>
  (await recordObjects())
    .filter((object) => object.entries.some((entry) => entry.includes(needle)))
    .map((object) => object.key)

const listedRecordPacks = () =>
  harness.raw
    .prepare(
      `SELECT pack_key, cover_from, cover_through FROM pack_index
       WHERE item_kind = 'record' ORDER BY min_cursor`
    )
    .all() as Array<{ pack_key: string; cover_from: number | null; cover_through: number | null }>

const coverage = () =>
  listedRecordPacks().map(({ cover_from: from, cover_through: through }) => [from, through])

const coverOf = (pack: { cover_from: number | null; cover_through: number | null }) => ({
  cover_from: pack.cover_from,
  cover_through: pack.cover_through
})

/** Runs the passes a compaction message runs first (pack-message-passes.ts). */
const messagePasses = async (): Promise<void> => {
  await rewritePurgedPacks(harness.db, storage, SCOPE)
  await deleteReplacedPackObjects(harness.db, storage, SCOPE)
}

const pastRetention = () => vi.setSystemTime(Date.now() + (RETENTION_DAYS + 1) * 86_400 * 1000)

const pendingRewrites = () =>
  harness.raw
    .prepare(`SELECT pack_key FROM pack_replaced_objects WHERE replaced_by = 'rewrite'`)
    .pluck()
    .all()

const shedRow = (id: string) =>
  harness.raw.prepare('SELECT blob_key FROM sync_items WHERE item_id = ?').get(id) as {
    blob_key: string
  }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  harness = createSqliteD1()
  storage = createMemoryR2()
  send = vi.fn()
  env = {
    DB: harness.db,
    STORAGE: storage,
    ENVIRONMENT: 'development',
    PACK_QUEUE: { send },
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
  vi.useRealTimers()
})

describe('record packs and the purge promise (#5247, protocol 08 §8.13)', () => {
  it('deleting a note takes its older record versions out of every pack object within the deadline', async () => {
    const app = buildApp()
    await push(
      app,
      { id: 'note-x', type: 'note', tick: 1, operation: 'create' },
      { id: 'task-keep', type: 'task', tick: 1, operation: 'create' }
    )
    const firstVersion = blobKey('note-x')
    await compactAll()
    await push(app, { id: 'note-x', type: 'note', tick: 2, operation: 'update' })
    const secondVersion = blobKey('note-x')
    await compactAll()
    expect(await heldBy(firstVersion)).toHaveLength(1)
    expect(await heldBy(secondVersion)).toHaveLength(1)
    const coveredBefore = coverage()

    const deletedAt = now()
    await push(app, { id: 'note-x', type: 'note', tick: 3, operation: 'delete' })

    expect(now() - deletedAt).toBeLessThanOrEqual(PACK_PURGE_DEADLINE_SECONDS)
    expect(await heldBy(firstVersion)).toEqual([])
    expect(await heldBy(secondVersion)).toEqual([])
    // The other item stays packed, under the same coverage.
    expect(await heldBy(`task:task-keep@${blobKey('task-keep')}`)).toHaveLength(1)
    // The emptied pack's coverage moved to its neighbour: no hole (REVIEW-5452).
    expect(coverage()).toEqual([[coveredBefore[0][0], coveredBefore[coveredBefore.length - 1][1]]])
  })

  it('the shed waits until no pack object holds the tombstone or an older version of its item', async () => {
    const app = buildApp()
    await push(
      app,
      { id: 'task-gone', type: 'task', tick: 1, operation: 'create' },
      { id: 'task-keep', type: 'task', tick: 1, operation: 'create' }
    )
    await compactAll()
    await push(app, { id: 'task-gone', type: 'task', tick: 2, operation: 'delete' })
    const tombstone = blobKey('task-gone')
    await compactAll()
    expect(await heldBy('task:task-gone@')).toHaveLength(2)
    expect(await heldBy(tombstone)).toHaveLength(1)
    const coveredBefore = coverage()
    pastRetention()

    // First tick: the packs holding it leave the listing; nothing is shed.
    expect(await cleanupExpiredTombstones(harness.db, storage, env)).toBe(0)
    expect(shedRow('task-gone').blob_key).toBe(tombstone)
    expect(send).toHaveBeenCalledWith({ userId: USER_ID, vaultId: VAULT_ID })

    // The compaction message rewrites them without the item's entries.
    await messagePasses()
    expect(await heldBy('task:task-gone@')).toEqual([])
    expect(await heldBy(`task:task-keep@${blobKey('task-keep')}`)).toHaveLength(1)
    // The emptied pack's coverage moved to its neighbour: no hole (REVIEW-5452).
    expect(coverage()).toEqual([[coveredBefore[0][0], coveredBefore[coveredBefore.length - 1][1]]])

    // The next tick sheds it.
    vi.setSystemTime(Date.now() + (PACK_REPLACED_GRACE_SECONDS + 1) * 1000)
    expect(await cleanupExpiredTombstones(harness.db, storage, env)).toBe(1)
    expect(shedRow('task-gone').blob_key).toBe('')
  })

  it('a record pack of unknown contents resets the kind before the shed, which waits for its objects', async () => {
    const app = buildApp()
    await push(
      app,
      { id: 'task-gone', type: 'task', tick: 1, operation: 'delete' },
      { id: 'task-keep', type: 'task', tick: 1, operation: 'create' }
    )
    await compactAll()
    // A pack listed before record packs recorded the items they hold.
    harness.raw.prepare(`UPDATE pack_index SET documents = NULL WHERE item_kind = 'record'`).run()
    pastRetention()

    expect(await cleanupExpiredTombstones(harness.db, storage, env)).toBe(0)
    expect(listedRecordPacks()).toEqual([])

    await deleteReplacedPackObjects(harness.db, storage, SCOPE)
    expect(await heldBy('task:task-gone@')).toEqual([])
    expect(await cleanupExpiredTombstones(harness.db, storage, env)).toBe(1)

    // The rebuild lists the kind again, with coverage and the items it holds:
    // the first run re-anchors the reset chain, the second builds.
    await compactAll()
    await compactAll()
    expect(await heldBy(`task:task-keep@${blobKey('task-keep')}`)).toHaveLength(1)
    expect(listedRecordPacks()).toEqual([
      expect.objectContaining({ cover_from: 0, cover_through: expect.any(Number) })
    ])
    expect(
      harness.raw.prepare(`SELECT documents FROM pack_index WHERE item_kind = 'record'`).get()
    ).toEqual({ documents: JSON.stringify(['task:task-keep']) })
  })

  it('a build that lists the tombstone after the shed read the listing keeps the row unshed', async () => {
    const app = buildApp()
    await push(app, { id: 'task-gone', type: 'task', tick: 1, operation: 'delete' })
    pastRetention()
    // The build commits between the shed's listing read and its row update.
    const realDelete = storage.delete.bind(storage)
    storage.delete = async (keys: string | string[]) => {
      storage.delete = realDelete
      await compactAll()
      return realDelete(keys)
    }

    expect(await cleanupExpiredTombstones(harness.db, storage, env)).toBe(0)
    expect(listedRecordPacks()).toHaveLength(1)
  })

  it('a record pack whose rewrite keeps nothing hands its coverage on, so the chain stays contiguous from 0 (REVIEW-5452)', async () => {
    const app = buildApp()
    await push(app, { id: 'note-a', type: 'note', tick: 1, operation: 'create' })
    await compactAll()
    await push(app, { id: 'task-b', type: 'task', tick: 1, operation: 'create' })
    await compactAll()
    await push(app, { id: 'note-a', type: 'note', tick: 2, operation: 'delete' })
    await messagePasses()
    await compactAll()

    const chain = coverage()
    expect(chain[0][0]).toBe(0)
    for (let i = 1; i < chain.length; i++) expect(chain[i][0]).toBe(chain[i - 1][1])
    expect(
      harness.raw
        .prepare(`SELECT COUNT(*) AS n FROM pack_replaced_objects WHERE replaced_by = 'rewrite'`)
        .get()
    ).toEqual({ n: 0 })
  })

  // VERIFY-5452 #3: the first emptied pack found no listed neighbour, because
  // the second still waited for its rewrite, so the pass reset the record kind.
  // REVIEW-5636 #2, #7: three packs take three rounds, and each retry read and
  // parsed the pack object again.
  it('emptied record packs at the start of the chain hand their coverage to the pack after them, reading each object once', async () => {
    const app = buildApp()
    const versions: string[] = []
    for (const tick of [1, 2, 3]) {
      const operation = tick === 1 ? 'create' : 'update'
      await push(app, { id: 'note-a', type: 'note', tick, operation })
      await compactAll()
      versions.push(blobKey('note-a'))
    }
    await push(app, { id: 'task-keep', type: 'task', tick: 1, operation: 'create' })
    await compactAll()
    const before = listedRecordPacks()
    expect(before).toHaveLength(4)
    const get = vi.spyOn(storage, 'get')

    await push(app, { id: 'note-a', type: 'note', tick: 4, operation: 'delete' })

    for (const { pack_key: key } of before.slice(0, 3)) {
      expect(get.mock.calls.filter(([read]) => read === key)).toHaveLength(1)
    }
    for (const version of versions) expect(await heldBy(version)).toEqual([])
    expect(listedRecordPacks()).toEqual([
      { pack_key: before[3].pack_key, cover_from: 0, cover_through: before[3].cover_through }
    ])
  })

  // REVIEW-5636 #3: the other queue's pass handed the first pack's coverage on
  // and deleted its object between two rounds; the retry read the object, found
  // it missing and reset the kind that pass had just settled.
  it('a retry whose rewrite a concurrent pass settled leaves the record packs listed', async () => {
    const app = buildApp()
    await push(app, { id: 'note-a', type: 'note', tick: 1, operation: 'create' })
    await compactAll()
    await push(app, { id: 'note-a', type: 'note', tick: 2, operation: 'update' })
    await compactAll()
    await push(app, { id: 'task-keep', type: 'task', tick: 1, operation: 'create' })
    await compactAll()
    const [, second, kept] = listedRecordPacks()
    const settled = harness.raw.prepare(
      `SELECT 1 FROM pack_replaced_objects WHERE pack_key = ? AND replaced_by = 'purge'`
    )
    const batch = harness.db.batch.bind(harness.db)
    let raced = false
    vi.spyOn(harness.db, 'batch').mockImplementation(async (statements) => {
      const results = await batch(statements)
      if (!raced && settled.get(second.pack_key)) {
        raced = true
        await messagePasses()
      }
      return results
    })

    await push(app, { id: 'note-a', type: 'note', tick: 3, operation: 'delete' })

    expect(raced).toBe(true)
    expect(listedRecordPacks()).toEqual([{ ...kept, cover_from: 0 }])
  })

  // VERIFY-5636 #9 (#5247): a compaction message settled both rewrites and its
  // deletion pass removed the old objects between the purge pass's SELECT and
  // its read; the read found the object missing and reset the record kind.
  it('a rewrite whose pack a concurrent pass settled and deleted before its read leaves the record packs listed', async () => {
    const app = buildApp()
    await push(
      app,
      { id: 'note-x', type: 'note', tick: 1, operation: 'create' },
      { id: 'task-keep', type: 'task', tick: 1, operation: 'create' }
    )
    await compactAll()
    await push(app, { id: 'note-x', type: 'note', tick: 2, operation: 'update' })
    await compactAll()
    const before = listedRecordPacks()
    expect(before).toHaveLength(2)
    const read = storage.get.bind(storage)
    let raced = false
    vi.spyOn(storage, 'get').mockImplementation(async (key, options) => {
      if (!raced && pendingRewrites().includes(key)) {
        raced = true
        await messagePasses()
      }
      return read(key, options)
    })

    await push(app, { id: 'note-x', type: 'note', tick: 3, operation: 'delete' })

    expect(raced).toBe(true)
    expect(pendingRewrites()).toEqual([])
    expect(listedRecordPacks()).toEqual([
      expect.objectContaining({ cover_from: 0, cover_through: before[1].cover_through })
    ])
    expect(await heldBy('note:note-x@')).toEqual([])
    const { device, server } = await freshDeviceRecords(app)
    expect(device).toEqual(server)
  })

  // REVIEW-5636 #4: the pass settled one rewrite and left two for the next
  // pass, one of them the neighbour an emptied pack waited for, and reset the
  // record kind anyway.
  it('an emptied pack whose neighbour waits for the next pass hands its coverage on there instead of resetting the kind', async () => {
    const app = buildApp()
    await push(app, { id: 'task-gone', type: 'task', tick: 1, operation: 'create' })
    await compactAll()
    for (const tick of [1, 2, 3]) {
      const operation = tick === 1 ? 'create' : 'update'
      await push(app, { id: 'note-a', type: 'note', tick, operation })
      await compactAll()
    }
    await push(app, { id: 'task-next', type: 'task', tick: 1, operation: 'create' })
    await compactAll()
    await push(
      app,
      { id: 'task-gone', type: 'task', tick: 2, operation: 'delete' },
      { id: 'task-keep', type: 'task', tick: 1, operation: 'create' }
    )
    await compactAll()
    const before = listedRecordPacks()
    expect(before).toHaveLength(6)
    pastRetention()
    // The shed takes the task's two packs out first; the note's purge then adds
    // its three, so the pass runs four of the five rewrites.
    expect(await cleanupExpiredTombstones(harness.db, storage, env)).toBe(0)
    vi.setSystemTime(Date.now() + 1000)

    await push(app, { id: 'note-a', type: 'note', tick: 4, operation: 'delete' })

    expect(listedRecordPacks()).toEqual([before[4], expect.objectContaining(coverOf(before[5]))])
    expect(pendingRewrites()).toHaveLength(4)

    await messagePasses()

    expect(pendingRewrites()).toEqual([])
    expect(coverage()).toEqual([
      [0, before[4].cover_through],
      [before[5].cover_from, before[5].cover_through]
    ])
    expect(await heldBy('note:note-a@')).toEqual([])
  })

  // REVIEW-5636 #7: no later pass runs the rewrite, so the reset still settles it.
  it('a pass that settled a rewrite and leaves none for later resets the kind for an emptied pack with no neighbour', async () => {
    const app = buildApp()
    await push(app, { id: 'note-a', type: 'note', tick: 1, operation: 'create' })
    const version = blobKey('note-a')
    const snapshot = new Uint8Array([0xe1, 0xe2, 0xe3]).buffer
    await storeSnapshot(harness.db, storage, USER_ID, VAULT_ID, 'note-a', DEVICE_ID, snapshot)
    await compactAll()
    expect(listedRecordPacks()).toHaveLength(1)
    expect(
      harness.raw
        .prepare(`SELECT COUNT(*) AS n FROM pack_index WHERE item_kind = 'crdt_snapshot'`)
        .get()
    ).toEqual({ n: 1 })

    await push(app, { id: 'note-a', type: 'note', tick: 2, operation: 'delete' })

    expect(pendingRewrites()).toEqual([])
    expect(await heldBy(version)).toEqual([])
  })

  it('a rollup whose input coverage changed after its plan does not swap', async () => {
    const app = buildApp()
    // One more pack than the bound of a tiny vault (packCountBound), so the rollup runs.
    for (const id of ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6', 'task-7']) {
      await push(app, { id, type: 'task', tick: 1, operation: 'create' })
      // One build, no rollup.
      vi.setSystemTime(Date.now() + (PACK_SETTLE_SECONDS + 1) * 1000)
      await compactOneRange(harness.db, storage, SCOPE, 'record')
    }
    const before = listedRecordPacks()
    expect(before).toHaveLength(7)
    // A purge rewrite hands the first pack's coverage on between plan and swap.
    const realPut = storage.put.bind(storage)
    let planned = false
    storage.put = (async (...args: Parameters<R2Bucket['put']>) => {
      storage.put = realPut
      planned = true
      harness.raw
        .prepare(
          `UPDATE pack_index SET cover_from = -1 WHERE item_kind = 'record' AND cover_from = 0`
        )
        .run()
      return realPut(...args)
    }) as R2Bucket['put']

    // The swap fails, so the rollup reports nothing merged.
    expect(await rollupKind(harness.db, storage, SCOPE, 'record')).toBeNull()
    expect(planned).toBe(true)
    expect(listedRecordPacks().map((pack) => pack.pack_key)).toEqual(
      before.map((pack) => pack.pack_key)
    )
  })

  it('a vault whose record packs cannot be read waits for the next tick without failing the shed', async () => {
    const app = buildApp()
    await push(app, { id: 'task-gone', type: 'task', tick: 1, operation: 'delete' })
    await compactAll()
    pastRetention()
    const realBatch = harness.db.batch.bind(harness.db)
    harness.db.batch = async () => {
      harness.db.batch = realBatch
      throw new Error('D1 down')
    }

    expect(await cleanupExpiredTombstones(harness.db, storage, env)).toBe(0)
    expect(shedRow('task-gone').blob_key).not.toBe('')
    expect(await cleanupExpiredTombstones(harness.db, storage, env)).toBe(0)
    await messagePasses()
    expect(await cleanupExpiredTombstones(harness.db, storage, env)).toBe(1)
  })
})
