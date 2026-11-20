import { listRange, type PackBuildResult } from './pack-compaction'
import { watermarkUnchanged, type VaultScope } from './pack-index-write'
import { roomForPack } from './pack-list'
import {
  MAX_PACKED_ITEM_BYTES,
  PACK_MAX_ITEMS,
  readWatermark,
  type PackSelection
} from './pack-selection'
import { PACK_TARGET_BYTES } from './pack-sizing'
import {
  packedSnapshotIds,
  snapshotRemainderQuery,
  snapshotRewritePending,
  snapshotSlot
} from './pack-snapshot-selection'

/**
 * Packs the snapshot rows at or below the watermark that no listed pack holds
 * (D-TIE-REMAINDER, #5310): tie remainders a build before this one passed, and
 * same-second writes that sorted below the watermark. Each one is a
 * per-document GET on every fresh device. The backfill chain runs it once a
 * forward build has nothing left, so existing vaults heal from the cron with
 * no reset. The watermark does not move.
 *
 * The pack starts at the first row's second, or below it when that second
 * starts a listed pack (snapshotSlot), and holds rows up to the next listed
 * pack's second. Its commit holds only while no listed pack holds any of its
 * documents yet, so two runs never pack one remainder twice. Nothing runs
 * while a purge rewrite is pending: that pack's documents are out of the
 * listing until the rewrite lists them back (REVIEW-5315 M1). The commit also
 * holds only while the watermark is the one read, so a kind reset in between
 * leaves the rows to its rebuild (REVIEW-5315 L1).
 */
export const healSnapshotRemainder = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope
): Promise<PackBuildResult> => {
  const noop = {
    built: false,
    packKey: null,
    itemCount: 0,
    byteSize: 0,
    minSortValue: 0,
    maxSortValue: 0,
    holes: []
  }
  if (!(await roomForPack(db, scope))) return { ...noop, reason: 'cap' }
  const vault = [scope.userId, scope.vaultId]
  const pending = await db
    .prepare(`SELECT ${snapshotRewritePending} AS pending`)
    .bind(...vault)
    .first<{ pending: number }>()
  if (pending?.pending) return { ...noop, reason: 'not_ready' }
  const watermark = await readWatermark(db, scope, 'crdt_snapshot')
  const query = snapshotRemainderQuery(scope, watermark, MAX_PACKED_ITEM_BYTES, PACK_MAX_ITEMS)
  const rows =
    (
      await db
        .prepare(query.sql)
        .bind(...query.bind)
        .all<{ sort_key: number; tiebreak: string; blob_key: string; size_bytes: number }>()
    ).results ?? []
  if (rows.length === 0) return { ...noop, reason: 'not_ready' }

  const slot = await snapshotSlot(db, scope, rows[0].sort_key)
  const candidates: PackSelection['candidates'] = []
  let bytes = 0
  for (const row of rows) {
    if (row.sort_key > slot.lastSecond || bytes + row.size_bytes > PACK_TARGET_BYTES) break
    bytes += row.size_bytes
    candidates.push({
      sortKey: row.sort_key,
      tiebreak: row.tiebreak,
      id: row.tiebreak,
      sourceKey: row.blob_key,
      sizeBytes: row.size_bytes
    })
  }
  // Still unpacked, no rewrite pending, and no kind reset since the read.
  const unchanged = watermarkUnchanged(scope, 'crdt_snapshot', watermark)
  const unpacked = {
    sql: `NOT EXISTS (SELECT 1 FROM (${packedSnapshotIds}) packed
      WHERE packed.value IN (SELECT value FROM json_each(?)))
      AND NOT ${snapshotRewritePending} AND ${unchanged.sql}`,
    bind: [...vault, JSON.stringify(candidates.map((row) => row.id)), ...vault, ...unchanged.bind]
  }
  return listRange(db, storage, scope, 'crdt_snapshot', noop, {
    candidates,
    prior: null,
    minSortValue: slot.minCursor,
    coverage: null,
    guard: unpacked,
    advances: false
  })
}
