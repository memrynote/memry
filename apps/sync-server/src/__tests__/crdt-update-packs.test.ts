import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { runBackfillTick } from './pack-queue-memory'
import { encodeSignaturePayload } from '../lib/cbor'
import { errorHandler } from '../lib/errors'
import { storeUpdatesWithCursor } from '../services/crdt'
import { storeSnapshot } from '../services/crdt-snapshot-write'
import { compactOneRange, compactVault } from '../services/pack-compaction'
import { extractEntry, parsePack, type PackedEntry } from '../services/pack-format'
import { PACK_MIN_FILL_ROWS, PACK_SETTLE_SECONDS } from '../services/pack-sizing'
import { updateSelectionQuery } from '../services/pack-update-selection'
import type { AppContext, Bindings } from '../types'
import {
  CrdtUpdatePackEntryMetaSchema,
  PACK_LIST_MAX_PACKS_PER_VAULT,
  type PackListResponse,
  type RecordSyncItemType
} from '@memry/contracts/sync-api'

/**
 * #5228: the server builds crdt_update (kind 2) packs (protocol 08 §8.4.3), and
 * the two prerequisites the contract puts on the first kind 2 writer: the
 * explicit `floor` on both update routes, and a purge that drops every
 * crdt_update pack whenever it deletes an update row. Real routes, services,
 * SQL and schema; only auth is stubbed.
 */

const USER_ID = 'user-update-packs'
const DEVICE_ID = 'device-update-packs'
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
const b64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer

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
       VALUES (?, 'update-packs@example.com', 1, 'otp', 0, 0, ?, ?)`
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
       VALUES (?, ?, 'Update pack desktop', 'desktop', '1.0.0', ?, ?, ?)`
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

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined
} as unknown as ExecutionContext

const request = async <T>(app: App, path: string, body?: unknown): Promise<T> => {
  const res = await app.request(
    path,
    body === undefined
      ? { method: 'GET' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        },
    env,
    executionCtx
  )
  expect(res.status).toBe(200)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test reader of a route whose shape the assertions below check
  return (await res.json()) as T
}

const pushJournal = async (app: App, clock: Record<string, number>, deleted = false) => {
  const base = {
    id: 'j2026-05-01',
    type: 'journal' as RecordSyncItemType,
    operation: deleted ? ('delete' as const) : ('create' as const),
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
  const { accepted } = await request<{ accepted: string[] }>(app, '/sync/push', {
    items: [{ ...wire, clock, signature, signerDeviceId: DEVICE_ID }]
  })
  expect(accepted).toEqual([base.id])
}

const writeUpdates = (noteId: string, ...updates: ArrayBuffer[]) =>
  storeUpdatesWithCursor(harness.db, USER_ID, VAULT_ID, noteId, DEVICE_ID, updates)
const writeSnapshot = (noteId: string, data: ArrayBuffer, coversThrough?: number) =>
  storeSnapshot(
    harness.db,
    storage,
    USER_ID,
    VAULT_ID,
    noteId,
    DEVICE_ID,
    data,
    null,
    coversThrough === undefined ? undefined : { coversThrough }
  )

/** Moves the clock past the update minimum fill's wait, so any unpacked update row is due. */
const passFillWait = () => vi.setSystemTime(Date.now() + (PACK_SETTLE_SECONDS + 1) * 1000)

/**
 * Builds packs until no kind has anything left above its watermark: the push
 * nudge for records and snapshots, the cron tick's call for updates past the
 * minimum fill.
 */
const compactAll = async (): Promise<void> => {
  passFillWait()
  for (let run = 0; run < 20; run++) {
    const results = [
      ...(await compactVault(harness.db, storage, SCOPE)),
      await compactOneRange(harness.db, storage, SCOPE, 'crdt_update')
    ]
    if (!results.some((result) => result.built)) return
  }
  throw new Error('compaction did not drain')
}

interface Downloaded {
  summary: PackListResponse['packs'][number]
  bytes: Uint8Array
  entries: PackedEntry[]
}

/** Every listed pack through GET /sync/packs, downloaded and verified. */
const downloadPacks = async (app: App): Promise<Downloaded[]> => {
  const out: Downloaded[] = []
  let cursor: string | undefined
  do {
    const page = await request<PackListResponse>(
      app,
      `/sync/packs?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    )
    for (const summary of page.packs) {
      const object = await storage.get(summary.packKey)
      expect(object).not.toBeNull()
      const packBytes = new Uint8Array(await object!.arrayBuffer())
      out.push({ summary, bytes: packBytes, entries: (await parsePack(packBytes)).entries })
    }
    cursor = page.nextCursor
  } while (cursor)
  return out
}

interface BatchAnswer {
  notes: Record<string, { updates: unknown[]; hasMore: boolean; floor?: number }>
  snapshotMeta: Record<string, { sequenceNum: number; revision: string }>
}

/**
 * A reader of protocol 08 §8.4.3 and §8.10 (Bodies): a packed snapshot is the
 * baseline only when its revision matches `snapshotMeta`, and a packed update
 * applies only above `floor` and at cursor + 1, both read from the batch route
 * after the packs. Answers the body as base64 chunks, or null when the packs
 * do not cover the note and the routes would have to fill a gap.
 */
const bodyFromPacks = (
  packs: Downloaded[],
  noteId: string,
  answer: BatchAnswer
): string[] | null => {
  const floor = answer.notes[noteId]?.floor
  if (floor === undefined) return null
  const body: string[] = []
  // Below the floor the server holds nothing of this incarnation.
  let cursor = floor
  const meta = answer.snapshotMeta[noteId]
  if (meta) {
    const baseline = packs
      .flatMap((pack) => pack.entries.map((entry) => ({ pack, entry })))
      .find(
        ({ entry }) =>
          entry.kind === 'crdt_snapshot' &&
          entry.id === noteId &&
          entry.meta?.revision === meta.revision
      )
    if (!baseline) return null
    body.push(b64Of(extractEntry(baseline.pack.bytes, baseline.entry)))
    cursor = Math.max(cursor, meta.sequenceNum)
  }
  const updates = packs
    .flatMap((pack) =>
      pack.entries
        .filter((entry) => entry.kind === 'crdt_update' && entry.id === noteId)
        .map((entry) => ({
          meta: CrdtUpdatePackEntryMetaSchema.parse(entry.meta),
          data: b64Of(extractEntry(pack.bytes, entry))
        }))
    )
    .toSorted((a, b) => a.meta.sequenceNum - b.meta.sequenceNum)
  for (const update of updates) {
    if (update.meta.sequenceNum <= cursor || update.meta.sequenceNum <= floor) continue
    if (update.meta.sequenceNum !== cursor + 1) return null
    body.push(update.data)
    cursor++
  }
  return body
}

/** The same body through GET /sync/crdt/snapshot/:noteId plus GET /sync/crdt/updates. */
const bodyFromRoutes = async (app: App, noteId: string): Promise<string[]> => {
  const snapshot = await request<{ snapshot: string | null; sequenceNum: number }>(
    app,
    `/sync/crdt/snapshot/${noteId}`
  )
  const updates = await request<{ updates: Array<{ data: string }>; hasMore: boolean }>(
    app,
    `/sync/crdt/updates?note_id=${noteId}&since=${snapshot.sequenceNum}&limit=500`
  )
  expect(updates.hasMore).toBe(false)
  return [...(snapshot.snapshot ? [snapshot.snapshot] : []), ...updates.updates.map((u) => u.data)]
}

const batchAnswer = (app: App, noteIds: string[]) =>
  request<BatchAnswer>(app, '/sync/crdt/updates/batch', {
    notes: noteIds.map((noteId) => ({ noteId, since: 0 })),
    limit: 100
  })

const count = (sql: string): number => (harness.raw.prepare(sql).get() as { n: number }).n
const updatePackCount = () =>
  count(`SELECT COUNT(*) AS n FROM pack_index WHERE item_kind = 'crdt_update'`)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
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
  vi.useRealTimers()
})

describe('crdt_update packs (#5228)', () => {
  it('every body rebuilt from snapshot and update packs matches the item routes', async () => {
    const app = buildApp()
    // Pruned: a pack built before the claimed snapshot still holds 1..3.
    const pruned = await writeUpdates('note-pruned', bytes(1, 1), bytes(1, 2), bytes(1, 3))
    await compactAll()
    await writeSnapshot('note-pruned', bytes(9, 1), pruned.cursor)
    await writeUpdates('note-pruned', bytes(1, 4), bytes(1, 5))
    // Updates and no snapshot: update packs are its only bulk path.
    await writeUpdates('note-updates-only', bytes(2, 1), bytes(2, 2), bytes(2, 3))
    // An unclaimed snapshot keeps the updates it was taken over.
    await writeUpdates('note-unclaimed', bytes(3, 1), bytes(3, 2))
    await writeSnapshot('note-unclaimed', bytes(9, 3))
    await writeUpdates('note-unclaimed', bytes(3, 3))
    await writeSnapshot('note-snapshot-only', bytes(9, 4))
    await compactAll()

    const packs = await downloadPacks(app)
    const noteIds = ['note-pruned', 'note-updates-only', 'note-unclaimed', 'note-snapshot-only']
    const answer = await batchAnswer(app, noteIds)

    expect(answer.notes['note-pruned'].updates).toHaveLength(2)
    for (const noteId of noteIds) {
      const fromRoutes = await bodyFromRoutes(app, noteId)
      expect(fromRoutes.length).toBeGreaterThan(0)
      expect({ noteId, body: bodyFromPacks(packs, noteId, answer) }).toEqual({
        noteId,
        body: fromRoutes
      })
    }
    expect(bodyFromPacks(packs, 'note-updates-only', answer)).toHaveLength(3)
  })

  // The reason for the floor: a pack downloaded before a purge still holds
  // the deleted incarnation's updates 1..3.
  it('a reader holding a pack from before a purge rebuilds only the re-created body', async () => {
    const app = buildApp()
    const dayId = 'j2026-05-01'
    await pushJournal(app, { [DEVICE_ID]: 1 })
    await writeUpdates(dayId, bytes(1, 1), bytes(1, 2), bytes(1, 3))
    await compactAll()
    const before = await downloadPacks(app)
    await pushJournal(app, { [DEVICE_ID]: 2 }, true)
    await pushJournal(app, { [DEVICE_ID]: 3 })
    await writeUpdates(dayId, bytes(2, 1))
    await compactAll()

    const packs = [...before, ...(await downloadPacks(app))]
    const answer = await batchAnswer(app, [dayId])

    expect(bodyFromPacks(packs, dayId, answer)).toEqual(await bodyFromRoutes(app, dayId))
    expect(await bodyFromRoutes(app, dayId)).toEqual([b64Of(new Uint8Array([2, 1]))])
    const { floor: _floor, ...withoutFloor } = answer.notes[dayId]
    expect(bodyFromPacks(packs, dayId, { ...answer, notes: { [dayId]: withoutFloor } })).toBeNull()
  })

  it('writes entries with the document id, empty key, server_cursor sort key and route meta', async () => {
    const app = buildApp()
    await writeUpdates('note-a', bytes(1, 1), bytes(1, 2))
    await writeUpdates('note-b', bytes(2, 1))
    await compactAll()

    const packs = (await downloadPacks(app)).filter(
      (pack) => pack.summary.itemKind === 'crdt_update'
    )
    expect(packs).toHaveLength(1)
    const rows = harness.raw
      .prepare(
        'SELECT note_id, sequence_num, server_cursor, created_at, signer_device_id FROM crdt_updates ORDER BY server_cursor'
      )
      .all() as Array<{
      note_id: string
      sequence_num: number
      server_cursor: number
      created_at: number
      signer_device_id: string
    }>
    expect(
      packs[0].entries.map(({ id, sourceKey, sortKey, meta }) => ({ id, sourceKey, sortKey, meta }))
    ).toEqual(
      rows.map((row) => ({
        id: row.note_id,
        sourceKey: '',
        sortKey: row.server_cursor,
        meta: {
          sequenceNum: row.sequence_num,
          signerDeviceId: row.signer_device_id,
          createdAt: row.created_at
        }
      }))
    )
    expect(packs[0].summary).toMatchObject({
      minCursor: rows[0].server_cursor,
      maxCursor: rows[rows.length - 1].server_cursor,
      itemCount: 3
    })
  })

  it('never packs a row written before migration 0011 (NULL server_cursor)', async () => {
    harness.raw
      .prepare(
        `INSERT INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at)
         VALUES ('legacy', ?, ?, 'note-legacy', ?, 1, ?, ?)`
      )
      .run(USER_ID, VAULT_ID, Buffer.from([7, 7]), DEVICE_ID, now())

    await compactAll()

    expect(updatePackCount()).toBe(0)
  })

  it('the cron backfill builds no update pack below the minimum fill', async () => {
    await writeUpdates('note-a', bytes(1, 1))

    expect((await runBackfillTick(harness.db, storage)).enqueued).toBe(0)
    expect(updatePackCount()).toBe(0)
  })

  it('the cron backfill builds an update pack once the oldest row is 24 h old', async () => {
    await writeUpdates('note-a', bytes(1, 1))
    passFillWait()

    await runBackfillTick(harness.db, storage)
    expect(updatePackCount()).toBe(1)
  })

  it('the cron backfill builds an update pack once the vault holds the minimum row count', async () => {
    for (let i = 0; i < PACK_MIN_FILL_ROWS; i += 64) {
      await writeUpdates(`note-${i}`, ...Array.from({ length: 64 }, (_, j) => bytes(i % 256, j)))
    }

    await runBackfillTick(harness.db, storage)
    expect(updatePackCount()).toBe(1)
  })

  // REVIEW-5260 P3: a push nudge used to list one tiny update pack per push.
  it('push nudges build no update pack; the fill-ready build packs them all at once', async () => {
    for (let i = 0; i < 10; i++) {
      await writeUpdates(`note-${i}`, bytes(1, i))
      await compactVault(harness.db, storage, SCOPE)
    }
    expect(updatePackCount()).toBe(0)

    passFillWait()
    const built = await compactOneRange(harness.db, storage, SCOPE, 'crdt_update')

    expect(built).toMatchObject({ built: true, itemCount: 10 })
    expect(updatePackCount()).toBe(1)
  })

  it('builds nothing and moves no watermark below the minimum fill', async () => {
    await writeUpdates('note-a', bytes(1, 1))

    expect((await compactOneRange(harness.db, storage, SCOPE, 'crdt_update')).built).toBe(false)
    expect(count('SELECT COUNT(*) AS n FROM pack_watermarks')).toBe(0)
  })

  // REVIEW-5260 P5: the selection used to scan every update row and sort it.
  it('the selection rides the server_cursor index with no sort', () => {
    const query = updateSelectionQuery(SCOPE, { last_sort_value: 0, last_sort_tiebreak: '' }, 4096)
    const plan = (
      harness.raw
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .all(...(query.bind as never[])) as Array<{
        detail: string
      }>
    ).map((row) => row.detail)

    expect(plan.some((detail) => detail.includes('idx_crdt_updates_user_cursor'))).toBe(true)
    expect(plan.some((detail) => detail.includes('TEMP B-TREE'))).toBe(false)
  })
})

describe('the listing cap (REVIEW-5260 P2, VERIFY-5260, protocol 08 §8.14)', () => {
  const listPack = (id: string, sortValue: number, vaultId = VAULT_ID) =>
    harness.raw
      .prepare(
        `INSERT INTO pack_index (id, user_id, vault_id, pack_key, item_kind, min_cursor, max_cursor, item_count, byte_size, created_at)
         VALUES (?, ?, ?, ?, 'crdt_snapshot', ?, ?, 1, 1, ?)`
      )
      .run(
        id,
        USER_ID,
        vaultId,
        `${USER_ID}/vaults/${vaultId}/packs/x/${id}`,
        sortValue,
        sortValue,
        now()
      )
  const listPacks = (n: number, vaultId = VAULT_ID) => {
    for (let i = 0; i < n; i++) listPack(`${vaultId}-${i}`, i, vaultId)
  }
  const watermarks = () => count('SELECT COUNT(*) AS n FROM pack_watermarks')

  // VERIFY-5260 V1: the post-batch cap check counted the build's own row, so
  // the last slot deleted the object of a listed pack.
  it('the last free slot lists the pack with its object and moves the watermark', async () => {
    listPacks(PACK_LIST_MAX_PACKS_PER_VAULT - 1)
    await writeUpdates('note-a', bytes(1, 1))
    passFillWait()

    const result = await compactOneRange(harness.db, storage, SCOPE, 'crdt_update')

    expect(result.built).toBe(true)
    expect(count('SELECT COUNT(*) AS n FROM pack_index')).toBe(PACK_LIST_MAX_PACKS_PER_VAULT)
    expect(await storage.get(result.packKey!)).not.toBeNull()
    expect(watermarks()).toBe(1)
  })

  // VERIFY-5260 V2: capped vaults sorted first every tick and spent the budget.
  it('vaults at the cap do not starve the backfill of every other vault', async () => {
    for (const vaultId of ['capped-1', 'capped-2', 'capped-3']) {
      listPacks(PACK_LIST_MAX_PACKS_PER_VAULT, vaultId)
      await storeUpdatesWithCursor(harness.db, USER_ID, vaultId, 'note-x', DEVICE_ID, [bytes(3, 1)])
    }
    await writeUpdates('note-a', bytes(1, 1))
    passFillWait()

    await runBackfillTick(harness.db, storage)

    expect(updatePackCount()).toBe(1)
  })

  it('a vault listing the maximum builds no pack of any kind and moves no watermark', async () => {
    listPacks(PACK_LIST_MAX_PACKS_PER_VAULT)
    await writeUpdates('note-a', bytes(1, 1))
    await writeSnapshot('note-b', bytes(9, 1))
    passFillWait()

    for (const kind of ['crdt_snapshot', 'record', 'crdt_update'] as const) {
      expect((await compactOneRange(harness.db, storage, SCOPE, kind)).built).toBe(false)
    }

    expect(count('SELECT COUNT(*) AS n FROM pack_index')).toBe(PACK_LIST_MAX_PACKS_PER_VAULT)
    expect(watermarks()).toBe(0)
  })

  it('the commit batch rechecks the cap: a slot taken during the build discards the pack', async () => {
    listPacks(PACK_LIST_MAX_PACKS_PER_VAULT - 1)
    await writeUpdates('note-a', bytes(1, 1))
    passFillWait()
    const puts: string[] = []
    const put = storage.put.bind(storage)
    storage.put = (async (...args: Parameters<R2Bucket['put']>) => {
      puts.push(args[0])
      // A concurrent build takes the last slot after the precheck.
      listPack('concurrent', 1_000_000)
      return put(...args)
    }) as typeof storage.put

    const result = await compactOneRange(harness.db, storage, SCOPE, 'crdt_update')

    expect(result.built).toBe(false)
    expect(puts).toHaveLength(1)
    expect(await storage.get(puts[0])).toBeNull()
    expect(count('SELECT COUNT(*) AS n FROM pack_index')).toBe(PACK_LIST_MAX_PACKS_PER_VAULT)
    expect(watermarks()).toBe(0)
  })
})

describe('floor on the update routes (#5228, protocol 07 §7.11)', () => {
  it('is 0 for a document never purged, on both forms', async () => {
    const app = buildApp()
    await writeUpdates('note-a', bytes(1, 1))

    const single = await request<{ floor: number }>(
      app,
      '/sync/crdt/updates?note_id=note-a&since=0'
    )
    const batch = await batchAnswer(app, ['note-a', 'note-never-written'])

    expect(single.floor).toBe(0)
    expect(batch.notes['note-a'].floor).toBe(0)
    expect(batch.notes['note-never-written'].floor).toBe(0)
  })

  it('is the highest purged sequence number after a delete and re-create', async () => {
    const app = buildApp()
    await pushJournal(app, { [DEVICE_ID]: 1 })
    await writeUpdates('j2026-05-01', bytes(1, 1), bytes(1, 2), bytes(1, 3))
    await pushJournal(app, { [DEVICE_ID]: 2 }, true)
    await pushJournal(app, { [DEVICE_ID]: 3 })
    await writeUpdates('j2026-05-01', bytes(2, 1))

    const single = await request<{ floor: number; updates: Array<{ sequenceNum: number }> }>(
      app,
      '/sync/crdt/updates?note_id=j2026-05-01&since=0'
    )
    const batch = await batchAnswer(app, ['j2026-05-01'])

    expect(single.floor).toBe(3)
    expect(single.updates.map((u) => u.sequenceNum)).toEqual([4])
    expect(batch.notes['j2026-05-01'].floor).toBe(3)
  })
})

describe('the purge drops crdt_update packs (#5228, protocol 08 §8.4.3)', () => {
  it('drops every update pack and resets the watermark when it deletes only update rows', async () => {
    const app = buildApp()
    await pushJournal(app, { [DEVICE_ID]: 1 })
    await writeUpdates('j2026-05-01', bytes(1, 1), bytes(1, 2))
    await writeUpdates('note-live', bytes(5, 1))
    await compactAll()
    const [{ pack_key: packKey }] = harness.raw
      .prepare(`SELECT pack_key FROM pack_index WHERE item_kind = 'crdt_update'`)
      .all() as Array<{ pack_key: string }>

    await pushJournal(app, { [DEVICE_ID]: 2 }, true)

    expect(updatePackCount()).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM pack_watermarks WHERE item_kind = 'crdt_update'`)).toBe(
      0
    )
    expect(await storage.get(packKey)).toBeNull()

    // The reset lets compaction pack the live note again, without the dead one.
    await compactAll()
    const ids = (await downloadPacks(app)).flatMap((pack) =>
      pack.entries.filter((entry) => entry.kind === 'crdt_update').map((entry) => entry.id)
    )
    expect(ids).toEqual(['note-live'])
  })

  // REVIEW-5260 P1: the drop was keyed on surviving update rows, and a
  // snapshot that claimed the packed updates had already pruned them.
  it('drops the update packs of a document whose update rows a snapshot pruned', async () => {
    const app = buildApp()
    const dayId = 'j2026-05-01'
    await pushJournal(app, { [DEVICE_ID]: 1 })
    const written = await writeUpdates(dayId, bytes(1, 1), bytes(1, 2), bytes(1, 3))
    await writeUpdates('note-live', bytes(5, 1))
    await compactAll()
    await writeSnapshot(dayId, bytes(9, 1), written.cursor)
    expect(count(`SELECT COUNT(*) AS n FROM crdt_updates WHERE note_id = '${dayId}'`)).toBe(0)

    await pushJournal(app, { [DEVICE_ID]: 2 }, true)

    const held = (await downloadPacks(app)).filter((pack) =>
      pack.entries.some((entry) => entry.kind === 'crdt_update' && entry.id === dayId)
    )
    expect(held).toHaveLength(0)
  })

  // REVIEW-5260 P4: a rebuild between the purge commit and its object delete
  // reused the dropped pack's key, and the delete removed the listed rebuild.
  it('the purge object delete never removes a pack rebuilt in the meantime', async () => {
    const app = buildApp()
    const dayId = 'j2026-05-01'
    await pushJournal(app, { [DEVICE_ID]: 1 })
    await writeUpdates('note-a', bytes(5, 1))
    await writeUpdates(dayId, bytes(1, 1))
    await writeUpdates('note-b', bytes(6, 1))
    await compactAll()
    const del = storage.delete.bind(storage)
    let raced = false
    storage.delete = async (keys: string | string[]) => {
      if (!raced && [keys].flat().some((key) => key.includes('/packs/crdt_update/'))) {
        raced = true
        await compactAll()
      }
      return del(keys)
    }

    await pushJournal(app, { [DEVICE_ID]: 2 }, true)

    expect(raced).toBe(true)
    const listed = harness.raw
      .prepare(`SELECT pack_key FROM pack_index WHERE item_kind = 'crdt_update'`)
      .all() as Array<{ pack_key: string }>
    expect(listed).toHaveLength(1)
    expect(await storage.get(listed[0].pack_key)).not.toBeNull()
  })

  // VERIFY-5260 V4: a row written before per-build keys keeps its
  // `<min>_<max>.pack` key; the gate, the listing and the purge all take it as is.
  it('a pack under the old range-only key is gated, listed and purged', async () => {
    const app = buildApp()
    await pushJournal(app, { [DEVICE_ID]: 1 })
    const { cursor } = await writeUpdates('j2026-05-01', bytes(1, 1), bytes(1, 2))
    const oldKey = `${USER_ID}/vaults/${VAULT_ID}/packs/crdt_update/${cursor! - 1}_${cursor}.pack`
    await storage.put(oldKey, new Uint8Array([1]))
    harness.raw
      .prepare(
        `INSERT INTO pack_index (id, user_id, vault_id, pack_key, item_kind, min_cursor, max_cursor, item_count, byte_size, created_at)
         VALUES ('old', ?, ?, ?, 'crdt_update', ?, ?, 2, 1, ?)`
      )
      .run(USER_ID, VAULT_ID, oldKey, cursor! - 1, cursor, now())
    passFillWait()

    expect((await compactOneRange(harness.db, storage, SCOPE, 'crdt_update')).packKey).toBe(oldKey)
    expect(updatePackCount()).toBe(1)
    const page = await request<PackListResponse>(app, '/sync/packs')
    expect(page.packs.map((pack) => pack.packKey)).toContain(oldKey)

    await pushJournal(app, { [DEVICE_ID]: 2 }, true)

    expect(updatePackCount()).toBe(0)
    expect(await storage.get(oldKey)).toBeNull()
  })

  it('leaves update packs alone when the purge deletes no update row', async () => {
    const app = buildApp()
    await writeUpdates('note-live', bytes(5, 1))
    await compactAll()
    await pushJournal(app, { [DEVICE_ID]: 1 })

    await pushJournal(app, { [DEVICE_ID]: 2 }, true)

    expect(updatePackCount()).toBe(1)
  })

  it('a compaction run racing the purge publishes no pack with the deleted updates', async () => {
    const app = buildApp()
    await pushJournal(app, { [DEVICE_ID]: 1 })
    await writeUpdates('j2026-05-01', bytes(1, 1))
    await writeUpdates('note-live', bytes(5, 1))

    const prepare = harness.db.prepare.bind(harness.db)
    let raced = false
    // The purge commits after the build read the update bytes, before its commit.
    vi.spyOn(harness.db, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql)
      if (!sql.includes('SELECT server_cursor, update_data')) return statement
      const bind = statement.bind.bind(statement)
      statement.bind = (...values: unknown[]) => {
        const bound = bind(...values)
        const all = bound.all.bind(bound)
        bound.all = (async () => {
          const result = await all()
          if (!raced) {
            raced = true
            await pushJournal(app, { [DEVICE_ID]: 2 }, true)
          }
          return result
        }) as typeof bound.all
        return bound
      }
      return statement
    })

    passFillWait()
    const racing = await compactOneRange(harness.db, storage, SCOPE, 'crdt_update')
    vi.mocked(harness.db.prepare).mockRestore()

    expect(raced).toBe(true)
    expect(racing.built).toBe(false)
    expect(updatePackCount()).toBe(0)
    expect(racing.packKey && (await storage.get(racing.packKey))).toBeFalsy()

    await compactOneRange(harness.db, storage, SCOPE, 'crdt_update')
    const ids = (await downloadPacks(app)).flatMap((pack) => pack.entries.map((entry) => entry.id))
    expect(ids).toEqual(['note-live'])
  })
})
