import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { AppError } from '../lib/errors'
import { compactOneRange, compactVault, selectCandidates } from './pack-compaction'
import { ENQUEUE_RETRY_DELAYS_MS, enqueuePackCompaction } from './pack-queue'
import { insertPackIndexRow } from './pack-index-write'
import { PACK_TARGET_BYTES } from './pack-sizing'
import { extractEntry, packSha256, parsePack } from './pack-format'

/**
 * Producer-side backpressure (#1997). Queues answers a burst with "Too Many
 * Requests"; that used to drop the nudge on the first try and surface as an
 * unhandled 500.
 */
describe('enqueuePackCompaction under queue backpressure', () => {
  const scope = { userId: 'user-enqueue', vaultId: 'default' }
  const tooManyRequests = (): Error => new Error('Queue send failed: Too Many Requests')

  it('retries a rate-limited send instead of dropping the nudge', async () => {
    const send = vi.fn().mockRejectedValueOnce(tooManyRequests()).mockResolvedValueOnce(undefined)

    await enqueuePackCompaction({ PACK_QUEUE: { send } as unknown as Queue }, scope)

    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(scope)
  })

  it('gives up as a typed 429 so telemetry reads it as expected, not unhandled', async () => {
    const send = vi.fn().mockRejectedValue(tooManyRequests())

    const thrown = await enqueuePackCompaction(
      { PACK_QUEUE: { send } as unknown as Queue },
      scope
    ).catch((error: unknown) => error)

    expect(send).toHaveBeenCalledTimes(ENQUEUE_RETRY_DELAYS_MS.length + 1)
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).code).toBe('PACK_ENQUEUE_RATE_LIMITED')
    expect((thrown as AppError).statusCode).toBe(429)
  })

  it('rethrows a non-backpressure failure unchanged and without retrying', async () => {
    const boom = new Error('binding exploded')
    const send = vi.fn().mockRejectedValue(boom)

    await expect(
      enqueuePackCompaction({ PACK_QUEUE: { send } as unknown as Queue }, scope)
    ).rejects.toBe(boom)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

/**
 * Compaction core against the REAL migration ledger (0001..0007): selection
 * correctness incl. already-packed exclusion, idempotent reruns, immutability,
 * checksum-verified contents, hole tolerance, and snapshot metadata capture.
 */

const USER = 'user-pack'
const VAULT = 'default'

let harness: SqliteD1
let storage: R2Bucket
const nowSec = () => Math.floor(Date.now() / 1000)

const seedUser = (): void => {
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, auth_method, created_at, updated_at)
       VALUES (?, ?, 'otp', 1, 1)`
    )
    .run(USER, 'pack@example.com')
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES ('device-1', ?, 'Pack desktop', 'desktop', '1.0.0', 'key', 1, 1)`
    )
    .run(USER)
}

interface RecordSeedOptions {
  cursor: number
  type?: string
  id?: string
  bytes?: Uint8Array
  deleted?: boolean
  blobKey?: string
  signerDeviceId?: string | null
  clock?: string
}

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

const seedRecord = async (
  options: RecordSeedOptions
): Promise<{ blobKey: string; bytes: Uint8Array }> => {
  const type = options.type ?? 'task'
  const itemId = options.id ?? `item-${options.cursor}`
  // Mirror the push path's payload shape: JSON text of base64 fields. The pack
  // must carry these EXACT bytes.
  const bytes =
    options.bytes ??
    new TextEncoder().encode(JSON.stringify({ encryptedData: 'payload-' + options.cursor }))
  // The push stores exactly the bytes it hashed into content_hash.
  const contentHash = hexOf(await packSha256(bytes))
  const blobKey =
    options.blobKey ?? `${USER}/vaults/${VAULT}/items-v3/${type}/${itemId}/${contentHash}`
  harness.raw
    .prepare(
      `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash, version, crypto_version, operation, server_cursor, signer_device_id, signature, clock, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'sig', ?, 1, 1, ?)`
    )
    .run(
      `row-${options.cursor}`,
      USER,
      VAULT,
      type,
      itemId,
      blobKey,
      bytes.byteLength,
      contentHash,
      options.deleted ? 'delete' : 'update',
      options.cursor,
      options.signerDeviceId === undefined ? 'device-1' : options.signerDeviceId,
      options.clock ?? JSON.stringify({ 'device-1': options.cursor }),
      options.deleted ? nowSec() : null
    )
  // The source object must exist exactly as a push would have left it.
  await storage.put(blobKey, bytes.slice().buffer)
  return { blobKey, bytes }
}

const seedSnapshot = (
  noteId: string,
  createdAt: number,
  sequenceNum = 1,
  bytes = new Uint8Array(24).map((_, i) => (i + noteId.length) % 251)
): Uint8Array => {
  const blobKey = `${USER}/vaults/${VAULT}/crdt/${noteId}/snapshot`
  harness.raw
    .prepare(
      `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'device-1', ?, ?)`
    )
    .run(
      `snap-${noteId}`,
      USER,
      VAULT,
      noteId,
      blobKey,
      sequenceNum,
      bytes.byteLength,
      createdAt,
      `rev-${noteId}-${sequenceNum}`
    )
  void storage.put(blobKey, bytes.slice().buffer)
  return bytes
}

const watermarkOf = (
  kind: string
): { last_sort_value: number; last_sort_tiebreak: string } | null =>
  (harness.raw
    .prepare(
      'SELECT last_sort_value, last_sort_tiebreak FROM pack_watermarks WHERE user_id = ? AND item_kind = ?'
    )
    .get(USER, kind) as { last_sort_value: number; last_sort_tiebreak: string } | undefined) ?? null

/** Fetch a stored pack as bytes; fails loudly if the object is missing. */
const packOf = async (key: string | null): Promise<Uint8Array> => {
  const obj = await storage.get(key!)
  if (!obj) throw new Error(`pack object missing: ${key}`)
  return new Uint8Array(await obj.arrayBuffer())
}

beforeEach(() => {
  harness = createSqliteD1()
  storage = createMemoryR2()
  seedUser()
})

afterEach(() => {
  harness.close()
})

describe('selection', () => {
  it('selects records in cursor order and excludes nothing un-packed', async () => {
    for (let cursor = 3; cursor <= 6; cursor++) await seedRecord({ cursor })
    const selection = await selectCandidates(harness.db, { userId: USER, vaultId: VAULT }, 'record')
    expect(selection.candidates.map((c) => c.sortKey)).toEqual([3, 4, 5, 6])
  })

  it('excludes already-packed rows via the composite watermark', async () => {
    for (let cursor = 1; cursor <= 5; cursor++) await seedRecord({ cursor })
    await compactOneRange(harness.db, storage, { userId: USER, vaultId: VAULT }, 'record')
    const after = await selectCandidates(harness.db, { userId: USER, vaultId: VAULT }, 'record')
    expect(after.candidates).toHaveLength(0)

    // New pushes land above the watermark and become eligible only there.
    await seedRecord({ cursor: 6 })
    const next = await selectCandidates(harness.db, { userId: USER, vaultId: VAULT }, 'record')
    expect(next.candidates.map((c) => c.sortKey)).toEqual([6])
  })

  it('skips oversized items but still advances the watermark past them', async () => {
    // 9MB: above MAX_PACKED_ITEM_BYTES (8MB) but allocated without
    // crypto.getRandomValues' 64KiB cap.
    await seedRecord({ cursor: 1, bytes: new Uint8Array(9 * 1024 * 1024).fill(7) })
    await seedRecord({ cursor: 2 })

    const first = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'record'
    )
    expect(first.built).toBe(true)
    expect(first.itemCount).toBe(1) // only the small one

    // The oversized row is a permanent tail hole: never selected again...
    const again = await selectCandidates(harness.db, { userId: USER, vaultId: VAULT }, 'record')
    expect(again.candidates).toHaveLength(0)
    // ...and the window does not loop on it forever.
    expect(watermarkOf('record')?.last_sort_value).toBe(2)
  })

  it('breaks created_at ties for snapshots with the note_id tiebreak', async () => {
    seedSnapshot('note-a', 1000)
    seedSnapshot('note-b', 1000)
    const selection = await selectCandidates(
      harness.db,
      { userId: USER, vaultId: VAULT },
      'crdt_snapshot'
    )
    expect(selection.candidates.map((c) => c.tiebreak)).toEqual(['note-a', 'note-b'])
    expect(selection.nextTiebreak).toBe('note-b')
  })

  it('excludes already-packed ties when a window ends inside a tie group', async () => {
    // Four snapshots share created_at=1000; three 8MB bodies fill the window
    // to exactly PACK_TARGET_BYTES, so the cap breaks the tie group after
    // note-c and the watermark lands MID-GROUP at (1000, 'note-c').
    const MB = 1024 * 1024
    const sizeCapped = (n: number) => new Uint8Array(8 * MB).fill(n)
    seedSnapshot('note-a', 1000, 1, sizeCapped(1))
    seedSnapshot('note-b', 1000, 1, sizeCapped(2))
    seedSnapshot('note-c', 1000, 1, sizeCapped(3))
    seedSnapshot('note-d', 1000, 1) // tiny: overflows the capped window

    const first = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'crdt_snapshot'
    )
    expect(first.built).toBe(true)
    expect(first.byteSize).toBe(PACK_TARGET_BYTES)
    const parsedFirst = await parsePack(await packOf(first.packKey))
    expect(parsedFirst.entries.map((e) => e.id)).toEqual(['note-a', 'note-b', 'note-c'])
    expect(watermarkOf('crdt_snapshot')).toEqual({
      last_sort_value: 1000,
      last_sort_tiebreak: 'note-c'
    })

    // The row-value predicate must exclude note-a/b/c (ties AT or BELOW the
    // watermark's note_id) while note-d remains eligible — dropping the
    // `note_id > ?` half would exclude d too and stall the pipeline.
    const next = await selectCandidates(
      harness.db,
      { userId: USER, vaultId: VAULT },
      'crdt_snapshot'
    )
    expect(next.candidates.map((c) => c.tiebreak)).toEqual(['note-d'])

    // note-d's pack would share min_cursor 1000 with the listed one, and the
    // listed one is full, so the two cannot be rolled into one. Snapshot packs
    // are a cache only: the build leaves the rest of the tie item by item and
    // moves past it, so later seconds still pack (#5229 P6, D-P6-EXIT).
    const second = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'crdt_snapshot'
    )
    expect(second.built).toBe(false)
    expect(second.holes).toEqual([])
    expect(watermarkOf('crdt_snapshot')).toEqual({
      last_sort_value: 1000,
      last_sort_tiebreak: 'note-d'
    })
  })
})

describe('pack build', () => {
  it('writes an immutable verifiable pack and the D1 range row', async () => {
    const seeds = [await seedRecord({ cursor: 1 }), await seedRecord({ cursor: 2 })]
    const result = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'record'
    )

    expect(result.built).toBe(true)
    // Unique per build (REVIEW-5260): the range, then the pack_index row id.
    const { id } = harness.raw.prepare('SELECT id FROM pack_index').get() as { id: string }
    expect(result.packKey).toBe(`${USER}/vaults/${VAULT}/packs/record/1_2_${id}.pack`)

    const packBytes = await packOf(result.packKey)
    const parsed = await parsePack(packBytes)
    expect(parsed.entries.map((e) => e.sortKey)).toEqual([1, 2])
    expect(parsed.entries.map((e) => e.id)).toEqual(['task:item-1', 'task:item-2'])
    // Byte fidelity: pack bytes equal exactly what the source objects held.
    for (const [i, seed] of seeds.entries()) {
      expect(extractEntry(packBytes, parsed.entries[i])).toEqual(seed.bytes)
    }

    const row = harness.raw.prepare('SELECT * FROM pack_index').get() as {
      min_cursor: number
      max_cursor: number
      item_count: number
      byte_size: number
      item_kind: string
    }
    expect(row.min_cursor).toBe(1)
    expect(row.max_cursor).toBe(2)
    expect(row.item_count).toBe(2)
    expect(row.item_kind).toBe('record')
  })

  it('is idempotent on rerun: no duplicate rows, no rewrite, stable bytes', async () => {
    await seedRecord({ cursor: 1 })
    const first = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'record'
    )
    const before = await packOf(first.packKey)

    const second = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'record'
    )
    expect(second.built).toBe(false)
    const after = await packOf(first.packKey)
    expect(after).toEqual(before) // immutability: rerun never rewrites
    expect(
      (harness.raw.prepare('SELECT COUNT(*) c FROM pack_index').get() as { c: number }).c
    ).toBe(1)
  })

  // #5227, #5228: the push nudge packs records and snapshots. Updates wait for
  // the cron tick and its minimum fill (protocol 08 §8.14, REVIEW-5260).
  it('builds record and snapshot packs for a vault and leaves updates to the cron tick', async () => {
    await seedRecord({ cursor: 1 })
    seedSnapshot('note-a', 1000)
    harness.raw
      .prepare(
        `INSERT INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at, server_cursor)
         VALUES ('u1', ?, ?, 'note-a', ?, 1, 'device-1', 1000, 2)`
      )
      .run(USER, VAULT, Buffer.from([1, 2, 3]))

    const results = await compactVault(harness.db, storage, { userId: USER, vaultId: VAULT })

    expect(results.every((result) => result.built)).toBe(true)
    const kinds = harness.raw
      .prepare('SELECT item_kind FROM pack_index ORDER BY item_kind')
      .all() as Array<{ item_kind: string }>
    expect(kinds.map((row) => row.item_kind)).toEqual(['crdt_snapshot', 'record'])
  })

  // #5227: content-addressed keys make a replaced payload 404, but a pre-#1199
  // row keeps a stable key. Bytes that are not the selected row's version must
  // never sit beside that row's signature and clock.
  it('skips a record whose payload no longer hashes to the selected row', async () => {
    const stale = await seedRecord({
      cursor: 1,
      blobKey: `${USER}/vaults/${VAULT}/items/task/item-1`
    })
    const kept = await seedRecord({ cursor: 2 })
    await storage.put(stale.blobKey, new Uint8Array(stale.bytes.byteLength).fill(1).buffer)

    const result = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'record'
    )

    expect(result.holes).toEqual(['task:item-1'])
    const packBytes = await packOf(result.packKey)
    const parsed = await parsePack(packBytes)
    expect(parsed.entries.map((e) => e.id)).toEqual(['task:item-2'])
    expect(extractEntry(packBytes, parsed.entries[0])).toEqual(kept.bytes)
  })

  // #5227: protocol 08 §8.4.2 — no payload, no entry; and an entry POST
  // /sync/pull would not serve, or no reader accepts, stays item-granular.
  it('leaves out rows that cannot be a record entry and still moves past them', async () => {
    await seedRecord({ cursor: 1 })
    harness.raw
      .prepare(
        `UPDATE sync_items SET blob_key = '', content_hash = '', signature = '', size_bytes = 0
         WHERE server_cursor = 1`
      )
      .run()
    await seedRecord({ cursor: 2, type: 'not_a_record_type' })
    await seedRecord({ cursor: 3, signerDeviceId: null })
    await seedRecord({ cursor: 4, clock: '{corrupt' })
    const wideClock = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`device-${i}`, i]))
    await seedRecord({ cursor: 5, clock: JSON.stringify(wideClock) })
    await seedRecord({ cursor: 6, deleted: true })

    const result = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'record'
    )

    const parsed = await parsePack(await packOf(result.packKey))
    expect(parsed.entries.map((e) => e.id)).toEqual(['task:item-6'])
    expect(parsed.entries[0].meta).toEqual({
      operation: 'delete',
      cryptoVersion: 1,
      signature: 'sig',
      signerDeviceId: 'device-1',
      deletedAt: expect.any(Number),
      clock: { 'device-1': 6 }
    })
    expect(watermarkOf('record')?.last_sort_value).toBe(6)
  })

  it('tolerates holes where source blobs vanished mid-flight', async () => {
    const kept = await seedRecord({ cursor: 1 })
    const dangling = await seedRecord({ cursor: 2 })
    // Simulate replaced-and-cleaned-up blob: row exists, object gone.
    await storage.delete(dangling.blobKey)

    const result = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'record'
    )
    expect(result.built).toBe(true)
    expect(result.holes).toEqual(['task:item-2'])

    const packBytes = await packOf(result.packKey)
    const parsed = await parsePack(packBytes)
    // The hole is simply absent from the index block; the survivor is intact.
    expect(parsed.entries.map((e) => e.id)).toEqual(['task:item-1'])
    expect(extractEntry(packBytes, parsed.entries[0])).toEqual(kept.bytes)
  })

  it('tolerates a vanished blob in a NON-FINAL slot of the range', async () => {
    const dangling = await seedRecord({ cursor: 1 })
    const kept = await seedRecord({ cursor: 2 })
    // The hole is slot 0, not the trailing slot: the writer must be advanced
    // past it explicitly. Leaving it unclaimed makes the NEXT entry violate
    // the plan-order invariant, and that throw escapes before the watermark
    // moves — the queue drops the message, the cron backfill re-selects the
    // identical range forever, and the vault never packs again.
    await storage.delete(dangling.blobKey)

    const result = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'record'
    )
    expect(result.built).toBe(true)
    expect(result.holes).toEqual(['task:item-1'])
    expect(result.itemCount).toBe(1)

    const packBytes = await packOf(result.packKey)
    const parsed = await parsePack(packBytes)
    expect(parsed.entries.map((e) => e.id)).toEqual(['task:item-2'])
    expect(extractEntry(packBytes, parsed.entries[0])).toEqual(kept.bytes)
    // Progress is the point: the range must never be re-driven.
    expect(watermarkOf('record')?.last_sort_value).toBe(2)
  })

  it('degrades a zero-length source blob to a hole instead of throwing', async () => {
    // size_bytes 0 slips past the drift guard (0 === 0) and reaches
    // writeEntry, which rejects an empty entry. That throw escapes before the
    // watermark moves, so the queue drops the message and the cron re-selects
    // the identical range forever — the same permanent stall a non-final hole
    // used to cause. Slot 0 again, so the writer must also be advanced past it.
    await seedRecord({ cursor: 1, bytes: new Uint8Array(0) })
    const kept = await seedRecord({ cursor: 2 })

    const result = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'record'
    )
    expect(result.built).toBe(true)
    expect(result.holes).toEqual(['task:item-1'])
    expect(result.itemCount).toBe(1)

    const packBytes = await packOf(result.packKey)
    const parsed = await parsePack(packBytes)
    expect(parsed.entries.map((e) => e.id)).toEqual(['task:item-2'])
    expect(extractEntry(packBytes, parsed.entries[0])).toEqual(kept.bytes)
    expect(watermarkOf('record')?.last_sort_value).toBe(2)
  })

  it('degrades declared-vs-actual size drift to a hole instead of throwing', async () => {
    // Snapshot blob keys are STABLE per note and overwritten in place on every
    // push, so a push landing between selection (which sized the pack buffer
    // from D1 size_bytes) and the R2 GET returns bytes of a different length
    // than declared. Copying them would misalign the layout, so drift degrades
    // to a hole exactly like a vanished blob — and, sitting in slot 0 here, it
    // must also advance the writer past its slot.
    seedSnapshot('note-a', 1000) // 24 declared bytes
    const kept = seedSnapshot('note-b', 1001)
    await storage.put(
      `${USER}/vaults/${VAULT}/crdt/note-a/snapshot`,
      new Uint8Array(25).fill(9).buffer
    )

    const result = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'crdt_snapshot'
    )
    expect(result.built).toBe(true)
    expect(result.holes).toEqual(['note-a'])
    expect(result.itemCount).toBe(1)

    const packBytes = await packOf(result.packKey)
    const parsed = await parsePack(packBytes) // checksums still verify
    expect(parsed.entries.map((e) => e.id)).toEqual(['note-b'])
    expect(extractEntry(packBytes, parsed.entries[0])).toEqual(kept)
    expect(watermarkOf('crdt_snapshot')?.last_sort_value).toBe(1001)
  })

  it('packs snapshots with freshness metadata in the index block', async () => {
    const snapA = seedSnapshot('note-a', 1700000001, 4)
    const snapB = seedSnapshot('note-b', 1700000002, 9)

    const result = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'crdt_snapshot'
    )
    expect(result.built).toBe(true)

    const bytes = await packOf(result.packKey)
    const parsed = await parsePack(bytes)
    expect(parsed.entries[0].meta).toEqual({ sequenceNum: 4, revision: 'rev-note-a-4' })
    expect(parsed.entries[1].meta).toEqual({ sequenceNum: 9, revision: 'rev-note-b-9' })
    expect(extractEntry(bytes, parsed.entries[0])).toEqual(snapA)
    expect(extractEntry(bytes, parsed.entries[1])).toEqual(snapB)
  })

  // A deleted note's body rows pack while they exist; the purge removes the rows
  // and drops the packs (protocol 08 §8.10, REVIEW-5267).
  it('packs the snapshots of deleted notes while their rows exist', async () => {
    await seedRecord({ cursor: 1, type: 'note', id: 'note-deleted', deleted: true })
    await seedRecord({ cursor: 2, type: 'journal', id: 'note-retyped', deleted: true })
    await seedRecord({ cursor: 3, type: 'note', id: 'note-retyped' })
    await seedRecord({ cursor: 4, type: 'note', id: 'note-live' })
    seedSnapshot('note-deleted', 1000)
    seedSnapshot('note-retyped', 1001)
    seedSnapshot('note-live', 1002)
    seedSnapshot('note-record-pending', 1003)

    const result = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'crdt_snapshot'
    )

    const parsed = await parsePack(await packOf(result.packKey))
    expect(parsed.entries.map((e) => e.id)).toEqual([
      'note-deleted',
      'note-retyped',
      'note-live',
      'note-record-pending'
    ])
    expect(watermarkOf('crdt_snapshot')).toEqual({
      last_sort_value: 1003,
      last_sort_tiebreak: 'note-record-pending'
    })
  })

  it('advances watermarks per kind without cross-kind interference', async () => {
    await seedRecord({ cursor: 10 })
    seedSnapshot('note-z', 5000)
    await compactOneRange(harness.db, storage, { userId: USER, vaultId: VAULT }, 'record')
    await compactOneRange(harness.db, storage, { userId: USER, vaultId: VAULT }, 'crdt_snapshot')
    expect(watermarkOf('record')?.last_sort_value).toBe(10)
    expect(watermarkOf('crdt_snapshot')?.last_sort_value).toBe(5000)
    expect(
      (
        harness.raw
          .prepare('SELECT COUNT(*) c FROM pack_index WHERE item_kind = ?')
          .get('crdt_snapshot') as { c: number }
      ).c
    ).toBe(1)
  })

  it('makes a raw duplicate range insert a no-op with a stable row id', async () => {
    // compactOneRange's pre-read gate normally shields the INSERT from ever
    // seeing a duplicate; drive the conflict path directly instead.
    await seedRecord({ cursor: 1 })
    await seedRecord({ cursor: 2 })
    const built = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'record'
    )
    const before = harness.raw.prepare('SELECT id FROM pack_index').get() as { id: string }

    await insertPackIndexRow(
      harness.db,
      { userId: USER, vaultId: VAULT },
      'record',
      built.packKey!,
      built.minSortValue,
      built.maxSortValue,
      built.itemCount,
      built.byteSize
    )

    const rows = harness.raw
      .prepare('SELECT id, min_cursor, max_cursor FROM pack_index')
      .all() as Array<{
      id: string
      min_cursor: number
      max_cursor: number
    }>
    // DO NOTHING keeps the ORIGINAL row: exactly one row, same id — so the
    // listPacks pagination cursor (`maxCursor:id`) cannot churn on retries.
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(before.id)
    expect(rows[0].min_cursor).toBe(built.minSortValue)
    expect(rows[0].max_cursor).toBe(built.maxSortValue)
  })

  it('assembles a target-size window in one buffer without doubling allocation', async () => {
    // Three 8MB records sum to exactly PACK_TARGET_BYTES (24MB): the largest
    // window selection can produce.
    const MB = 1024 * 1024
    for (let cursor = 1; cursor <= 3; cursor++) {
      await seedRecord({ cursor, bytes: new Uint8Array(8 * MB).fill(cursor) })
    }

    const RealUint8Array = globalThis.Uint8Array
    const largeAllocations: number[] = []
    class CountingUint8Array extends RealUint8Array {
      // Pass-through constructor: all real overloads collapse here and are
      // re-spread verbatim (the one-element tuple type satisfies tsc; the
      // runtime array still carries every argument through). Only numeric
      // lengths are size-trackable.
      constructor(a?: number | ArrayLike<number> | ArrayBufferLike, b?: number, c?: number) {
        super(...([a, b, c] as unknown as [number]))
        if (typeof a === 'number' && a >= MB) largeAllocations.push(a)
      }
    }
    globalThis.Uint8Array = CountingUint8Array as unknown as typeof Uint8Array
    try {
      const result = await compactOneRange(
        harness.db,
        storage,
        { userId: USER, vaultId: VAULT },
        'record'
      )
      expect(result.built).toBe(true)
      expect(result.itemCount).toBe(3)
      expect(result.byteSize).toBe(PACK_TARGET_BYTES)

      // Single-buffer invariant: EXACTLY ONE megabyte-scale allocation happens
      // during the build — the pack buffer itself, sized once from D1-declared
      // sizes before any fetch. Source blobs arrive as ArrayBuffers (unseen by
      // this spy) but are copied in and released one transient entry at a
      // time, so they never compound into a second payload-scale allocation.
      expect(largeAllocations).toHaveLength(1)
      expect(largeAllocations[0]).toBeGreaterThanOrEqual(result.byteSize)

      // The assembled file still parses with intact contents.
      const parsed = await parsePack(await packOf(result.packKey))
      expect(parsed.entries.map((e) => e.sortKey)).toEqual([1, 2, 3])
    } finally {
      globalThis.Uint8Array = RealUint8Array
    }
  })
})

describe('min_cursor collision (#5229 P6)', () => {
  const SCOPE = { userId: USER, vaultId: VAULT }
  const listedRows = () =>
    harness.raw.prepare('SELECT pack_key, item_count FROM pack_index').all() as Array<{
      pack_key: string
      item_count: number
    }>

  // A tie group larger than one window: the second window starts in the
  // second the listed pack starts in. The watermark used to pass its rows.
  it('rolls the listed pack and its new rows into one pack', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `note-${String(i).padStart(3, '0')}`)
    for (const id of ids) seedSnapshot(id, 1000)
    expect((await compactOneRange(harness.db, storage, SCOPE, 'crdt_snapshot')).itemCount).toBe(256)
    const [first] = listedRows()

    const second = await compactOneRange(harness.db, storage, SCOPE, 'crdt_snapshot')

    expect(second.built).toBe(true)
    expect(listedRows()).toEqual([{ pack_key: second.packKey, item_count: 300 }])
    const packed = await parsePack(await packOf(second.packKey))
    expect(packed.entries.map((entry) => entry.id)).toEqual(ids)
    expect(watermarkOf('crdt_snapshot')).toEqual({
      last_sort_value: 1000,
      last_sort_tiebreak: 'note-299'
    })
    // The old object waits out the grace period of a replaced pack.
    expect(
      harness.raw.prepare('SELECT pack_key, replaced_by FROM pack_replaced_objects').all()
    ).toEqual([
      {
        pack_key: first.pack_key,
        replaced_by: harness.raw.prepare('SELECT id FROM pack_index').pluck().get()
      }
    ])
  })

  // REVIEW-5277 P1, P2: a snapshot collision the build could not roll in held
  // the watermark for good, re-downloading the colliding pack every message.
  it.each([
    ['full', false],
    ['unreadable', true]
  ])('packs later seconds after a %s colliding snapshot pack', async (_, unreadable) => {
    const MB = 1024 * 1024
    const big = (fill: number) => new Uint8Array(unreadable ? 24 : 8 * MB).fill(fill)
    for (const [i, id] of ['note-a', 'note-b', 'note-c'].entries())
      seedSnapshot(id, 1000, 1, big(i + 1))
    expect((await compactOneRange(harness.db, storage, SCOPE, 'crdt_snapshot')).built).toBe(true)
    const [colliding] = listedRows()
    if (unreadable) await storage.delete(colliding.pack_key)
    seedSnapshot('note-d', 1000)
    for (let i = 0; i < 10; i++) seedSnapshot(`late-${i}`, 2000 + i)
    const get = vi.spyOn(storage, 'get')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    for (let run = 0; run < 3; run++)
      await compactOneRange(harness.db, storage, SCOPE, 'crdt_snapshot')

    expect(watermarkOf('crdt_snapshot')).toEqual({
      last_sort_value: 2009,
      last_sort_tiebreak: 'late-9'
    })
    expect(listedRows()).toHaveLength(2)
    expect(get.mock.calls.filter(([key]) => key === colliding.pack_key)).toHaveLength(1)
    expect(errors).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('holds the watermark when the listed record pack it collides with is unreadable', async () => {
    await seedRecord({ cursor: 1 })
    await compactOneRange(harness.db, storage, SCOPE, 'record')
    harness.raw
      .prepare(
        `INSERT INTO pack_index (id, user_id, vault_id, pack_key, item_kind, min_cursor, max_cursor, item_count, byte_size, created_at)
         VALUES ('squat', ?, ?, 'gone', 'record', 2, 2, 1, 1, 1)`
      )
      .run(USER, VAULT)
    await seedRecord({ cursor: 2 })

    expect((await compactOneRange(harness.db, storage, SCOPE, 'record')).built).toBe(false)
    expect(watermarkOf('record')?.last_sort_value).toBe(1)
  })
})
