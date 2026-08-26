import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { PACKED_KINDS,
  PACK_TARGET_BYTES,
  compactOneRange,
  insertPackIndexRow,
  packObjectKey,
  selectCandidates
} from './pack-compaction'
import { extractEntry, parsePack } from './pack-format'

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
}

interface RecordSeedOptions {
  cursor: number
  type?: string
  id?: string
  bytes?: Uint8Array
  deleted?: boolean
}

const seedRecord = (options: RecordSeedOptions): { blobKey: string; bytes: Uint8Array } => {
  const type = options.type ?? 'task'
  const itemId = options.id ?? `item-${options.cursor}`
  // Mirror the push path's payload shape: JSON text of base64 fields. The pack
  // must carry these EXACT bytes.
  const bytes =
    options.bytes ??
    new TextEncoder().encode(JSON.stringify({ encryptedData: 'payload-' + options.cursor }))
  const contentHash = 'hash' + options.cursor
  const blobKey = `${USER}/vaults/${VAULT}/items-v3/${type}/${itemId}/${contentHash}`
  harness.raw
    .prepare(
      `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash, version, crypto_version, operation, server_cursor, signer_device_id, signature, clock, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'update', ?, NULL, 'sig', NULL, 1, 1, ?)`
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
      options.cursor,
      options.deleted ? nowSec() : null
    )
  // The source object must exist exactly as a push would have left it.
  storage.put(blobKey, bytes.slice().buffer as ArrayBuffer)
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
  storage.put(blobKey, bytes.slice().buffer as ArrayBuffer)
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
    for (let cursor = 3; cursor <= 6; cursor++) seedRecord({ cursor })
    const selection = await selectCandidates(harness.db, { userId: USER, vaultId: VAULT }, 'record')
    expect(selection.candidates.map((c) => c.sortKey)).toEqual([3, 4, 5, 6])
  })

  it('excludes already-packed rows via the composite watermark', async () => {
    for (let cursor = 1; cursor <= 5; cursor++) seedRecord({ cursor })
    await compactOneRange(harness.db, storage, { userId: USER, vaultId: VAULT }, 'record')
    const after = await selectCandidates(harness.db, { userId: USER, vaultId: VAULT }, 'record')
    expect(after.candidates).toHaveLength(0)

    // New pushes land above the watermark and become eligible only there.
    seedRecord({ cursor: 6 })
    const next = await selectCandidates(harness.db, { userId: USER, vaultId: VAULT }, 'record')
    expect(next.candidates.map((c) => c.sortKey)).toEqual([6])
  })

  it('skips oversized items but still advances the watermark past them', async () => {
    // 9MB: above MAX_PACKED_ITEM_BYTES (8MB) but allocated without
    // crypto.getRandomValues' 64KiB cap.
    seedRecord({ cursor: 1, bytes: new Uint8Array(9 * 1024 * 1024).fill(7) })
    seedRecord({ cursor: 2 })

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

    // Rerunning compaction does NOT rebuild note-d: the range-level
    // idempotency gate (pack_index UNIQUE on min_cursor) sees min_cursor=1000
    // as already published and refuses further writes for it, advancing the
    // watermark instead. note-d therefore stays an item-granular-tail blob —
    // exactly the snapshot under-coverage documented in pack-list.ts
    // (missed optimization, never lost data).
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
    const seeds = [seedRecord({ cursor: 1 }), seedRecord({ cursor: 2 })]
    const result = await compactOneRange(
      harness.db,
      storage,
      { userId: USER, vaultId: VAULT },
      'record'
    )

    expect(result.built).toBe(true)
    expect(result.packKey).toBe(packObjectKey({ userId: USER, vaultId: VAULT }, 'record', 1, 2))

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
    seedRecord({ cursor: 1 })
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

  it('builds packs for the snapshot axis only', () => {
    // Records are deliberately excluded. A packed record entry is just the
    // encrypted payload blob; its Ed25519 signature, signer device id, vector
    // clock and operation live in the sync_items D1 row and reach a client
    // only through POST /sync/pull. A client cannot verify a packed record, so
    // building them would mint immutable R2 objects nothing can ever read.
    // Re-enabling requires carrying that metadata in the entry meta (free-form
    // JSON, so additive) plus a verifying client apply path.
    expect(PACKED_KINDS).toEqual(['crdt_snapshot'])
  })

  it('tolerates holes where source blobs vanished mid-flight', async () => {
    const kept = seedRecord({ cursor: 1 })
    const dangling = seedRecord({ cursor: 2 })
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
    const dangling = seedRecord({ cursor: 1 })
    const kept = seedRecord({ cursor: 2 })
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
    seedRecord({ cursor: 1, bytes: new Uint8Array(0) })
    const kept = seedRecord({ cursor: 2 })

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
      new Uint8Array(25).fill(9).buffer as ArrayBuffer
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

  it('advances watermarks per kind without cross-kind interference', async () => {
    seedRecord({ cursor: 10 })
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
    seedRecord({ cursor: 1 })
    seedRecord({ cursor: 2 })
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
      seedRecord({ cursor, bytes: new Uint8Array(8 * MB).fill(cursor) })
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
