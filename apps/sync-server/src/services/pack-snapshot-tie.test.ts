import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { runBackfillTick } from '../__tests__/pack-queue-memory'
import { purgeDeletedDocumentBodies } from './document-body-purge'
import { compactOneRange } from './pack-compaction'
import { parsePack } from './pack-format'
import { deleteReplacedPackObjects, packKindReset } from './pack-replaced-objects'
import { healSnapshotRemainder } from './pack-snapshot-heal'
import { snapshotSlot } from './pack-snapshot-selection'

/**
 * #5310 (D-TIE-REMAINDER): a snapshot tie group larger than one pack, and a
 * remainder an older build left below the watermark, both end up in a pack,
 * driven only by the cron and its backfill chains.
 */

const USER = 'user-tie'
const VAULT = 'default'
const SCOPE = { userId: USER, vaultId: VAULT }
const MB = 1024 * 1024

let harness: SqliteD1
let storage: R2Bucket

const seedSnapshot = (noteId: string, createdAt: number, size = 24): void => {
  const blobKey = `${USER}/vaults/${VAULT}/crdt/${noteId}/snapshot`
  harness.raw
    .prepare(
      `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at, revision)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'device-1', ?, ?)`
    )
    .run(`snap-${noteId}`, USER, VAULT, noteId, blobKey, size, createdAt, `rev-${noteId}`)
  void storage.put(blobKey, new Uint8Array(size).fill(noteId.length).buffer)
}

/** Snapshot rows no listed pack's `documents` holds: the per-document GETs a fresh device makes. */
const unpacked = (): string[] =>
  (
    harness.raw
      .prepare(
        `SELECT note_id FROM crdt_snapshots s WHERE user_id = ? AND vault_id = ? AND note_id NOT IN (
           SELECT d.value FROM pack_index p, json_each(p.documents) d
           WHERE p.user_id = s.user_id AND p.vault_id = s.vault_id AND p.item_kind = 'crdt_snapshot')
         ORDER BY note_id`
      )
      .all(USER, VAULT) as Array<{ note_id: string }>
  ).map((row) => row.note_id)

const listed = () =>
  harness.raw
    .prepare(
      `SELECT pack_key, min_cursor, max_cursor, documents FROM pack_index
       WHERE item_kind = 'crdt_snapshot' ORDER BY min_cursor`
    )
    .all() as Array<{ pack_key: string; min_cursor: number; max_cursor: number; documents: string }>

/** Every listed pack's entries, read from R2: what a fresh device downloads. */
const packedIds = async (): Promise<string[]> => {
  const ids: string[] = []
  for (const row of listed()) {
    const object = await storage.get(row.pack_key)
    if (!object) throw new Error(`listed pack object missing: ${row.pack_key}`)
    ids.push(
      ...(await parsePack(new Uint8Array(await object.arrayBuffer()))).entries.map((e) => e.id)
    )
  }
  return ids.toSorted()
}

const tombstone = (noteId: string): void => {
  harness.raw
    .prepare(
      `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash, version, crypto_version, operation, server_cursor, signer_device_id, signature, clock, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 'note', ?, 'tomb', 1, 'h', 2, 1, 'delete', 1, 'device-1', 'sig', '{}', 1, 1, 1)`
    )
    .run(`row-${noteId}`, USER, VAULT, noteId)
}

/** Holds `storage` GETs of keys `match` accepts until `release()`; `atGate` resolves at the first. */
const gated = (match: (key: string) => boolean) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let reached!: () => void
  const atGate = new Promise<void>((resolve) => (reached = resolve))
  const read = storage.get.bind(storage)
  vi.spyOn(storage, 'get').mockImplementation(async (key: string) => {
    if (match(key)) {
      reached()
      await gate
    }
    return read(key)
  })
  return { release, atGate }
}

const watermark = () =>
  harness.raw
    .prepare(
      `SELECT last_sort_value, last_sort_tiebreak FROM pack_watermarks WHERE item_kind = 'crdt_snapshot'`
    )
    .get()

beforeEach(() => {
  harness = createSqliteD1()
  storage = createMemoryR2()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, auth_method, created_at, updated_at) VALUES (?, 'tie@example.com', 'otp', 1, 1)`
    )
    .run(USER)
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES ('device-1', ?, 'Tie desktop', 'desktop', '1.0.0', 'key', 1, 1)`
    )
    .run(USER)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
})

describe('snapshot tie remainder (#5310)', () => {
  it('packs every row of a tie group larger than one pack once the chain settles', async () => {
    // Seven 8 MB snapshots in one second: three fill a pack, so the second
    // starts a full pack and four rows remain in it.
    const tie = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => `tie-${id}`)
    for (const id of tie) seedSnapshot(id, 1000, 8 * MB)
    seedSnapshot('later', 2000)

    await runBackfillTick(harness.db, storage)

    expect(unpacked()).toEqual([])
    expect(await packedIds()).toEqual([...tie, 'later'].toSorted())
  })

  it('packs a remainder an older build left below the watermark on the next backfill', async () => {
    // fff6328b's shape: one pack holds 28 rows of second 1000 and the
    // watermark is past the second, while 27 rows of it are in no pack.
    for (let i = 0; i < 28; i++) seedSnapshot(`kept-${String(i).padStart(2, '0')}`, 1000)
    for (let i = 0; i < 10; i++) seedSnapshot(`late-${i}`, 2000 + i)
    expect((await compactOneRange(harness.db, storage, SCOPE, 'crdt_snapshot')).built).toBe(true)
    const remainder = Array.from({ length: 27 }, (_, i) => `left-${String(i).padStart(2, '0')}`)
    for (const id of remainder) seedSnapshot(id, 1000)
    expect(unpacked()).toEqual(remainder)

    const tick = await runBackfillTick(harness.db, storage)

    expect(tick.enqueued).toBe(1)
    expect(unpacked()).toEqual([])
    expect((await packedIds()).filter((id) => id.startsWith('left-'))).toEqual(remainder)
    // The pack sits below the taken second, and holds only that second.
    expect(listed().map(({ min_cursor, max_cursor }) => [min_cursor, max_cursor])).toEqual([
      [999, 1000],
      [1000, 2009]
    ])
    // Settled: the next tick finds nothing to do.
    expect((await runBackfillTick(harness.db, storage)).enqueued).toBe(0)
  })

  it('scopes the purge to the remainder pack that holds a deleted note', async () => {
    for (let i = 0; i < 3; i++) seedSnapshot(`kept-${i}`, 1000)
    seedSnapshot('late', 2000)
    await compactOneRange(harness.db, storage, SCOPE, 'crdt_snapshot')
    seedSnapshot('left-0', 1000)
    seedSnapshot('left-1', 1000)
    await runBackfillTick(harness.db, storage)
    const [remainderPack, firstPack] = listed()
    expect(JSON.parse(remainderPack.documents)).toEqual(['left-0', 'left-1'])

    tombstone('left-0')
    await purgeDeletedDocumentBodies(harness.db, storage, USER, VAULT, ['left-0'])
    await deleteReplacedPackObjects(harness.db, storage)

    expect(listed().find((row) => row.min_cursor === 1000)?.pack_key).toBe(firstPack.pack_key)
    expect(await packedIds()).toEqual(['kept-0', 'kept-1', 'kept-2', 'late', 'left-1'])
  })

  // REVIEW-5315 P1a: a pending purge rewrite takes its pack out of the
  // listing, so its documents looked unpacked. The heal packed them at the
  // rewrite's min_cursor, the rewrite lost twice and the kind was reset.
  it('leaves the documents of a pack waiting for its purge rewrite alone', async () => {
    for (const id of ['a', 'b', 'c']) seedSnapshot(id, 1000)
    seedSnapshot('late', 2000)
    await compactOneRange(harness.db, storage, SCOPE, 'crdt_snapshot')
    const [pack] = listed()
    tombstone('b')
    const rewrite = gated((key) => key === pack.pack_key)
    const purge = purgeDeletedDocumentBodies(harness.db, storage, USER, VAULT, ['b'])
    await rewrite.atGate

    expect((await healSnapshotRemainder(harness.db, storage, SCOPE)).reason).toBe('not_ready')
    rewrite.release()
    await purge

    expect(
      listed().map(({ min_cursor, documents }) => [min_cursor, JSON.parse(documents)])
    ).toEqual([[1000, ['a', 'c', 'late']]])
    expect(watermark()).toEqual({ last_sort_value: 2000, last_sort_tiebreak: 'late' })
  })

  // REVIEW-5315 P1b: with the purged note first, the heal listed at 1001 and
  // the rewrite at 1000, so both packs held the same documents.
  it("never lists a pending rewrite's documents in a second pack", async () => {
    for (const [id, second] of [
      ['a', 1000],
      ['b', 1001],
      ['c', 1002],
      ['late', 2000]
    ] as const)
      seedSnapshot(id, second)
    await compactOneRange(harness.db, storage, SCOPE, 'crdt_snapshot')
    const [pack] = listed()
    tombstone('a')
    const rewrite = gated((key) => key === pack.pack_key)
    const purge = purgeDeletedDocumentBodies(harness.db, storage, USER, VAULT, ['a'])
    await rewrite.atGate

    await healSnapshotRemainder(harness.db, storage, SCOPE)
    rewrite.release()
    await purge

    const documents = listed().flatMap((row) => JSON.parse(row.documents) as string[])
    expect(documents.toSorted()).toEqual(['b', 'c', 'late'])
  })

  // REVIEW-5315 P7a: a kind reset between the heal's read and its commit; the
  // rebuild from 0 then packed the healed row a second time.
  it('lists nothing when the kind is reset while it builds', async () => {
    for (const id of ['a', 'b', 'c']) seedSnapshot(id, 1000)
    seedSnapshot('late', 2000)
    await compactOneRange(harness.db, storage, SCOPE, 'crdt_snapshot')
    seedSnapshot('x', 1000)
    const fetch = gated((key) => key.includes('/crdt/x/'))
    const heal = healSnapshotRemainder(harness.db, storage, SCOPE)
    await fetch.atGate
    await harness.db.batch(
      packKindReset(harness.db, SCOPE, 'crdt_snapshot', { sql: '1', bind: [] })
    )
    fetch.release()

    expect((await heal).reason).toBe('unlisted')
    expect(listed()).toEqual([])
    await compactOneRange(harness.db, storage, SCOPE, 'crdt_snapshot')
    expect(await packedIds()).toEqual(['a', 'b', 'c', 'late', 'x'])
  })

  // REVIEW-5315 M1: a forward tie slot must not take the min_cursor a pending
  // rewrite lists its pack back at.
  it("counts a pending rewrite's min_cursor as taken", async () => {
    harness.raw
      .prepare(
        `INSERT INTO pack_replaced_objects (pack_key, user_id, vault_id, replaced_by, removed_at)
         VALUES (?, ?, ?, 'rewrite', 1)`
      )
      .run(`${USER}/vaults/${VAULT}/packs/crdt_snapshot/1000_1000_p.pack`, USER, VAULT)

    expect(await snapshotSlot(harness.db, SCOPE, 1000)).toEqual({
      minCursor: 999,
      lastSecond: 1000
    })
  })
})
