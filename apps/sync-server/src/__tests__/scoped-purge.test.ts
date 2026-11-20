import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { b64Of, bodyFromPacks, type BatchAnswer, type Downloaded } from './pack-body-reader'
import { encodeSignaturePayload } from '../lib/cbor'
import { errorHandler } from '../lib/errors'
import { storeUpdatesWithCursor } from '../services/crdt'
import { storeSnapshot } from '../services/crdt-snapshot-write'
import { compactOneRange, compactVault } from '../services/pack-compaction'
import { parsePack } from '../services/pack-format'
import {
  PACK_PURGE_RETRY_DELAY_SECONDS,
  deleteReplacedPackObjects
} from '../services/pack-replaced-objects'
import { PACK_SETTLE_SECONDS } from '../services/pack-sizing'
import type { AppContext, Bindings } from '../types'
import {
  PACK_PURGE_DEADLINE_SECONDS,
  PACK_REPLACED_GRACE_SECONDS,
  type PackListResponse,
  type RecordSyncItemType
} from '@memry/contracts/sync-api'

/**
 * The scoped purge (#5229, protocol 08 §8.13): deleting one document rewrites
 * only the body packs that hold it. Real routes, services, SQL, migrations and
 * pack format over an in-memory R2; only auth is stubbed.
 */

const USER_ID = 'user-scoped-purge'
const DEVICE_ID = 'device-scoped-purge'
const VAULT_ID = 'default'
const SCOPE = { userId: USER_ID, vaultId: VAULT_ID }
const DAY = 'j2026-05-01'
// The deleted day's ciphertext: no other body holds these bytes.
const DAY_UPDATE = [0xd1, 0xd2, 0xd3, 0xd4, 0xd5]
const DAY_SNAPSHOT = [0xe1, 0xe2, 0xe3, 0xe4, 0xe5]

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
       VALUES (?, 'scoped-purge@example.com', 1, 'otp', 0, 0, ?, ?)`
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
      `INSERT INTO sync_vaults (id, user_id, vault_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run('vault-row', USER_ID, VAULT_ID, now(), now())
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, 'Scoped purge desktop', 'desktop', '1.0.0', ?, ?, ?)`
    )
    .run(DEVICE_ID, USER_ID, publicKey, now(), now())
}

const buildApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/sync', sync)
  return app
}
type App = ReturnType<typeof buildApp>

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
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined
    } as unknown as ExecutionContext
  )
  expect(res.status).toBe(200)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test reader of a route whose shape the assertions below check
  return (await res.json()) as T
}

interface PushSpec {
  id: string
  type: RecordSyncItemType
  clock: Record<string, number>
  deleted?: boolean
}

const signed = async ({ id, type, clock, deleted }: PushSpec) => {
  const base = {
    id,
    type,
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
  return { ...wire, clock, signature, signerDeviceId: DEVICE_ID }
}

/** One push of `specs`; every item must be accepted. */
const push = async (app: App, ...specs: PushSpec[]): Promise<void> => {
  const { accepted } = await request<{ accepted: string[] }>(app, '/sync/push', {
    items: await Promise.all(specs.map(signed))
  })
  expect(accepted).toEqual(specs.map((spec) => spec.id))
}
const createDoc = (app: App, id: string, tick = 1) =>
  push(app, { id, type: id === DAY ? 'journal' : 'note', clock: { [DEVICE_ID]: tick } })
const deleteSpec = (id: string, tick = 2): PushSpec => ({
  id,
  type: id === DAY ? 'journal' : 'note',
  clock: { [DEVICE_ID]: tick },
  deleted: true
})

const writeBody = async (noteId: string, update: number[], snapshot?: number[]) => {
  await storeUpdatesWithCursor(harness.db, USER_ID, VAULT_ID, noteId, DEVICE_ID, [bytes(...update)])
  if (snapshot) {
    await storeSnapshot(
      harness.db,
      storage,
      USER_ID,
      VAULT_ID,
      noteId,
      DEVICE_ID,
      bytes(...snapshot)
    )
  }
}

/** Builds every kind until nothing is left above the watermarks, past the minimum fill. */
const compactAll = async (): Promise<void> => {
  vi.setSystemTime(Date.now() + (PACK_SETTLE_SECONDS + 1) * 1000)
  for (let run = 0; run < 20; run++) {
    const results = [
      ...(await compactVault(harness.db, storage, SCOPE)),
      await compactOneRange(harness.db, storage, SCOPE, 'crdt_update')
    ]
    if (!results.some((result) => result.built)) return
  }
  throw new Error('compaction did not drain')
}

const listing = async (app: App): Promise<PackListResponse['packs']> =>
  (await request<PackListResponse>(app, '/sync/packs?limit=50')).packs

/** Downloads `summaries` as a reader does; a pack that answers 404 is a gap. */
const download = async (summaries: PackListResponse['packs']): Promise<Downloaded[]> => {
  const out: Downloaded[] = []
  for (const summary of summaries) {
    const object = await storage.get(summary.packKey)
    if (!object) continue
    const packBytes = new Uint8Array(await object.arrayBuffer())
    out.push({ summary, bytes: packBytes, entries: (await parsePack(packBytes)).entries })
  }
  return out
}

const contains = (haystack: Uint8Array, needle: readonly number[]): boolean =>
  haystack.some((_, i) => needle.every((byte, j) => haystack[i + j] === byte))

/** Every pack object in R2, listed or not, that still holds `needle`. */
const objectsHolding = async (needle: readonly number[]): Promise<string[]> => {
  const { objects } = await storage.list({ prefix: `${USER_ID}/vaults/${VAULT_ID}/packs/` })
  const found: string[] = []
  for (const { key } of objects) {
    const object = await storage.get(key)
    if (object && contains(new Uint8Array(await object.arrayBuffer()), needle)) found.push(key)
  }
  return found
}

const bodyPacks = (): Array<{ id: string; pack_key: string; item_kind: string }> =>
  harness.raw
    .prepare(
      `SELECT id, pack_key, item_kind FROM pack_index
       WHERE item_kind IN ('crdt_update', 'crdt_snapshot') ORDER BY item_kind, min_cursor`
    )
    .all() as Array<{ id: string; pack_key: string; item_kind: string }>

const batchAnswer = (app: App, noteIds: string[]) =>
  request<BatchAnswer>(app, '/sync/crdt/updates/batch', {
    notes: noteIds.map((noteId) => ({ noteId, since: 0 })),
    limit: 100
  })

/** The body through GET /sync/crdt/snapshot/:noteId plus GET /sync/crdt/updates. */
const bodyFromRoutes = async (app: App, noteId: string): Promise<string[]> => {
  const snapshot = await request<{ snapshot: string | null; sequenceNum: number }>(
    app,
    `/sync/crdt/snapshot/${noteId}`
  )
  const updates = await request<{ updates: Array<{ data: string }> }>(
    app,
    `/sync/crdt/updates?note_id=${noteId}&since=${snapshot.sequenceNum}&limit=500`
  )
  return [...(snapshot.snapshot ? [snapshot.snapshot] : []), ...updates.updates.map((u) => u.data)]
}

/**
 * Three rounds, each built into its own update and snapshot pack: note-a, then
 * the day with note-b, then note-c.
 */
const threeRounds = async (app: App): Promise<void> => {
  for (const id of ['note-a', DAY, 'note-b', 'note-c']) await createDoc(app, id)
  await writeBody('note-a', [0xa1], [0xa9])
  await compactAll()
  await writeBody(DAY, DAY_UPDATE, DAY_SNAPSHOT)
  await writeBody('note-b', [0xb1], [0xb9])
  await compactAll()
  await writeBody('note-c', [0xc1], [0xc9])
  await compactAll()
}

const holdsDay = async (key: string): Promise<boolean> => {
  const [pack] = await download([{ packKey: key } as PackListResponse['packs'][number]])
  return pack.entries.some((entry) => entry.id === DAY)
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

describe('the scoped purge (#5229, protocol 08 §8.13)', () => {
  it('deleting one document leaves other packs untouched and its ciphertext in no pack object', async () => {
    const app = buildApp()
    await threeRounds(app)
    const before = bodyPacks()
    expect(before).toHaveLength(6)
    const holding = new Set<string>()
    for (const pack of before) if (await holdsDay(pack.pack_key)) holding.add(pack.id)
    expect(holding.size).toBe(2)
    const deletedAt = now()

    await push(app, deleteSpec(DAY))

    const after = bodyPacks()
    // Every pack that did not hold the day keeps its row and object.
    expect(after.filter((pack) => before.some((old) => old.id === pack.id))).toEqual(
      before.filter((pack) => !holding.has(pack.id))
    )
    // The two that did are rewritten: new rows, note-b kept, the day gone.
    const rewritten = after.filter((pack) => !before.some((old) => old.id === pack.id))
    expect(rewritten.map((pack) => pack.item_kind)).toEqual(['crdt_snapshot', 'crdt_update'])
    const listed = await download(await listing(app))
    expect(listed.flatMap((pack) => pack.entries).some((entry) => entry.id === DAY)).toBe(false)
    expect(
      listed.flatMap((pack) => pack.entries.filter((entry) => entry.id === 'note-b')).length
    ).toBe(2)
    // Within the deadline, no object at all holds the day's bytes.
    expect(now() - deletedAt).toBeLessThanOrEqual(PACK_PURGE_DEADLINE_SECONDS)
    expect(await objectsHolding(DAY_UPDATE)).toEqual([])
    expect(await objectsHolding(DAY_SNAPSHOT)).toEqual([])
    expect(harness.raw.prepare('SELECT COUNT(*) AS n FROM pack_replaced_objects').get()).toEqual({
      n: 0
    })
    // Nothing is left to retry, so no delayed message is asked for.
    expect(send.mock.calls.filter(([, options]) => options?.delaySeconds)).toEqual([])
  })

  it('a client that listed packs before the rewrite still completes its bootstrap', async () => {
    const app = buildApp()
    await threeRounds(app)
    const listedBefore = await listing(app)

    await push(app, deleteSpec(DAY))

    // The client downloads what it listed: the rewritten packs answer 404.
    const packs = await download(listedBefore)
    expect(packs).toHaveLength(listedBefore.length - 2)
    const live = ['note-a', 'note-b', 'note-c']
    const answer = await batchAnswer(app, live)
    for (const noteId of live) {
      const fromRoutes = await bodyFromRoutes(app, noteId)
      expect(fromRoutes.length).toBeGreaterThan(0)
      // A note whose pack is gone is a gap the item routes fill.
      const body = bodyFromPacks(packs, noteId, answer) ?? fromRoutes
      expect({ noteId, body }).toEqual({ noteId, body: fromRoutes })
    }
    expect(bodyFromPacks(packs, 'note-b', answer)).toBeNull()
    expect(await bodyFromRoutes(app, DAY)).toEqual([])
  })

  // #2986, the regression document-body-purge.ts exists for, over scoped packs.
  it('a deleted and re-created document bootstraps a fresh device with only its new body', async () => {
    const app = buildApp()
    await threeRounds(app)
    await push(app, deleteSpec(DAY))
    await createDoc(app, DAY, 3)
    await writeBody(DAY, [0x21])
    await compactAll()

    const packs = await download(await listing(app))
    const answer = await batchAnswer(app, [DAY])

    expect(await bodyFromRoutes(app, DAY)).toEqual([b64Of(new Uint8Array([0x21]))])
    expect(bodyFromPacks(packs, DAY, answer)).toEqual(await bodyFromRoutes(app, DAY))
    expect(await objectsHolding(DAY_UPDATE)).toEqual([])
    expect(await objectsHolding(DAY_SNAPSHOT)).toEqual([])
  })

  it('a bulk delete rewrites a pack holding two of its documents once', async () => {
    const app = buildApp()
    await threeRounds(app)
    const before = bodyPacks()

    await push(app, deleteSpec(DAY), deleteSpec('note-b'))

    const added = bodyPacks().filter((pack) => !before.some((old) => old.id === pack.id))
    // The shared packs held nothing else, so both go and none replaces them.
    expect(added).toEqual([])
    expect(bodyPacks()).toHaveLength(4)
    expect(await objectsHolding(DAY_UPDATE)).toEqual([])
  })

  it('more rewrites than one pass finish from the delayed message inside the deadline', async () => {
    const app = buildApp()
    await createDoc(app, DAY)
    for (let round = 0; round < 5; round++) {
      await writeBody(DAY, [...DAY_UPDATE, round])
      await writeBody(`note-${round}`, [0x30 + round])
      await compactAll()
    }
    expect(bodyPacks()).toHaveLength(5)

    await push(app, deleteSpec(DAY))

    expect(send).toHaveBeenCalledWith(expect.anything(), {
      delaySeconds: PACK_PURGE_RETRY_DELAY_SECONDS
    })
    expect(await objectsHolding(DAY_UPDATE)).toHaveLength(1)
    // The delayed message rewrites before its deletion pass reaches the grace.
    vi.setSystemTime(Date.now() + PACK_PURGE_RETRY_DELAY_SECONDS * 1000)
    await compactVault(harness.db, storage, SCOPE)
    expect(await objectsHolding(DAY_UPDATE)).toEqual([])
    expect(bodyPacks()).toHaveLength(5)
  })

  it('a deletion pass that reaches a rewrite still pending resets its kind instead of leaving a gap', async () => {
    const app = buildApp()
    await createDoc(app, DAY)
    for (let round = 0; round < 5; round++) {
      await writeBody(DAY, [...DAY_UPDATE, round])
      await writeBody(`note-${round}`, [0x30 + round])
      await compactAll()
    }
    await push(app, deleteSpec(DAY))
    expect(await objectsHolding(DAY_UPDATE)).toHaveLength(1)

    // The delayed message never ran; the cron's vault-wide pass finds the
    // pending object past its grace.
    vi.setSystemTime(Date.now() + (PACK_REPLACED_GRACE_SECONDS + 1) * 1000)
    await deleteReplacedPackObjects(harness.db, storage)
    await deleteReplacedPackObjects(harness.db, storage)

    expect(await objectsHolding(DAY_UPDATE)).toEqual([])
    await compactAll()
    const updates = (await download(await listing(app)))
      .flatMap((pack) => pack.entries)
      .filter((entry) => entry.kind === 'crdt_update')
      .map((entry) => entry.id)
    expect(updates.toSorted()).toEqual(['note-0', 'note-1', 'note-2', 'note-3', 'note-4'])
  })

  it('a pack that cannot be rewritten resets its kind, and the rebuild leaves the document out', async () => {
    const app = buildApp()
    await threeRounds(app)
    const before = bodyPacks()
    const [lost] = before.filter((pack) => pack.item_kind === 'crdt_snapshot').slice(1, 2)
    await storage.delete(lost.pack_key)

    await push(app, deleteSpec(DAY))

    expect(bodyPacks().filter((pack) => pack.item_kind === 'crdt_snapshot')).toEqual([])
    const watermarks = harness.raw
      .prepare('SELECT item_kind FROM pack_watermarks ORDER BY item_kind')
      .pluck()
      .all()
    expect(watermarks).not.toContain('crdt_snapshot')
    // The update kind stays scoped.
    expect(
      bodyPacks()
        .filter((pack) => before.some((old) => old.id === pack.id))
        .map((p) => p.id)
    ).toEqual(
      before
        .filter((p) => p.item_kind === 'crdt_update')
        .map((p) => p.id)
        .toSpliced(1, 1)
    )

    await compactAll()
    const ids = (await download(await listing(app)))
      .flatMap((pack) => pack.entries)
      .filter((entry) => entry.kind === 'crdt_snapshot')
      .map((entry) => entry.id)
    expect(ids.toSorted()).toEqual(['note-a', 'note-b', 'note-c'])
    expect(await objectsHolding(DAY_SNAPSHOT)).toEqual([])
  })
})
