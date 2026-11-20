import {
  PACK_PURGE_DEADLINE_SECONDS,
  PACK_REPLACED_GRACE_SECONDS,
  PACK_LIST_MAX_PACKS_PER_VAULT
} from '@memry/contracts/sync-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import {
  PACK_ORPHAN_MIN_AGE_MS,
  cleanupDeletedDocumentBodies,
  cleanupOrphanedPackObjects
} from './cleanup'
import { purgeDeletedDocumentBodies } from './document-body-purge'
import { runPackBackfill } from './pack-backfill'
import { compactOneRange, compactVault } from './pack-compaction'
import { packSha256, parsePack, type PackKindName } from './pack-format'
import { listPacks } from './pack-list'
import { PACK_PURGE_RETRY_DELAY_SECONDS, deleteReplacedPackObjects } from './pack-replaced-objects'
import { rollupKind } from './pack-rollup'
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

const packedIds = async (kind: PackKindName): Promise<string[]> =>
  (await Promise.all(listed(kind).map((row) => entryIds(row.pack_key)))).flat()

/** Pack objects among `keys` that still hold an entry `id`. */
const holding = async (keys: readonly string[], id: string): Promise<string[]> => {
  const found: string[] = []
  for (const key of keys) {
    if ((await storage.get(key)) && (await entryIds(key)).includes(id)) found.push(key)
  }
  return found
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

  it('drops rewritten and purged snapshots, and keeps a deleted note while its row exists', async () => {
    await buildSmallPacks('crdt_snapshot', 8)
    await writeSnapshot('note-2', 2, settled()) // rewritten under a new blob key
    harness.raw.prepare("DELETE FROM crdt_snapshots WHERE note_id = 'note-3'").run() // purged
    deleteNoteRecord('note-4', 50) // deleted, not purged yet: its body row still counts

    const result = await rollupKind(harness.db, storage, SCOPE, 'crdt_snapshot')

    expect(result).toMatchObject({ replaced: 8, kept: 6, dropped: 2 })
    const [merged] = listed('crdt_snapshot')
    expect(merged.cover_from).toBeNull() // body packs stay cache-only
    expect(await entryIds(merged.pack_key)).toEqual([
      'note-1',
      'note-4',
      'note-5',
      'note-6',
      'note-7',
      'note-8'
    ])
  })

  // REVIEW-5267 P1: the rollup dropped a deleted note's body, and a re-create
  // before the purge left it in no pack for good (protocol 08 §8.12).
  it('a note deleted and re-created before the purge keeps its body packed', async () => {
    await buildSmallPacks('crdt_snapshot', 8)
    deleteNoteRecord('note-4', 50)
    expect(await rollupKind(harness.db, storage, SCOPE, 'crdt_snapshot')).not.toBeNull()
    harness.raw
      .prepare(
        "UPDATE sync_items SET deleted_at = NULL, operation = 'create', server_cursor = 60 WHERE item_id = 'note-4'"
      )
      .run()
    await purgeDeletedDocumentBodies(harness.db, storage, USER, VAULT, ['note-4']) // keeps a live id

    advance(PACK_SETTLE_SECONDS + 1)
    await compactVault(harness.db, storage, SCOPE)
    await runPackBackfill(harness.db, storage)

    expect(await packedIds('crdt_snapshot')).toContain('note-4')
  })

  // REVIEW-5267 P9: one unreadable input failed the whole rollup every tick.
  it('excludes an unreadable input pack and still brings the kind under its bound', async () => {
    await buildSmallPacks('record', 20)
    const broken = listed('record')[5]
    await storage.delete(broken.pack_key)

    for (let tick = 0; tick < 5; tick++) await runPackBackfill(harness.db, storage)

    expect(listed('record').length).toBeLessThanOrEqual(boundOf('record'))
    expect(listed('record').map((row) => row.id)).toContain(broken.id) // a reader sees a gap
  })

  // VERIFY-5267 V7: unreadable packs split the kind into runs, so the bound
  // counts each one (protocol 08 §8.14).
  it('lists at most the bound plus its unreadable packs, and logs each one every tick', async () => {
    await buildSmallPacks('record', 40)
    const broken = [10, 20, 30].map((i) => listed('record')[i])
    for (const pack of broken) await storage.delete(pack.pack_key)

    for (let tick = 0; tick < 4; tick++) await runPackBackfill(harness.db, storage)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await runPackBackfill(harness.db, storage)

    expect(listed('record')).toHaveLength(7) // four merged runs and the three unreadable packs
    expect(listed('record').length).toBeLessThanOrEqual(boundOf('record') + broken.length)
    expect(listed('record').map((row) => row.id)).toEqual(
      expect.arrayContaining(broken.map((p) => p.id))
    )
    const logged = errors.mock.calls
      .map(
        ([line]) => JSON.parse(String(line)) as { message: string; packId?: string; kind?: string }
      )
      .filter((entry) => entry.message.startsWith('rollup input pack unreadable'))
    expect(logged).toHaveLength(broken.length)
    expect(logged.map((entry) => entry.packId)).toEqual(
      expect.arrayContaining(broken.map((p) => p.id))
    )
    expect(logged.every((entry) => entry.kind === 'record')).toBe(true)
  })

  // VERIFY-5267 r2 V10: each unreadable pack can split a run in two (protocol 08 §8.14).
  it('lists at most the bound plus twice its unreadable packs, plus one', async () => {
    await buildSmallPacks('record', 40)
    const rows = listed('record')
    const bad = [5, 10, 15, 20, 25, 30, 35]
    for (const i of bad) await storage.delete(rows[i].pack_key)

    for (let tick = 0; tick < 30; tick++) await runPackBackfill(harness.db, storage)

    expect(listed('record')).toHaveLength(15) // eight merged runs and the seven unreadable packs
    expect(listed('record').length).toBeLessThanOrEqual(boundOf('record') + 2 * bad.length + 1)
  })

  // VERIFY-5267 F4: the re-plan stayed inside the failed run, so bad packs in
  // the longest run hid a mergeable run elsewhere, every tick.
  it('re-plans over every listed pack when the longest run has no mergeable pair left', async () => {
    await buildSmallPacks('record', 30)
    const rows = listed('record')
    // Ten packs from before coverage (cache-only) chain apart from the twenty covered ones.
    harness.raw
      .prepare(
        `UPDATE pack_index SET cover_from = NULL, cover_through = NULL
         WHERE id IN (SELECT value FROM json_each(?))`
      )
      .run(JSON.stringify(rows.slice(0, 10).map((row) => row.id)))
    for (let i = 11; i < 30; i += 2) await storage.delete(rows[i].pack_key)

    expect(await rollupKind(harness.db, storage, SCOPE, 'record')).toMatchObject({ replaced: 10 })
    expect(listed('record')).toHaveLength(21)
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
    expect((await deleteReplacedPackObjects(harness.db, storage)).deleted).toBe(0)
    const read = (await Promise.all(before.map((pack) => entryIds(pack.packKey)))).flat()
    expect(read.toSorted()).toEqual(
      Array.from({ length: 8 }, (_, i) => `task:task-${i + 1}`).toSorted()
    )

    // Past the grace a later pass, in any Worker, deletes them; the merged pack stays.
    advance(2)
    expect((await deleteReplacedPackObjects(harness.db, storage)).deleted).toBe(8)
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

    expect((await deleteReplacedPackObjects(harness.db, storage)).deleted).toBe(8)
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

/** R2 deletes that include any of `keys` fail until the spy is restored. */
const failDeletesOf = (keys: readonly string[]) => {
  const remove = storage.delete.bind(storage)
  return vi
    .spyOn(storage, 'delete')
    .mockImplementation(async (deleted) =>
      [deleted].flat().some((key) => keys.includes(key))
        ? Promise.reject(new Error('r2 down'))
        : remove(deleted)
    )
}

describe('the purge and replaced objects (#5229, protocol 08 §8.13)', () => {
  // REVIEW-5267 P2: replaced inputs waited for the next drain, past the 900 s deadline.
  it('leaves no pack object holding the purged body, replaced ones included', async () => {
    await buildSmallPacks('crdt_snapshot', 8)
    const old = listed('crdt_snapshot').map((row) => row.pack_key)
    expect(await rollupKind(harness.db, storage, SCOPE, 'crdt_snapshot')).not.toBeNull()
    deleteNoteRecord('note-4', 50)

    // Nothing is left to retry, so no delayed message is asked for.
    expect(await purgeDeletedDocumentBodies(harness.db, storage, USER, VAULT, ['note-4'])).toBe(
      false
    )

    expect(await holding(old, 'note-4')).toEqual([])
    expect(replacedRows()).toBe(0)
  })

  // VERIFY-5267 F3: a listed pack the purge dropped had its R2 delete fail and
  // was never retried.
  it('a dropped listed pack whose delete failed is retried and gone inside the deadline', async () => {
    await buildSmallPacks('crdt_snapshot', 8)
    const old = listed('crdt_snapshot').map((row) => row.pack_key)
    deleteNoteRecord('note-4', 50)
    const failing = failDeletesOf(old)

    expect(await purgeDeletedDocumentBodies(harness.db, storage, USER, VAULT, ['note-4'])).toBe(
      true
    )
    failing.mockRestore()
    expect(listed('crdt_snapshot')).toEqual([])
    expect(replacedRows()).toBe(old.length)

    advance(PACK_PURGE_RETRY_DELAY_SECONDS)
    await compactVault(harness.db, storage, SCOPE) // the delayed message
    expect(await holding(old, 'note-4')).toEqual([])
    expect(replacedRows()).toBe(0)
  })

  // VERIFY-5267 F1: the deletion ran after the builds, so a build that threw
  // skipped it on every retry of the message.
  it('the delayed message deletes due objects even when its build throws', async () => {
    await buildSmallPacks('crdt_snapshot', 8)
    const old = listed('crdt_snapshot').map((row) => row.pack_key)
    await rollupKind(harness.db, storage, SCOPE, 'crdt_snapshot')
    deleteNoteRecord('note-4', 50)
    const failing = failDeletesOf(old)
    await purgeDeletedDocumentBodies(harness.db, storage, USER, VAULT, ['note-4'])
    failing.mockRestore()
    expect(await holding(old, 'note-4')).not.toEqual([])

    advance(PACK_PURGE_RETRY_DELAY_SECONDS)
    await writeSnapshot('note-9', 1, settled())
    const put = storage.put.bind(storage)
    vi.spyOn(storage, 'put').mockImplementation(async (key, value, options) => {
      if (key.includes('/packs/crdt_snapshot/')) throw new Error('r2 put 500')
      return put(key, value, options)
    })
    await expect(compactVault(harness.db, storage, SCOPE)).rejects.toThrow('r2 put 500')

    expect(await holding(old, 'note-4')).toEqual([])
  })

  // VERIFY-5267 r2 V12: the delayed message acked with objects still due, so
  // Queues never redelivered it and three failed deletes missed 900 s.
  it('a delayed message that leaves objects due throws, and its redelivery deletes them before 900 s', async () => {
    await buildSmallPacks('crdt_snapshot', 8)
    const old = listed('crdt_snapshot').map((row) => row.pack_key)
    deleteNoteRecord('note-4', 50)
    const remove = storage.delete.bind(storage)
    let failures = 3 // the purge and both passes of the first delivery
    vi.spyOn(storage, 'delete').mockImplementation(async (keys) => {
      if (failures > 0 && [keys].flat().some((key) => old.includes(key))) {
        failures--
        return Promise.reject(new Error('r2 503'))
      }
      return remove(keys)
    })
    expect(await purgeDeletedDocumentBodies(harness.db, storage, USER, VAULT, ['note-4'])).toBe(
      true
    )
    advance(PACK_PURGE_RETRY_DELAY_SECONDS)
    await writeRecord(1, 'task-1', settled())

    await storage.put('tomb', new Uint8Array([1])) // the tombstone row's payload, so the build has no hole
    await expect(compactVault(harness.db, storage, SCOPE)).rejects.toThrow('still due')
    // The record build of the failed delivery stays committed.
    expect(listed('record')).toHaveLength(1)
    expect(await holding(old, 'note-4')).not.toEqual([])

    advance(1)
    await compactVault(harness.db, storage, SCOPE) // the redelivery
    expect(await holding(old, 'note-4')).toEqual([])
    expect(listed('record')).toHaveLength(1)
  })

  // VERIFY-5267 F5: every delete enqueued a delayed message, and one tick
  // purged up to 100 vaults, about 700 subrequests.
  it('the cleanup sweep purges at most five vaults per tick and asks no retry when none is due', async () => {
    for (let v = 0; v < 7; v++) {
      const vault = `vault-${v}`
      harness.raw
        .prepare(
          `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at, revision)
           VALUES (?, ?, ?, 'n', ?, 1, 1, 'device-1', 1, 'r')`
        )
        .run(`s-${v}`, USER, vault, `${USER}/vaults/${vault}/crdt/n/snapshot-1`)
      harness.raw
        .prepare(
          `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash, version, crypto_version, operation, server_cursor, signer_device_id, signature, clock, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, 'note', 'n', 'tomb', 1, 'h', 2, 1, 'delete', 1, 'device-1', 'sig', '{}', 1, 1, 1)`
        )
        .run(`row-${v}`, USER, vault)
    }
    const send = vi.fn()
    const queue = { PACK_QUEUE: { send } as unknown as Queue }

    expect(await cleanupDeletedDocumentBodies(harness.db, storage, queue)).toBe(5)
    expect(await cleanupDeletedDocumentBodies(harness.db, storage, queue)).toBe(2)
    expect(send).not.toHaveBeenCalled()
  })

  it('a failed delete stays due and the delayed purge message deletes it inside the deadline', async () => {
    await buildSmallPacks('crdt_snapshot', 8)
    const old = listed('crdt_snapshot').map((row) => row.pack_key)
    await rollupKind(harness.db, storage, SCOPE, 'crdt_snapshot')
    deleteNoteRecord('note-4', 50)
    const failing = failDeletesOf(old)
    const send = vi.fn()

    await cleanupDeletedDocumentBodies(harness.db, storage, {
      PACK_QUEUE: { send } as unknown as Queue
    })

    expect(send).toHaveBeenCalledWith(SCOPE, { delaySeconds: PACK_PURGE_RETRY_DELAY_SECONDS })
    expect(PACK_PURGE_RETRY_DELAY_SECONDS).toBeLessThan(PACK_PURGE_DEADLINE_SECONDS)
    expect(await holding(old, 'note-4')).not.toEqual([])

    failing.mockRestore()
    advance(PACK_PURGE_RETRY_DELAY_SECONDS)
    await compactVault(harness.db, storage, SCOPE) // the delayed message
    expect(await holding(old, 'note-4')).toEqual([])
  })
})

describe('build compare-and-swap (#5229)', () => {
  // REVIEW-5267 P10: a cron build and a queue build of one window both listed,
  // and the later one moved covered_through back.
  it('a build that lost the watermark to a concurrent build lists nothing', async () => {
    await buildSmallPacks('record', 2)
    for (let i = 3; i <= 6; i++) await writeRecord(i, `task-${i}`, settled())
    const get = storage.get.bind(storage)
    let concurrent: boolean | null = null
    vi.spyOn(storage, 'get').mockImplementation(async (key, options) => {
      const object = await get(key, options as R2GetOptions)
      if (concurrent === null && key.includes('/task/task-3/')) {
        concurrent = false
        await writeRecord(50, 'task-3', settled()) // a push moves task-3 up
        concurrent = (await compactOneRange(harness.db, storage, SCOPE, 'record')).built
      }
      return object
    })

    expect((await compactOneRange(harness.db, storage, SCOPE, 'record')).built).toBe(false)
    expect(concurrent).toBe(true)

    expect(listed('record').map((row) => [row.cover_from, row.cover_through])).toEqual([
      [0, 1],
      [1, 2],
      [2, 50]
    ])
    const keys = [
      ...(await storage.list({ prefix: `${USER}/vaults/${VAULT}/packs/record/` })).objects
    ]
    expect(keys.map((object) => object.key).toSorted()).toEqual(
      listed('record')
        .map((row) => row.pack_key)
        .toSorted()
    )
  })
})

describe('pack bound (#5229, protocol 08 §8.14)', () => {
  // REVIEW-5267 P5: rollup ran before the build, so a vault ended at bound + 1.
  it('a push every 25 hours for 300 days never ends a message above the bound', async () => {
    for (let i = 1; i <= 300; i++) {
      advance(25 * 3600)
      await writeRecord(i)
      await writeSnapshot(`note-${i}`, 1)
      await compactVault(harness.db, storage, SCOPE)
      for (const kind of ['record', 'crdt_snapshot'] as const) {
        expect(listed(kind).length).toBeLessThanOrEqual(boundOf(kind))
      }
    }
  }, 120_000)

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
