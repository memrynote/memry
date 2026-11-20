import {
  PACK_REPLACED_GRACE_SECONDS,
  PACK_LIST_MAX_PACKS_PER_VAULT
} from '@memry/contracts/sync-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { PACK_ORPHAN_MIN_AGE_MS, cleanupOrphanedPackObjects } from './cleanup'
import { runPackBackfill } from './pack-backfill'
import { compactOneRange, compactVault } from './pack-compaction'
import { packSha256, parsePack, type PackKindName } from './pack-format'
import { listPacks } from './pack-list'
import { deleteReplacedPackObjects, rollupKind } from './pack-rollup'
import { PACK_SETTLE_SECONDS, packCountBound } from './pack-sizing'

/**
 * Rollup, minimum fill and the replaced-object grace (#5229, protocol 08
 * §8.12, §8.14) against the real migrations, SQL and pack format over an
 * in-memory R2.
 */

const USER = 'user-rollup'
const VAULT = 'default'
const SCOPE = { userId: USER, vaultId: VAULT }

let harness: SqliteD1
let storage: R2Bucket

const now = () => Math.floor(Date.now() / 1000)
const advance = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000)
const settled = () => now() - PACK_SETTLE_SECONDS - 1

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** A record row as a push leaves it: payload in R2, hash and meta in D1. */
const writeRecord = async (cursor: number, id = `task-${cursor}`, at = now()): Promise<void> => {
  const bytes = new TextEncoder().encode(JSON.stringify({ encryptedData: `${id}@${cursor}` }))
  const hash = hex(await packSha256(bytes))
  const blobKey = `${USER}/vaults/${VAULT}/items-v3/task/${id}/${hash}`
  await storage.put(blobKey, bytes.slice().buffer)
  harness.raw
    .prepare(
      `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash, version, crypto_version, operation, server_cursor, signer_device_id, signature, clock, created_at, updated_at)
       VALUES (?, ?, ?, 'task', ?, ?, ?, ?, 1, 1, 'update', ?, 'device-1', 'sig', ?, ?, ?)
       ON CONFLICT (user_id, vault_id, item_type, item_id) DO UPDATE SET
         blob_key = excluded.blob_key, size_bytes = excluded.size_bytes,
         content_hash = excluded.content_hash, server_cursor = excluded.server_cursor,
         updated_at = excluded.updated_at`
    )
    .run(
      `row-${id}`,
      USER,
      VAULT,
      id,
      blobKey,
      bytes.byteLength,
      hash,
      cursor,
      `{"device-1":${cursor}}`,
      at,
      at
    )
}

/** A snapshot row as a write leaves it: one blob key per revision. */
const writeSnapshot = async (noteId: string, revision: number, at = now()): Promise<void> => {
  const bytes = new TextEncoder().encode(`${noteId}-body-${revision}`)
  const blobKey = `${USER}/vaults/${VAULT}/crdt/${noteId}/snapshot-${revision}`
  await storage.put(blobKey, bytes.slice().buffer)
  harness.raw
    .prepare(
      `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'device-1', ?, ?)
       ON CONFLICT (user_id, vault_id, note_id) DO UPDATE SET
         blob_key = excluded.blob_key, sequence_num = excluded.sequence_num,
         size_bytes = excluded.size_bytes, created_at = excluded.created_at, revision = excluded.revision`
    )
    .run(
      `snap-${noteId}`,
      USER,
      VAULT,
      noteId,
      blobKey,
      revision,
      bytes.byteLength,
      at,
      `rev-${noteId}-${revision}`
    )
}

const deleteNoteRecord = (noteId: string, cursor: number): void => {
  harness.raw
    .prepare(
      `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash, version, crypto_version, operation, server_cursor, signer_device_id, signature, clock, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 'note', ?, 'tomb', 1, 'h', 2, 1, 'delete', ?, 'device-1', 'sig', '{}', 1, 1, 1)`
    )
    .run(`row-note-${noteId}`, USER, VAULT, noteId, cursor)
}

/** `count` one-entry packs of `kind`, each cut by its own build of a settled row. */
const buildSmallPacks = async (kind: 'record' | 'crdt_snapshot', count: number): Promise<void> => {
  for (let i = 1; i <= count; i++) {
    if (kind === 'record') await writeRecord(i, `task-${i}`, settled())
    else await writeSnapshot(`note-${i}`, 1, settled() - count + i)
    expect((await compactOneRange(harness.db, storage, SCOPE, kind)).built).toBe(true)
  }
}

interface Row {
  id: string
  pack_key: string
  item_count: number
  byte_size: number
  cover_from: number | null
  cover_through: number | null
}

const listed = (kind: PackKindName): Row[] =>
  harness.raw
    .prepare(
      `SELECT id, pack_key, item_count, byte_size, cover_from, cover_through FROM pack_index
       WHERE user_id = ? AND item_kind = ? ORDER BY min_cursor`
    )
    .all(USER, kind) as Row[]

const boundOf = (kind: PackKindName): number => {
  const rows = listed(kind)
  return packCountBound(
    rows.reduce((sum, row) => sum + row.item_count, 0),
    rows.reduce((sum, row) => sum + row.byte_size, 0)
  )
}

const entryIds = async (key: string): Promise<string[]> => {
  const object = await storage.get(key)
  if (!object) throw new Error(`pack object missing: ${key}`)
  return (await parsePack(new Uint8Array(await object.arrayBuffer()))).entries.map((e) => e.id)
}

const replacedRows = (): number =>
  (harness.raw.prepare('SELECT COUNT(*) AS n FROM pack_replaced_objects').get() as { n: number }).n

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  harness = createSqliteD1()
  storage = createMemoryR2()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, auth_method, created_at, updated_at) VALUES (?, 'rollup@example.com', 'otp', 1, 1)`
    )
    .run(USER)
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES ('device-1', ?, 'Rollup desktop', 'desktop', '1.0.0', 'key', 1, 1)`
    )
    .run(USER)
})

afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('rollup contents (#5229)', () => {
  it('drops superseded and shed records, keeps the coverage union, and the merged pack verifies', async () => {
    await buildSmallPacks('record', 8)
    expect(listed('record').map((row) => [row.cover_from, row.cover_through])).toEqual(
      Array.from({ length: 8 }, (_, i) => [i, i + 1])
    )
    await writeRecord(9, 'task-2') // a later push moves task-2 above every pack
    harness.raw.prepare("UPDATE sync_items SET blob_key = '' WHERE item_id = 'task-3'").run() // shed

    const result = await rollupKind(harness.db, storage, SCOPE, 'record')

    expect(result).toMatchObject({ replaced: 8, kept: 6, dropped: 2 })
    const [merged] = listed('record')
    expect(listed('record')).toHaveLength(1)
    expect([merged.cover_from, merged.cover_through]).toEqual([0, 8])
    expect(await entryIds(merged.pack_key)).toEqual([
      'task:task-1',
      'task:task-4',
      'task:task-5',
      'task:task-6',
      'task:task-7',
      'task:task-8'
    ])
  })

  it('drops snapshots that were rewritten, purged, or belong to a deleted note', async () => {
    await buildSmallPacks('crdt_snapshot', 8)
    await writeSnapshot('note-2', 2, settled()) // rewritten under a new blob key
    harness.raw.prepare("DELETE FROM crdt_snapshots WHERE note_id = 'note-3'").run() // purged
    deleteNoteRecord('note-4', 50) // deleted, not purged yet

    const result = await rollupKind(harness.db, storage, SCOPE, 'crdt_snapshot')

    expect(result).toMatchObject({ replaced: 8, kept: 5, dropped: 3 })
    const [merged] = listed('crdt_snapshot')
    expect(merged.cover_from).toBeNull() // body packs stay cache-only
    expect(await entryIds(merged.pack_key)).toEqual([
      'note-1',
      'note-5',
      'note-6',
      'note-7',
      'note-8'
    ])
  })

  it('leaves a kind at or under its bound alone', async () => {
    await buildSmallPacks('record', 6)
    expect(listed('record')).toHaveLength(boundOf('record'))
    expect(await rollupKind(harness.db, storage, SCOPE, 'record')).toBeNull()
    expect(listed('record')).toHaveLength(6)
  })
})

describe('index swap and the replaced-object grace (#5229)', () => {
  it('a reader that listed before the rollup still reads every old pack, until the grace ends', async () => {
    await buildSmallPacks('record', 8)
    const before = (await listPacks(harness.db, USER, VAULT, { limit: 50 })).packs
    expect(before).toHaveLength(8)

    await rollupKind(harness.db, storage, SCOPE, 'record')

    // One batch: the listing holds the merged pack and none of the replaced ones.
    const after = (await listPacks(harness.db, USER, VAULT, { limit: 50 })).packs
    expect(after).toHaveLength(1)
    expect(before.map((pack) => pack.id)).not.toContain(after[0].id)
    expect(replacedRows()).toBe(8)

    // The reader downloads what it listed, inside the grace, and holds every entry.
    advance(PACK_REPLACED_GRACE_SECONDS - 1)
    expect(await deleteReplacedPackObjects(harness.db, storage)).toBe(0)
    const read = (await Promise.all(before.map((pack) => entryIds(pack.packKey)))).flat()
    expect(read.toSorted()).toEqual(
      Array.from({ length: 8 }, (_, i) => `task:task-${i + 1}`).toSorted()
    )

    // Past the grace a later pass, in any Worker, deletes them; the merged pack stays.
    advance(2)
    expect(await deleteReplacedPackObjects(harness.db, storage)).toBe(8)
    expect(replacedRows()).toBe(0)
    for (const pack of before) expect(await storage.get(pack.packKey)).toBeNull()
    expect(await entryIds(after[0].packKey)).toHaveLength(8)
    // A reader that lists too late meets 404s: its items stay on the item routes,
    // whose rows are untouched.
    const rows = harness.raw.prepare('SELECT COUNT(*) AS n FROM sync_items').get() as { n: number }
    expect(rows.n).toBe(8)
  })

  it('the orphan sweep leaves a replaced object to the grace deletion', async () => {
    await buildSmallPacks('record', 8)
    const old = listed('record').map((row) => row.pack_key)
    await rollupKind(harness.db, storage, SCOPE, 'record')

    advance(PACK_ORPHAN_MIN_AGE_MS / 1000 + 1)
    await cleanupOrphanedPackObjects(harness.db, storage)
    for (const key of old) expect(await storage.get(key)).not.toBeNull()

    expect(await deleteReplacedPackObjects(harness.db, storage)).toBe(8)
  })

  it('loses to a push that moves a kept entry mid-rollup, and deletes only its own object', async () => {
    await buildSmallPacks('record', 8)
    const old = listed('record')
    const put = storage.put.bind(storage)
    let merged = ''
    vi.spyOn(storage, 'put').mockImplementation(async (key, value, options) => {
      if (key.includes('/packs/record/') && !merged) {
        merged = key
        await writeRecord(20, 'task-5') // lands between the read and the swap
      }
      return put(key, value, options)
    })

    expect(await rollupKind(harness.db, storage, SCOPE, 'record')).toBeNull()

    expect(listed('record')).toEqual(old)
    expect(replacedRows()).toBe(0)
    expect(await storage.get(merged)).toBeNull()
    for (const row of old) expect(await storage.get(row.pack_key)).not.toBeNull()
  })

  it('loses to a purge that took an input out of the listing mid-rollup', async () => {
    await buildSmallPacks('crdt_snapshot', 8)
    const [gone] = listed('crdt_snapshot')
    const put = storage.put.bind(storage)
    vi.spyOn(storage, 'put').mockImplementation(async (key, value, options) => {
      if (key.includes('/packs/crdt_snapshot/')) {
        harness.raw.prepare('DELETE FROM pack_index WHERE id = ?').run(gone.id)
      }
      return put(key, value, options)
    })

    expect(await rollupKind(harness.db, storage, SCOPE, 'crdt_snapshot')).toBeNull()

    expect(listed('crdt_snapshot')).toHaveLength(7)
    expect(replacedRows()).toBe(0)
  })
})

describe('pack bound (#5229, protocol 08 §8.14)', () => {
  it('300 small pushes end within the bound after the settle interval', async () => {
    for (let i = 1; i <= 300; i++) {
      advance(60)
      await writeRecord(i)
      await writeSnapshot(`note-${i}`, 1)
      await compactVault(harness.db, storage, SCOPE)
    }
    // The minimum fill cut one full window per kind; the rest waits to settle.
    expect(listed('record').map((row) => row.item_count)).toEqual([256])
    expect(listed('crdt_snapshot').map((row) => row.item_count)).toEqual([256])

    advance(PACK_SETTLE_SECONDS + 1)
    await compactVault(harness.db, storage, SCOPE)

    for (const kind of ['record', 'crdt_snapshot'] as const) {
      const rows = listed(kind)
      expect(rows.reduce((sum, row) => sum + row.item_count, 0)).toBe(300)
      expect(rows.length).toBeLessThanOrEqual(boundOf(kind))
    }
    expect(listed('record').map((row) => [row.cover_from, row.cover_through])).toEqual([
      [0, 256],
      [256, 300]
    ])
  })

  it('a vault stuck at the listing cap drains through rollup and builds again', async () => {
    await buildSmallPacks('record', PACK_LIST_MAX_PACKS_PER_VAULT)
    await writeRecord(PACK_LIST_MAX_PACKS_PER_VAULT + 1, 'task-new', settled())
    expect((await compactOneRange(harness.db, storage, SCOPE, 'record')).built).toBe(false)

    // The cron tick alone: a capped vault gets no push nudge.
    for (let tick = 0; tick < 20 && listed('record').length > boundOf('record'); tick++) {
      await runPackBackfill(harness.db, storage)
    }

    const rows = listed('record')
    expect(rows.length).toBeLessThanOrEqual(boundOf('record'))
    expect(rows.reduce((sum, row) => sum + row.item_count, 0)).toBe(
      PACK_LIST_MAX_PACKS_PER_VAULT + 1
    )
    expect(rows[0].cover_from).toBe(0)
    for (let i = 1; i < rows.length; i++) expect(rows[i].cover_from).toBe(rows[i - 1].cover_through)
    expect(rows[rows.length - 1].cover_through).toBe(PACK_LIST_MAX_PACKS_PER_VAULT + 1)
  }, 60_000)
})
