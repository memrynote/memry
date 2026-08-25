import { createLogger } from '../lib/logger'
import { openPack, type PackEntryMeta, type PackEntryPlan, type PackKindName } from './pack-format'

const logger = createLogger('PackCompaction')

/**
 * Compaction core for the pack pipeline (#1839): select un-packed source
 * blobs for one user+vault+kind, fetch their EXACT bytes, concat into one
 * immutable pack, record it in D1, advance the watermark.
 *
 * DERIVED CACHE semantics — individual blobs stay the source of truth. This
 * module deletes nothing, invalidates nothing, and never touches quota:
 * replaced/deleted items simply remain as dead bytes inside old packs.
 * Every step tolerates a retry (at-least-once queue delivery):
 *
 *   1. selection reads the watermark  -> same range re-selected after a crash
 *   2. the pack key is DETERMINISTIC  -> a retry PUTs identical bytes to the
 *      same object (R2 put is idempotent)
 *   3. the pack_index row carries UNIQUE (user_id, vault_id, item_kind,
 *      min_cursor) -> a duplicate insert is a no-op
 *   4. order is pack PUT first, then D1 row, then watermark -> an orphan pack
 *      object (crash between 2 and 3) is harmless invisible bytes; a missing
 *      watermark row only causes an idempotent rebuild
 *
 * ORPHAN DOCTRINE, hole-only windows: a window whose every source blob
 * vanished mid-flight still advances its watermark WITHOUT writing a
 * pack_index row. If an earlier attempt of that same range crashed after its
 * PUT but before its D1 row, the object it left at the deterministic key now
 * has no row pointing at it and can never be listed — permanent dead bytes.
 * Harmless today (derived cache; the key gets rewritten if the range is ever
 * rebuilt), but it is the concrete case a future cleanup sweep should cover:
 * list packs/<kind>/ objects with no matching pack_index row and delete them.
 */

// ---------------------------------------------------------------------------
// Tuning constants — see the subrequest arithmetic below before touching
// ---------------------------------------------------------------------------

// Target payload size per pack. Workers isolates hard-cap at 128MB of memory,
// and assembly needs one contiguous buffer for the whole file plus one
// transient source blob while it is being copied in. A 64MB target left no
// safe headroom even after the single-buffer rewrite (buffer + an 8MB item +
// isolate baseline); 24MB keeps peak ≈ 24MB + ≤8MB + slack, comfortably under
// the cap. Smaller packs just mean more packs per vault — packs are cheap
// (one PUT + one row each), so coverage granularity is the only trade.
export const PACK_TARGET_BYTES = 24 * 1024 * 1024

// Absolute ceiling on one pack's payload bytes. Selection stops BEFORE
// crossing PACK_TARGET_BYTES, which is structurally far below this bound;
// PACK_HARD_MAX_BYTES remains as a documented tuning guard so nobody can
// raise the target back into isolate-unsafe territory without confronting it.
// A single oversized item cannot push past either because such items are
// excluded from packs entirely (see MAX_PACKED_ITEM_BYTES).
export const PACK_HARD_MAX_BYTES = 32 * 1024 * 1024

// Max items per pack build.
//
// SUBREQUEST ARITHMETIC (paid plan: 1000 subrequests per invocation):
//   N R2 GETs (one per item blob, N ≤ 256)
// + 1 R2 PUT  (the pack itself)
// + 5 D1 round trips (watermark read, candidate select, duplicate check,
//   pack_index insert, watermark upsert)
// + up to ⌈256/40⌉ = 7 D1 chunk reads loading snapshot freshness metadata
// => ~269 subrequests per full 256-item pack (~27% of the ceiling). Two kinds
// compacted back-to-back in one invocation still fit (~540), and a full retry
// doubles safely. The free plan's 50-subrequest ceiling cannot fit ANY pack;
// compaction has always been a paid-plan background job by construction.
export const PACK_MAX_ITEMS = 256

// Items larger than this never enter packs (they stay item-granular tail):
// the largest legal record payload is ~7MB of JSON text (5MB decoded
// encryptedData inflated by base64 + envelope), and snapshots cap at 5MB.
// Excluding anything near that bound keeps one item from dominating a pack
// and keeps memory during the bounded-concurrency fetch predictable.
export const MAX_PACKED_ITEM_BYTES = 8 * 1024 * 1024

// Simultaneous source-blob GETs while building one pack. Mirrors the pull
// path's R2_CONCURRENCY reasoning: bounded windows keep connection pressure
// flat without meaningfully stretching wall time. Subrequest COUNT is
// unaffected — this only shapes concurrency, not budget.
export const PACK_FETCH_CONCURRENCY = 16

/** Kinds whose sources live in R2 and are packed today. */
export const PACKED_KINDS: readonly PackKindName[] = ['record', 'crdt_snapshot']

export interface VaultScope {
  userId: string
  vaultId: string
}

interface WatermarkRow {
  last_sort_value: number
  last_sort_tiebreak: string
}

export interface PackSelection {
  candidates: Array<{
    sortKey: number
    tiebreak: string
    id: string
    sourceKey: string
    sizeBytes: number
  }>
  /** Progress marker AFTER the last candidate (composite, exclusive). */
  nextSortValue: number
  nextTiebreak: string
}

/**
 * Read the composite progress marker for a scope+kind. Everything strictly
 * BELOW it (row-value comparison on (sort_value, tiebreak)) is already packed
 * or deliberately skipped; everything above is eligible.
 */
export const readWatermark = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName
): Promise<WatermarkRow> => {
  const row = await db
    .prepare(
      'SELECT last_sort_value, last_sort_tiebreak FROM pack_watermarks WHERE user_id = ? AND vault_id = ? AND item_kind = ?'
    )
    .bind(scope.userId, scope.vaultId, kind)
    .first<WatermarkRow>()
  return row ?? { last_sort_value: 0, last_sort_tiebreak: '' }
}

/**
 * Select up to PACK_MAX_ITEMS un-packed rows ordered ascending, capped so the
 * projected payload stays within PACK_TARGET_BYTES (itself far below
 * PACK_HARD_MAX_BYTES).
 *
 * Ordering keys: records use server_cursor (strictly monotonic per user, so
 * no ties); crdt kinds use created_at epoch seconds, which TIE heavily — the
 * tiebreak column (note_id / type:id) makes progress exact via a row-value
 * comparison instead of skipping or looping on tie groups.
 */
export const selectCandidates = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName
): Promise<PackSelection> => {
  const watermark = await readWatermark(db, scope, kind)

  const query =
    kind === 'record'
      ? {
          sql: `SELECT server_cursor AS sort_key, item_type || ':' || item_id AS tiebreak, item_type, item_id, blob_key, size_bytes
                FROM sync_items
                WHERE user_id = ? AND vault_id = ?
                  AND (server_cursor > ? OR (server_cursor = ? AND (item_type || ':' || item_id) > ?))
                ORDER BY server_cursor ASC, tiebreak ASC
                LIMIT ?`,
          bind: [
            scope.userId,
            scope.vaultId,
            watermark.last_sort_value,
            watermark.last_sort_value,
            watermark.last_sort_tiebreak,
            PACK_MAX_ITEMS
          ]
        }
      : {
          sql: `SELECT created_at AS sort_key, note_id AS tiebreak, note_id, blob_key, size_bytes
                FROM crdt_snapshots
                WHERE user_id = ? AND vault_id = ?
                  AND (created_at > ? OR (created_at = ? AND note_id > ?))
                ORDER BY created_at ASC, note_id ASC
                LIMIT ?`,
          bind: [
            scope.userId,
            scope.vaultId,
            watermark.last_sort_value,
            watermark.last_sort_value,
            watermark.last_sort_tiebreak,
            PACK_MAX_ITEMS
          ]
        }

  const rows = await db
    .prepare(query.sql)
    .bind(...query.bind)
    .all<{
      sort_key: number
      tiebreak: string
      blob_key: string
      size_bytes: number
    }>()

  const candidates: PackSelection['candidates'] = []
  let bytes = 0
  for (const row of rowList(rows)) {
    if (row.size_bytes > MAX_PACKED_ITEM_BYTES) continue // oversized: permanent item-granular tail
    if (bytes + row.size_bytes > PACK_TARGET_BYTES) break
    bytes += row.size_bytes
    candidates.push({
      sortKey: row.sort_key,
      tiebreak: row.tiebreak,
      id: row.tiebreak,
      sourceKey: row.blob_key,
      sizeBytes: row.size_bytes
    })
  }

  const last = candidates[candidates.length - 1]
  if (!last) {
    // Nothing selectable above the watermark. Only advance when the scan
    // actually saw rows (an all-oversized window must progress past itself);
    // an empty scan means "nothing to do" and the watermark must stay put —
    // writing 0 here would reset progress and force pointless re-scans.
    const scanned = rowList(rows)
    return {
      candidates,
      nextSortValue: scanned.length > 0 ? maxScannedSortKey(scanned) : watermark.last_sort_value,
      nextTiebreak:
        scanned.length > 0
          ? maxScannedTiebreakAt(scanned, maxScannedSortKey(scanned))
          : watermark.last_sort_tiebreak
    }
  }
  return {
    candidates,
    nextSortValue: last.sortKey,
    nextTiebreak: last.tiebreak
  }
}

const rowList = <T>(result: { results?: T[] }): T[] => result.results ?? []

const maxScannedSortKey = (rows: Array<{ sort_key: number }>): number =>
  rows.reduce((max, row) => Math.max(max, row.sort_key), 0)

const maxScannedTiebreakAt = (
  rows: Array<{ sort_key: number; tiebreak: string }>,
  sortKey: number
): string =>
  rows
    .filter((row) => row.sort_key === sortKey)
    .reduce((max, row) => (row.tiebreak > max ? row.tiebreak : max), '')

/** Deterministic, collision-free pack object key for one range. */
export const packObjectKey = (
  scope: VaultScope,
  kind: PackKindName,
  minSortValue: number,
  maxSortValue: number
): string =>
  // Lives under the vault prefix, so vault deletion's prefix purge reaches it.
  `${scope.userId}/vaults/${scope.vaultId}/packs/${kind}/${minSortValue}_${maxSortValue}.pack`

export interface PackBuildResult {
  built: boolean
  packKey: string | null
  itemCount: number
  byteSize: number
  minSortValue: number
  maxSortValue: number
  /** Entries skipped because their source blob vanished mid-flight. */
  holes: string[]
}

/**
 * Compact ONE range for one scope+kind end-to-end. Idempotent: re-running an
 * already-built range detects the existing pack_index row and only backfills
 * bookkeeping (never rewrites R2 bytes — packs are immutable once written).
 */
export const compactOneRange = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope,
  kind: PackKindName
): Promise<PackBuildResult> => {
  const selection = await selectCandidates(db, scope, kind)
  const noop: PackBuildResult = {
    built: false,
    packKey: null,
    itemCount: 0,
    byteSize: 0,
    minSortValue: selection.nextSortValue,
    maxSortValue: selection.nextSortValue,
    holes: []
  }
  if (selection.candidates.length === 0) {
    // Still persist watermark advancement so oversized-only windows progress.
    await advanceWatermark(db, scope, kind, selection.nextSortValue, selection.nextTiebreak)
    return noop
  }

  const minSortValue = selection.candidates[0].sortKey
  const maxSortValue = selection.candidates[selection.candidates.length - 1].sortKey
  const packKey = packObjectKey(scope, kind, minSortValue, maxSortValue)

  // Idempotency gate: a row for this exact range means a previous attempt
  // finished (or at least published). Never rewrite the object — immutability.
  const existing = await db
    .prepare(
      'SELECT id FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = ? AND min_cursor = ?'
    )
    .bind(scope.userId, scope.vaultId, kind, minSortValue)
    .first<{ id: string }>()
  if (existing) {
    await advanceWatermark(db, scope, kind, selection.nextSortValue, selection.nextTiebreak)
    return { ...noop, built: false, packKey }
  }

  // Snapshot freshness metadata is read BEFORE any byte fetch. Order matters:
  // if a push lands mid-build it can now only make the fetched BYTES newer
  // than the advertised meta — a client comparing revisions under-trusts the
  // pack and falls back to the item GET (safe direction). The old bytes-first
  // order could advertise NEWER meta than the packed bytes, defeating the
  // client's freshness check entirely. Looked up in one batched pass,
  // best-effort: a missed lookup leaves meta empty and the client falls back
  // to the item GET.
  let metaBySourceKey: Map<string, PackEntryMeta> | null = null
  if (kind === 'crdt_snapshot') {
    metaBySourceKey = await loadSnapshotMeta(
      db,
      scope,
      selection.candidates.map((candidate) => candidate.sourceKey)
    )
  }

  // Plans carry everything known pre-fetch. Declared sizes come from D1 rows,
  // so openPack sizes its ONE buffer exactly here — before a single byte is
  // fetched — making peak memory knowable: buffer + one transient entry.
  const plans: PackEntryPlan[] = selection.candidates.map((candidate) => {
    const plan: PackEntryPlan = {
      kind,
      id: candidate.id,
      sourceKey: candidate.sourceKey,
      sortKey: candidate.sortKey,
      sizeBytes: candidate.sizeBytes
    }
    const meta = metaBySourceKey?.get(candidate.sourceKey)
    if (meta) plan.meta = meta
    return plan
  })

  const pack = openPack(plans)

  // Fetch source bytes verbatim, bounded concurrency, preserving order, and
  // stream each straight into the pack buffer. Every iteration releases its
  // source references (`body`, `bytes` go out of scope) after the copy —
  // payload bytes are never retained twice, so peak stays at the pack buffer
  // plus ONE transient blob rather than payload + assembled copy.
  const holes: string[] = []
  let writtenCount = 0
  for (let i = 0; i < plans.length; i += PACK_FETCH_CONCURRENCY) {
    const window = plans.slice(i, i + PACK_FETCH_CONCURRENCY)
    const bodies = await Promise.all(window.map((plan) => storage.get(plan.sourceKey)))
    for (let j = 0; j < window.length; j++) {
      const plan = window[j]
      const body = bodies[j]
      // A null body is a HOLE, not a failure: the blob was replaced/deleted
      // between selection and fetch (or is a dangling row). Membership is
      // verified against the index block client-side; dead ranges fall back
      // to item GETs.
      if (!body) {
        // skipEntry, not a bare `continue`: the writer claims slots in strict
        // plan order, so an unclaimed slot makes the NEXT writeEntry throw and
        // abort the whole range before the watermark moves.
        pack.skipEntry(plan)
        holes.push(plan.id)
        continue
      }
      const bytes = new Uint8Array(await body.arrayBuffer())
      if (bytes.byteLength !== plan.sizeBytes) {
        // Declared-vs-actual drift: the blob was replaced under a stable key
        // after selection sized this pack's buffer. Copying it would overrun
        // or misalign the layout, so treat it exactly like a vanished blob —
        // skip, let the client fall back to the item GET (individual blobs
        // remain the source of truth). Nothing has been persisted yet, so
        // skipping is side-effect-free.
        logger.warn('pack entry drifted from declared size; skipping', {
          userId: scope.userId,
          vaultId: scope.vaultId,
          kind,
          id: plan.id,
          declared: plan.sizeBytes,
          actual: bytes.byteLength
        })
        pack.skipEntry(plan)
        holes.push(plan.id)
        continue
      }
      await pack.writeEntry(plan, bytes)
      writtenCount++
    }
  }

  if (writtenCount === 0) {
    await advanceWatermark(db, scope, kind, selection.nextSortValue, selection.nextTiebreak)
    return { ...noop, holes }
  }

  const built = await pack.finish()

  // Order matters: OBJECT FIRST, then D1 row, then watermark (module doc).
  // built.bytes is the single assembly buffer trimmed to file length — there
  // is no second full-size allocation anywhere in this flow.
  await storage.put(packKey, built.bytes)

  await insertPackIndexRow(
    db,
    scope,
    kind,
    packKey,
    minSortValue,
    maxSortValue,
    built.entries.length,
    built.payloadBytes
  )

  await advanceWatermark(db, scope, kind, selection.nextSortValue, selection.nextTiebreak)

  logger.info('pack built', {
    userId: scope.userId,
    vaultId: scope.vaultId,
    kind,
    items: built.entries.length,
    holes: holes.length,
    payloadBytes: built.payloadBytes
  })

  return {
    built: true,
    packKey,
    itemCount: built.entries.length,
    byteSize: built.payloadBytes,
    minSortValue,
    maxSortValue,
    holes
  }
}

/**
 * Range-level pack_index row; the composite conflict target makes a
 * concurrent/retried duplicate a no-op rather than a constraint error that
 * would poison queue retries. Exported so tests can drive the INSERT path
 * directly (compactOneRange's pre-read gate would otherwise shield it).
 */
export const insertPackIndexRow = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName,
  packKey: string,
  minSortValue: number,
  maxSortValue: number,
  itemCount: number,
  byteSize: number
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO pack_index (id, user_id, vault_id, pack_key, item_kind, min_cursor, max_cursor, item_count, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, vault_id, item_kind, min_cursor) DO NOTHING`
    )
    .bind(
      crypto.randomUUID(),
      scope.userId,
      scope.vaultId,
      packKey,
      kind,
      minSortValue,
      maxSortValue,
      itemCount,
      byteSize,
      Math.floor(Date.now() / 1000)
    )
    .run()
}

const advanceWatermark = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName,
  sortValue: number,
  tiebreak: string
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO pack_watermarks (user_id, vault_id, item_kind, last_sort_value, last_sort_tiebreak, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, vault_id, item_kind) DO UPDATE SET
         last_sort_value = excluded.last_sort_value,
         last_sort_tiebreak = excluded.last_sort_tiebreak,
         updated_at = excluded.updated_at`
    )
    .bind(scope.userId, scope.vaultId, kind, sortValue, tiebreak, Math.floor(Date.now() / 1000))
    .run()
}

const loadSnapshotMeta = async (
  db: D1Database,
  scope: VaultScope,
  sourceKeys: string[]
): Promise<Map<string, PackEntryMeta>> => {
  const meta = new Map<string, PackEntryMeta>()
  // 95-bind split mirrors sync.ts/crdt.ts: user_id + vault_id ride along, and
  // blob keys are long — keep chunks comfortably under the D1 100-bind ceiling.
  const CHUNK = 40
  for (let i = 0; i < sourceKeys.length; i += CHUNK) {
    const chunk = sourceKeys.slice(i, i + CHUNK)
    const rows = await db
      .prepare(
        `SELECT blob_key, sequence_num, revision FROM crdt_snapshots
         WHERE user_id = ? AND vault_id = ? AND blob_key IN (${chunk.map(() => '?').join(', ')})`
      )
      .bind(scope.userId, scope.vaultId, ...chunk)
      .all<{ blob_key: string; sequence_num: number; revision: string }>()
    for (const row of rowList(rows)) {
      meta.set(row.blob_key, { sequenceNum: row.sequence_num, revision: row.revision })
    }
  }
  return meta
}

/**
 * Compact every supported kind for one vault. Called by the queue consumer
 * (push-triggered) and the cron-paced backfill alike. A failure mid-kind
 * propagates so the caller can retry; completed kinds keep their watermarks.
 */
export const compactVault = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope
): Promise<PackBuildResult[]> => {
  const results: PackBuildResult[] = []
  for (const kind of PACKED_KINDS) {
    results.push(await compactOneRange(db, storage, scope, kind))
  }
  return results
}

// ---------------------------------------------------------------------------
// Producer helper
// ---------------------------------------------------------------------------

export interface PackCompactionMessageBody {
  userId: string
  vaultId: string
}

/**
 * Enqueue a compaction nudge after a successful push/snapshot commit.
 * Best-effort coalescing: one message per request (not per item); Queues
 * delivers at-least-once and the core is fully idempotent, so duplicates are
 * harmless and a lost message only delays packing until the next nudge or
 * the cron backfill. Absent binding (local dev without queues) degrades to a
 * no-op — compaction is an optimization, never a correctness requirement.
 */
export const enqueuePackCompaction = async (
  env: { PACK_QUEUE?: Queue<PackCompactionMessageBody> },
  scope: VaultScope
): Promise<void> => {
  if (!env.PACK_QUEUE) return
  await env.PACK_QUEUE.send({ userId: scope.userId, vaultId: scope.vaultId })
}
