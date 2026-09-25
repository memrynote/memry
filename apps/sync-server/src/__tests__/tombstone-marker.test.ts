import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { encodeSignaturePayload } from '../lib/cbor'
import { errorHandler } from '../lib/errors'
import { cleanupExpiredTombstones } from '../services/cleanup'
import type { AppContext, Bindings } from '../types'
import {
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES,
  type RecordSyncItemType
} from '@memry/contracts/sync-api'

/**
 * #2302: a tombstone past `version_history_days` sheds its payload but keeps
 * its row, so a device offline past retention cannot resurrect the item, and
 * a live row whose blob is lost is reported instead of silently dropped. Real
 * routes, services, SQL and schema; only auth is stubbed.
 */

const USER_ID = 'user-marker'
const DEVICE_ID = 'device-marker'
const VAULT_ID = 'default'
const DAY = 86_400

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
    .run(USER_ID, 'marker@example.com', now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024, now())
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, 'Marker desktop', 'desktop', '1.0.0', ?, ?, ?)`
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

const request = (app: App, path: string, init: RequestInit = {}) =>
  app.request(
    path,
    {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) }
    },
    env as unknown as Record<string, unknown>,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined
    } as unknown as ExecutionContext
  )

interface PushBody {
  accepted: string[]
  rejected: Array<{ id: string; reason: string }>
}

const push = async (app: App, specs: PushSpec[]): Promise<{ status: number; body: PushBody }> => {
  const items = await Promise.all(specs.map(signedItem))
  const res = await request(app, '/sync/push', { method: 'POST', body: JSON.stringify({ items }) })
  return { status: res.status, body: (await res.json()) as PushBody }
}

interface PullBody {
  items: Array<{ id: string; type: string; deletedAt?: number }>
  purgedTombstones?: unknown[]
  blobMissing?: unknown[]
}

// A current desktop: every record type plus the #2302 capability token.
const DECLARING = {
  'X-Memry-Sync-Types': [...RECORD_SYNC_ITEM_TYPES, 'purged_tombstones'].join(',')
}

const pull = async (app: App, itemIds: string[], headers: Record<string, string> = DECLARING) => {
  const res = await request(app, '/sync/pull', {
    method: 'POST',
    headers,
    body: JSON.stringify({ itemIds })
  })
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as PullBody }
}

interface SyncItemRow {
  id: string
  item_id: string
  blob_key: string
  content_hash: string
  signature: string
  size_bytes: number
  clock: string | null
  deleted_at: number | null
  server_cursor: number
  payload_purged_at: number | null
  blob_missing_at: number | null
}

const row = (itemId: string): SyncItemRow =>
  harness.raw
    .prepare(
      `SELECT id, item_id, blob_key, content_hash, signature, size_bytes, clock, deleted_at,
              server_cursor, payload_purged_at, blob_missing_at
       FROM sync_items WHERE user_id = ? AND item_id = ?`
    )
    .get(USER_ID, itemId) as SyncItemRow

const rowCount = (): number =>
  (harness.raw.prepare('SELECT COUNT(*) AS n FROM sync_items').get() as { n: number }).n

const storageUsed = (): number =>
  (
    harness.raw.prepare('SELECT storage_used FROM users WHERE id = ?').get(USER_ID) as {
      storage_used: number
    }
  ).storage_used

const backdateDelete = (itemId: string, deletedAt: number): void => {
  harness.raw
    .prepare('UPDATE sync_items SET deleted_at = ? WHERE user_id = ? AND item_id = ?')
    .run(deletedAt, USER_ID, itemId)
}

/** Task T created at {d:1}, deleted at {d:2}, the delete backdated past the 30-day window. */
const expiredTombstone = async (
  app: App,
  itemId = 'task-t',
  type: RecordSyncItemType = 'task'
): Promise<SyncItemRow> => {
  expect(
    (await push(app, [{ id: itemId, type, operation: 'create', clock: { [DEVICE_ID]: 1 } }])).body
      .accepted
  ).toEqual([itemId])
  expect(
    (await push(app, [{ id: itemId, type, clock: { [DEVICE_ID]: 2 }, deletedAt: now() }])).body
      .accepted
  ).toEqual([itemId])
  backdateDelete(itemId, now() - 31 * DAY)
  return row(itemId)
}

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

describe('cleanupExpiredTombstones sheds the payload and keeps the row (#2302)', () => {
  // #2302
  it('turns an expired tombstone into a marker: blob gone, delete fact kept, bytes refunded', async () => {
    const app = buildApp()
    const before = await expiredTombstone(app)
    const usedBefore = storageUsed()
    expect(await storage.head(before.blob_key)).not.toBeNull()

    const shed = await cleanupExpiredTombstones(harness.db, storage)

    expect(shed).toBe(1)
    const after = row('task-t')
    expect(after).toMatchObject({
      id: before.id,
      blob_key: '',
      content_hash: '',
      signature: '',
      size_bytes: 0,
      clock: before.clock,
      deleted_at: before.deleted_at,
      server_cursor: before.server_cursor,
      blob_missing_at: null
    })
    expect(after.payload_purged_at).toEqual(expect.any(Number))
    expect(await storage.head(before.blob_key)).toBeNull()
    expect(storageUsed()).toBe(usedBefore - before.size_bytes)
  })

  // #2302
  it('never deletes a sync_items row, and a second run is a no-op that refunds nothing', async () => {
    const app = buildApp()
    await expiredTombstone(app)
    const count = rowCount()

    await cleanupExpiredTombstones(harness.db, storage)
    const usedAfterFirst = storageUsed()
    const second = await cleanupExpiredTombstones(harness.db, storage)

    expect(second).toBe(0)
    expect(rowCount()).toBe(count)
    expect(storageUsed()).toBe(usedAfterFirst)
  })

  // #2302: a lapsed plan (no entitlement row) means a 0-day window.
  it('sheds on the next tick for a user with no entitlement, and still deletes no row', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 1 } }])
    await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 2 }, deletedAt: now() - 60 }])
    backdateDelete('task-t', now() - 60)
    harness.raw.prepare('DELETE FROM sync_entitlements WHERE user_id = ?').run(USER_ID)
    const count = rowCount()

    expect(await cleanupExpiredTombstones(harness.db, storage)).toBe(1)

    expect(rowCount()).toBe(count)
    expect(row('task-t').payload_purged_at).toEqual(expect.any(Number))
  })

  // #2302
  it('leaves a tombstone inside the retention window signed and untouched', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 1 } }])
    await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 2 }, deletedAt: now() }])
    const before = row('task-t')

    expect(await cleanupExpiredTombstones(harness.db, storage)).toBe(0)

    expect(row('task-t')).toEqual(before)
  })

  // #2302 review: a marker never lands in front of an object that is still stored.
  it('leaves the row unshed when the object delete fails, and sheds it on the next tick', async () => {
    const app = buildApp()
    const before = await expiredTombstone(app)
    const usedBefore = storageUsed()
    const deleteSpy = vi
      .spyOn(storage, 'delete')
      .mockRejectedValueOnce(new Error('Too many subrequests'))

    expect(await cleanupExpiredTombstones(harness.db, storage)).toBe(0)
    expect(row('task-t')).toMatchObject({ blob_key: before.blob_key, payload_purged_at: null })
    expect(storageUsed()).toBe(usedBefore)
    expect(await storage.head(before.blob_key)).not.toBeNull()

    expect(await cleanupExpiredTombstones(harness.db, storage)).toBe(1)
    expect(row('task-t').blob_key).toBe('')
    expect(await storage.head(before.blob_key)).toBeNull()
    expect(deleteSpy).toHaveBeenCalledTimes(2)
  })

  // #2302 review: one bulk R2 delete per user, not one per row.
  it("deletes all of a user's expired objects in one bulk call", async () => {
    const app = buildApp()
    const first = await expiredTombstone(app, 'task-a')
    const second = await expiredTombstone(app, 'task-b')
    const deleteSpy = vi.spyOn(storage, 'delete')

    expect(await cleanupExpiredTombstones(harness.db, storage)).toBe(2)

    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.arrayContaining([first.blob_key, second.blob_key])
    )
  })

  // #2302 review (A-F6): a rollback worker can re-delete over a marker without
  // clearing payload_purged_at. The row holds a payload again, so it is shed again.
  it('sheds a re-deleted row that carries a stale payload_purged_at', async () => {
    const app = buildApp()
    await expiredTombstone(app)
    harness.raw
      .prepare('UPDATE sync_items SET payload_purged_at = 5 WHERE item_id = ?')
      .run('task-t')

    expect(await cleanupExpiredTombstones(harness.db, storage)).toBe(1)
    expect(row('task-t').blob_key).toBe('')
  })

  // #2302: a push that re-creates (or re-deletes) the item between the select and
  // the mark moves server_cursor, so the guarded UPDATEs skip the row.
  it('skips a row written between its select and its mark: stays live, no refund', async () => {
    const app = buildApp()
    const before = await expiredTombstone(app)
    const originalDelete = storage.delete.bind(storage)
    vi.spyOn(storage, 'delete').mockImplementation(async (key) => {
      harness.raw
        .prepare(
          'UPDATE sync_items SET deleted_at = NULL, server_cursor = server_cursor + 100 WHERE id = ?'
        )
        .run(before.id)
      return originalDelete(key)
    })
    const usedBefore = storageUsed()

    expect(await cleanupExpiredTombstones(harness.db, storage)).toBe(0)

    expect(row('task-t')).toMatchObject({
      deleted_at: null,
      payload_purged_at: null,
      signature: before.signature,
      size_bytes: before.size_bytes
    })
    expect(storageUsed()).toBe(usedBefore)
  })
})

describe('a marker keeps refusing resurrection (#2302)', () => {
  // #2302 acceptance: a device offline past retention pushes an update to a purged item.
  it('refuses a concurrent update with SYNC_DELETE_WINS per item, HTTP 200, neighbours accepted', async () => {
    const app = buildApp()
    const marker = await expiredTombstone(app)
    await cleanupExpiredTombstones(harness.db, storage)

    // Device B edited T at {d:1, b:1} before it ever saw the delete at {d:2}.
    const res = await push(app, [
      { id: 'task-t', clock: { [DEVICE_ID]: 1, 'device-b': 1 } },
      { id: 'task-new', clock: { 'device-b': 1 } }
    ])

    expect(res.status).toBe(200)
    expect(res.body.accepted).toEqual(['task-new'])
    expect(res.body.rejected).toEqual([{ id: 'task-t', reason: 'SYNC_DELETE_WINS' }])
    expect(row('task-t')).toMatchObject({
      blob_key: '',
      deleted_at: marker.deleted_at,
      clock: marker.clock,
      server_cursor: marker.server_cursor
    })
    const manifest = (await (await request(app, '/sync/manifest')).json()) as {
      items: Array<{ id: string }>
    }
    expect(manifest.items.map((item) => item.id)).toEqual(['task-new'])
  })

  // #2302
  it('refuses an unchanged old clock as SYNC_REPLAY_DETECTED', async () => {
    const app = buildApp()
    await expiredTombstone(app)
    await cleanupExpiredTombstones(harness.db, storage)

    const res = await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 1 } }])

    expect(res.status).toBe(200)
    expect(res.body.rejected).toEqual([{ id: 'task-t', reason: 'SYNC_REPLAY_DETECTED' }])
    expect(row('task-t').blob_key).toBe('')
  })

  // #2302
  it('accepts a re-create whose clock happens strictly after the marker and clears both flags', async () => {
    const app = buildApp()
    await expiredTombstone(app)
    await cleanupExpiredTombstones(harness.db, storage)
    harness.raw.prepare('UPDATE sync_items SET blob_missing_at = 5 WHERE item_id = ?').run('task-t')
    const usedBefore = storageUsed()

    const res = await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 3 } }])

    expect(res.body.accepted).toEqual(['task-t'])
    const recreated = row('task-t')
    expect(recreated).toMatchObject({
      deleted_at: null,
      payload_purged_at: null,
      blob_missing_at: null
    })
    expect(recreated.size_bytes).toBeGreaterThan(0)
    expect(storageUsed()).toBe(usedBefore + recreated.size_bytes)
    const pulled = await pull(app, ['task-t'])
    expect(pulled.body.items.map((item) => item.id)).toEqual(['task-t'])
    expect(pulled.body.purgedTombstones).toBeUndefined()
  })
})

describe('POST /sync/pull serves a marker as a purgedTombstones entry (#2302)', () => {
  // #2302
  it('keeps the purged id in the changes feed and serves the delete fact without an R2 read', async () => {
    const app = buildApp()
    const marker = await expiredTombstone(app)
    await cleanupExpiredTombstones(harness.db, storage)
    const getSpy = vi.spyOn(storage, 'get')

    const changes = (await (
      await request(app, '/sync/changes?cursor=1', { headers: DECLARING })
    ).json()) as { deleted: string[] }
    const pulled = await pull(app, ['task-t'])

    expect(changes.deleted).toEqual(['task-t'])
    expect(pulled.status).toBe(200)
    expect(pulled.body).toEqual({
      items: [],
      purgedTombstones: [
        {
          id: 'task-t',
          type: 'task',
          deletedAt: marker.deleted_at,
          clock: { [DEVICE_ID]: 2 },
          serverCursor: marker.server_cursor
        }
      ]
    })
    expect(getSpy).not.toHaveBeenCalled()
  })

  // #2302: the crash window between the shed's R2 delete and its D1 mark, or a
  // lost tombstone blob. A delete does not need its bytes.
  it('serves a tombstone whose blob is gone but that is not yet marked as a purged tombstone', async () => {
    const app = buildApp()
    const tombstone = await expiredTombstone(app)
    await storage.delete(tombstone.blob_key)

    const pulled = await pull(app, ['task-t'])

    expect(pulled.status).toBe(200)
    expect(pulled.body.items).toEqual([])
    expect(pulled.body.purgedTombstones).toEqual([
      expect.objectContaining({ id: 'task-t', type: 'task', clock: { [DEVICE_ID]: 2 } })
    ])
    expect(pulled.body.blobMissing).toBeUndefined()
  })

  // #2302: a legacy tombstone stored without a clock is still reported; the client decides.
  it('omits clock on a purged tombstone stored without one', async () => {
    const app = buildApp()
    await expiredTombstone(app)
    harness.raw.prepare('UPDATE sync_items SET clock = NULL WHERE item_id = ?').run('task-t')
    await cleanupExpiredTombstones(harness.db, storage)

    const pulled = await pull(app, ['task-t'])

    expect(pulled.body.purgedTombstones).toEqual([
      {
        id: 'task-t',
        type: 'task',
        deletedAt: expect.any(Number),
        serverCursor: expect.any(Number)
      }
    ])
  })

  // #2302
  it('never inlines a marker on /sync/changes?inline=1: its id is left to /sync/pull', async () => {
    const app = buildApp()
    await expiredTombstone(app)
    await cleanupExpiredTombstones(harness.db, storage)
    await push(app, [{ id: 'task-live', clock: { [DEVICE_ID]: 1 } }])

    const page = (await (
      await request(app, '/sync/changes?cursor=1&inline=1', { headers: DECLARING })
    ).json()) as { deleted: string[]; inline: Array<{ id: string }> }

    expect(page.deleted).toEqual(['task-t'])
    expect(page.inline.map((item) => item.id)).toEqual(['task-live'])
  })
})

describe('a marker is visible only to a client that declares purged_tombstones (#2302)', () => {
  const changesDeleted = async (app: App, query: string, headers: Record<string, string>) =>
    (
      (await (await request(app, `/sync/changes?${query}`, { headers })).json()) as {
        deleted: string[]
      }
    ).deleted

  // #2302 review (A-F1, B-2): old desktops, sync-client and the Rust core see
  // exactly what a hard delete left: nothing.
  it('hides the marker from a client that does not declare the token, in the feed and in pull', async () => {
    const app = buildApp()
    await expiredTombstone(app)
    await cleanupExpiredTombstones(harness.db, storage)
    const current = { 'X-Memry-Sync-Types': RECORD_SYNC_ITEM_TYPES.join(',') }

    expect(await changesDeleted(app, 'cursor=1', current)).toEqual([])
    expect(await changesDeleted(app, 'cursor=1', {})).toEqual([])
    const pulled = await pull(app, ['task-t'], current)
    expect(pulled.text).toBe('{"items":[]}')
    expect((await pull(app, ['task-t'], {})).text).toBe('{"items":[]}')
  })

  // #2302 review: a signed tombstone inside retention is unchanged for everyone.
  it('still lists an unshed tombstone to a client that does not declare the token', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 1 } }])
    await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 2 }, deletedAt: now() }])

    expect(await changesDeleted(app, 'cursor=1', {})).toEqual(['task-t'])
  })

  // #2302 review (B-8): a fresh or reset device gains nothing from a marker.
  it('never lists a marker on a request from cursor 0, even to a declaring client', async () => {
    const app = buildApp()
    await expiredTombstone(app)
    await cleanupExpiredTombstones(harness.db, storage)

    expect(await changesDeleted(app, 'cursor=0', DECLARING)).toEqual([])
    expect(await changesDeleted(app, 'cursor=1', DECLARING)).toEqual(['task-t'])
  })

  // #2302 review: the push side refuses for every client, declared or not.
  it('refuses a stale push from a client that does not declare the token', async () => {
    const app = buildApp()
    await expiredTombstone(app)
    await cleanupExpiredTombstones(harness.db, storage)

    const res = await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 1, 'device-b': 1 } }])

    expect(res.body.rejected).toEqual([{ id: 'task-t', reason: 'SYNC_DELETE_WINS' }])
  })

  // #2302 review (A-F6): a re-deleted row with a stale payload_purged_at still
  // has its signed payload, so it is served signed, not as an unsigned marker.
  it('serves a re-deleted row with a stale payload_purged_at as a signed tombstone', async () => {
    const app = buildApp()
    await expiredTombstone(app)
    harness.raw
      .prepare('UPDATE sync_items SET payload_purged_at = 5 WHERE item_id = ?')
      .run('task-t')

    const pulled = await pull(app, ['task-t'])

    expect(pulled.body.items).toEqual([
      expect.objectContaining({ id: 'task-t', operation: 'delete' })
    ])
    expect(pulled.body.purgedTombstones).toBeUndefined()
  })
})

describe('POST /sync/pull reports a lost blob instead of dropping it (#2302)', () => {
  // #2302 acceptance: a row with a missing blob is reported, not dropped, and does not block the page.
  it('returns the page-mates in cursor order and names the lost row in blobMissing', async () => {
    const app = buildApp()
    await push(app, [
      { id: 'task-a', clock: { [DEVICE_ID]: 1 } },
      { id: 'task-b', clock: { [DEVICE_ID]: 1 } },
      { id: 'task-c', clock: { [DEVICE_ID]: 1 } }
    ])
    const lost = row('task-b')
    await storage.delete(lost.blob_key)

    const pulled = await pull(app, ['task-a', 'task-b', 'task-c'])

    expect(pulled.status).toBe(200)
    expect(pulled.body.items.map((item) => item.id)).toEqual(['task-a', 'task-c'])
    expect(pulled.body.blobMissing).toEqual([
      { id: 'task-b', type: 'task', serverCursor: lost.server_cursor }
    ])
    expect(pulled.body.purgedTombstones).toBeUndefined()
    expect(row('task-b').blob_missing_at).toEqual(expect.any(Number))
    expect(rowCount()).toBe(3)
  })

  // #2302: per-item, never a request-level failure.
  it('answers 200 for a slice that holds only a lost blob', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-b', clock: { [DEVICE_ID]: 1 } }])
    await storage.delete(row('task-b').blob_key)

    const pulled = await pull(app, ['task-b'])

    expect(pulled.status).toBe(200)
    expect(pulled.body).toEqual({
      items: [],
      blobMissing: [{ id: 'task-b', type: 'task', serverCursor: expect.any(Number) }]
    })
  })

  // #2302: the replace race Stage 8 creates is not a lost blob.
  it('drops, without marking, a row whose blob was replaced after it was read', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-b', clock: { [DEVICE_ID]: 1 } }])
    const original = row('task-b')
    const originalGet = storage.get.bind(storage)
    vi.spyOn(storage, 'get').mockImplementation(async (key: string) => {
      if (key === original.blob_key) {
        harness.raw
          .prepare('UPDATE sync_items SET blob_key = ? WHERE id = ?')
          .run(`${USER_ID}/vaults/default/items-v3/task/task-b/replacement`, original.id)
        return null
      }
      return originalGet(key)
    })

    const pulled = await pull(app, ['task-b'])

    expect(pulled.status).toBe(200)
    expect(pulled.body).toEqual({ items: [] })
    expect(row('task-b').blob_missing_at).toBeNull()
  })

  // #2302
  it('clears blob_missing_at on the next accepted push of the item', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-b', clock: { [DEVICE_ID]: 1 } }])
    await storage.delete(row('task-b').blob_key)
    await pull(app, ['task-b'])
    expect(row('task-b').blob_missing_at).toEqual(expect.any(Number))

    expect((await push(app, [{ id: 'task-b', clock: { [DEVICE_ID]: 2 } }])).body.accepted).toEqual([
      'task-b'
    ])

    expect(row('task-b').blob_missing_at).toBeNull()
    expect((await pull(app, ['task-b'])).body.items.map((item) => item.id)).toEqual(['task-b'])
  })

  // #2302 compat: a pre-#2302 client reads this route byte for byte as before.
  it('answers exactly {"items":[...]} when no row is purged or lost', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-a', clock: { [DEVICE_ID]: 1 } }])

    const pulled = await pull(app, ['task-a'])

    expect(pulled.text.startsWith('{"items":[')).toBe(true)
    expect(Object.keys(pulled.body)).toEqual(['items'])
  })
})

// #2302: ids that legitimately come back after a delete. Derived from
// user-visible data (a journal's date, a tag's name, a folder's path, a
// provider calendar or event), or carried in a user-restorable file (a note's
// frontmatter id, restored from a backup or the OS trash).
const RECREATABLE_TYPES: RecordSyncItemType[] = [
  'journal',
  'tag_definition',
  'property_definition',
  'folder_config',
  'canvas_folder',
  'bookmark',
  'calendar_source',
  'calendar_external_event',
  'calendar_binding',
  'note'
]
const RANDOM_ID_TYPES = RECORD_CLOCK_REQUIRED_ITEM_TYPES.filter(
  (type) => !RECREATABLE_TYPES.includes(type)
)

describe('a create over a marker re-creates a recreatable id, and only that (#2302)', () => {
  // #2302: a journal re-created for a date, a tag re-created by name, must reach other devices.
  it.each(RECREATABLE_TYPES)(
    '%s: a re-create after the purge is accepted and served to another device',
    async (type) => {
      const app = buildApp()
      const marker = await expiredTombstone(app, 'same-id', type)
      await cleanupExpiredTombstones(harness.db, storage)
      const usedBefore = storageUsed()

      // A fresh clock, dominated by the tombstone's {device: 2}.
      const res = await push(app, [
        { id: 'same-id', type, operation: 'create', clock: { [DEVICE_ID]: 1 } }
      ])

      expect(res.status).toBe(200)
      expect(res.body.accepted).toEqual(['same-id'])
      const recreated = row('same-id')
      expect(recreated).toMatchObject({
        deleted_at: null,
        payload_purged_at: null,
        clock: JSON.stringify({ [DEVICE_ID]: 1 })
      })
      expect(recreated.server_cursor).toBeGreaterThan(marker.server_cursor)
      expect(storageUsed()).toBe(usedBefore + recreated.size_bytes)

      // Device 2, from before the marker or from scratch: the changes feed names
      // it as a live item and /sync/pull serves the signed payload.
      // A current client declares every record type (post-negotiation types included).
      const allTypes = { 'X-Memry-Sync-Types': RECORD_SYNC_ITEM_TYPES.join(',') }
      const changes = (await (
        await request(app, '/sync/changes?cursor=0', { headers: allTypes })
      ).json()) as {
        items: Array<{ id: string; type: string }>
        deleted: string[]
      }
      expect(changes.items).toEqual([expect.objectContaining({ id: 'same-id', type })])
      expect(changes.deleted).toEqual([])
      const pulled = await pull(app, ['same-id'], allTypes)
      expect(pulled.body.items).toEqual([
        expect.objectContaining({ id: 'same-id', type, clock: { [DEVICE_ID]: 1 } })
      ])
      expect(pulled.body.purgedTombstones).toBeUndefined()
    }
  )

  // #2302: a random id never comes back legitimately, so a same-id create is a stale resurrection.
  it.each(RANDOM_ID_TYPES)('%s: a stale create over a marker is still refused', async (type) => {
    const app = buildApp()
    const marker = await expiredTombstone(app, 'stale-id', type)
    await cleanupExpiredTombstones(harness.db, storage)

    const dominated = await push(app, [
      { id: 'stale-id', type, operation: 'create', clock: { [DEVICE_ID]: 1 } }
    ])
    const concurrent = await push(app, [
      { id: 'stale-id', type, operation: 'create', clock: { [DEVICE_ID]: 1, 'device-b': 1 } }
    ])

    expect(dominated.status).toBe(200)
    expect(dominated.body.rejected).toEqual([{ id: 'stale-id', reason: 'SYNC_REPLAY_DETECTED' }])
    expect(concurrent.body.rejected).toEqual([{ id: 'stale-id', reason: 'SYNC_DELETE_WINS' }])
    expect(row('stale-id')).toMatchObject({
      blob_key: '',
      deleted_at: marker.deleted_at,
      server_cursor: marker.server_cursor
    })
  })

  // #2302: only a create re-creates; an update over a marker is a stale edit.
  it.each(RECREATABLE_TYPES)('%s: an update over a marker is still refused', async (type) => {
    const app = buildApp()
    const marker = await expiredTombstone(app, 'edited-id', type)
    await cleanupExpiredTombstones(harness.db, storage)

    const dominated = await push(app, [{ id: 'edited-id', type, clock: { [DEVICE_ID]: 1 } }])
    const concurrent = await push(app, [
      { id: 'edited-id', type, clock: { [DEVICE_ID]: 1, 'device-b': 1 } }
    ])

    expect(dominated.body.rejected).toEqual([{ id: 'edited-id', reason: 'SYNC_REPLAY_DETECTED' }])
    expect(concurrent.body.rejected).toEqual([{ id: 'edited-id', reason: 'SYNC_DELETE_WINS' }])
    expect(row('edited-id')).toMatchObject({ blob_key: '', server_cursor: marker.server_cursor })
  })

  // #2302: within retention the tombstone is not a marker yet, and nothing changes.
  it('refuses a deterministic-id create over a tombstone still inside retention', async () => {
    const app = buildApp()
    await push(app, [
      { id: 'work', type: 'tag_definition', operation: 'create', clock: { [DEVICE_ID]: 1 } }
    ])
    await push(app, [
      { id: 'work', type: 'tag_definition', clock: { [DEVICE_ID]: 2 }, deletedAt: now() }
    ])

    const res = await push(app, [
      { id: 'work', type: 'tag_definition', operation: 'create', clock: { [DEVICE_ID]: 1 } }
    ])

    expect(res.body.rejected).toEqual([{ id: 'work', reason: 'SYNC_REPLAY_DETECTED' }])
    expect(row('work').deleted_at).toEqual(expect.any(Number))
  })

  // #2302 rollback residue: a live row carrying a stale payload_purged_at is not a marker.
  it('keeps replay detection for a create over a live row with a stale payload_purged_at', async () => {
    const app = buildApp()
    await push(app, [
      { id: 'j2026-01-01', type: 'journal', operation: 'create', clock: { [DEVICE_ID]: 3 } }
    ])
    harness.raw
      .prepare('UPDATE sync_items SET payload_purged_at = 5 WHERE item_id = ?')
      .run('j2026-01-01')

    const res = await push(app, [
      { id: 'j2026-01-01', type: 'journal', operation: 'create', clock: { [DEVICE_ID]: 1 } }
    ])

    expect(res.body.rejected).toEqual([{ id: 'j2026-01-01', reason: 'SYNC_REPLAY_DETECTED' }])
  })
})
