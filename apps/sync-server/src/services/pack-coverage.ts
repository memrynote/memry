import { createLogger } from '../lib/logger'
import { PACKED_KINDS } from './pack-compaction'
import type { PackKindName } from './pack-format'
import type { VaultScope } from './pack-index-write'
import { COVERED_KINDS } from './pack-list'
import type { PackCompactionMessageBody } from './pack-queue'
import { PACK_MIN_FILL_ROWS, PACK_SETTLE_SECONDS } from './pack-sizing'

const logger = createLogger('PackCoverage')

/**
 * What a bootstrap finds about one vault's pack coverage (#5230), and the
 * compaction it starts when a kind is under-covered. Runs after the bootstrap
 * response, so it costs the client nothing: one D1 batch, and for a kind a
 * build can extend one claim batch and at most one queue send. The coverage the client trusts is the one the listing states
 * (pack-list.ts); this report only explains it and starts the work.
 */

/** Why a kind is not fully covered, for the per-bootstrap log line. */
export type UncoveredReason =
  /** Body kinds: their packs carry no coverage range, readers trust the body manifest. */
  | 'cache_only'
  /** No pack of the kind was ever built. */
  | 'never_packed'
  /** A record chain of cache-only packs, which the next record build re-anchors. */
  | 'unanchored'
  /** Rows above the newest pack's range, served by the feed until a build lists them. */
  | 'tail'

export interface KindCoverage {
  kind: PackKindName
  covered: boolean
  /**
   * Rows of the kind no coverage range holds, the part a client takes item by
   * item, counted up to COVERAGE_COUNT_CAP.
   */
  uncoveredRows: number
  reason?: UncoveredReason
  /**
   * True when this bootstrap enqueued the kind's compaction: a build can
   * extend it and no bootstrap started its chain in the skip window.
   */
  enqueued: boolean
}

interface KindRow {
  has_watermark: number
  anchor: number | null
  uncovered: number
  backlog: number
  oldest: number | null
}

/**
 * The coverage read counts rows only up to here, so it visits at most this
 * many rows per count on every open, whatever the vault's backlog. It is the
 * minimum fill, the largest count the build decision compares against.
 */
export const COVERAGE_COUNT_CAP = PACK_MIN_FILL_ROWS

/**
 * A bootstrap starts a kind's backfill chain at most once per vault in this
 * window. A chain runs at most BACKFILL_MAX_HOPS hops BACKFILL_HOP_DELAY_SECONDS
 * apart, about 11 minutes, so an open within 15 minutes of the last start finds
 * that chain still running or just ended, and the 6-hourly cron picks up what a
 * dropped chain leaves.
 */
export const BOOTSTRAP_ENQUEUE_SKIP_SECONDS = 15 * 60

const SOURCES: Record<PackKindName, { table: string; sort: string; time: string }> = {
  record: { table: 'sync_items', sort: 'server_cursor', time: 'updated_at' },
  crdt_snapshot: { table: 'crdt_snapshots', sort: 'created_at', time: 'created_at' },
  crdt_update: { table: 'crdt_updates', sort: 'server_cursor', time: 'created_at' }
}

/**
 * One row per kind: the watermark's coverage anchor, the rows above it (all
 * rows when it has none), and the build backlog above the watermark with the
 * write time of its first row, the inputs of the minimum fill (pack-sizing.ts).
 * Each count stops at COVERAGE_COUNT_CAP and the first row is one index seek
 * on the sort column, whose order is write order, so the read stays bounded.
 */
const kindStatement = (db: D1Database, scope: VaultScope, kind: PackKindName) => {
  const { table, sort, time } = SOURCES[kind]
  const rows = `FROM ${table} s WHERE s.user_id = ? AND s.vault_id = ?`
  const vault = [scope.userId, scope.vaultId]
  return db
    .prepare(
      `SELECT w.user_id IS NOT NULL AS has_watermark, w.covered_through AS anchor,
         (SELECT COUNT(*) FROM (SELECT 1 ${rows} AND s.${sort} > COALESCE(w.covered_through, 0)
           LIMIT ${COVERAGE_COUNT_CAP})) AS uncovered,
         (SELECT COUNT(*) FROM (SELECT 1 ${rows} AND s.${sort} > COALESCE(w.last_sort_value, 0)
           LIMIT ${COVERAGE_COUNT_CAP})) AS backlog,
         (SELECT s.${time} ${rows} AND s.${sort} > COALESCE(w.last_sort_value, 0)
           ORDER BY s.${sort} LIMIT 1) AS oldest
       FROM (SELECT 1) one
       LEFT JOIN pack_watermarks w ON w.user_id = ? AND w.vault_id = ? AND w.item_kind = ?`
    )
    .bind(...vault, ...vault, ...vault, ...vault, kind)
}

const isCoveredKind = (kind: PackKindName): boolean =>
  COVERED_KINDS.some((covered) => covered === kind)

const assess = (kind: PackKindName, row: KindRow, nowSeconds: number) => {
  const reason: UncoveredReason | undefined = !isCoveredKind(kind)
    ? 'cache_only'
    : !row.has_watermark
      ? 'never_packed'
      : row.anchor === null
        ? 'unanchored'
        : row.uncovered > 0
          ? 'tail'
          : undefined
  // A build lists a pack only past the minimum fill; an unanchored chain is
  // re-anchored by the next build whatever its backlog.
  const buildable =
    row.backlog >= PACK_MIN_FILL_ROWS ||
    (row.oldest !== null && row.oldest <= nowSeconds - PACK_SETTLE_SECONDS) ||
    reason === 'unanchored'
  return { reason, buildable }
}

/**
 * Take the start of each kind's chain for this bootstrap: one upsert per kind
 * that applies only when the kind's last start is older than the skip window,
 * so two opens racing for a kind start it once. Answers the kinds taken.
 */
const claimChainStarts = async (
  db: D1Database,
  scope: VaultScope,
  kinds: PackKindName[],
  now: number
): Promise<Set<PackKindName>> => {
  const results = await db.batch<{ item_kind: PackKindName }>(
    kinds.map((kind) =>
      db
        .prepare(
          `INSERT INTO pack_bootstrap_enqueues (user_id, vault_id, item_kind, enqueued_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, vault_id, item_kind) DO UPDATE SET enqueued_at = excluded.enqueued_at
           WHERE pack_bootstrap_enqueues.enqueued_at <= ?
           RETURNING item_kind`
        )
        .bind(scope.userId, scope.vaultId, kind, now, now - BOOTSTRAP_ENQUEUE_SKIP_SECONDS)
    )
  )
  return new Set(results.flatMap((result) => (result.results ?? []).map((row) => row.item_kind)))
}

/**
 * Log the vault's coverage per kind and start a backfill chain for each kind
 * a build can extend, on PACK_BACKFILL_QUEUE with the chain's later hops
 * (pack-backfill.ts), so a push nudge or a purge retry on PACK_QUEUE never
 * waits behind it. A kind's chain starts at most once per
 * BOOTSTRAP_ENQUEUE_SKIP_SECONDS per vault, and a duplicate is still safe:
 * every build takes its watermark by compare-and-swap.
 */
export const reportBootstrapCoverage = async (
  env: { DB: D1Database; PACK_BACKFILL_QUEUE?: Queue<PackCompactionMessageBody> },
  scope: VaultScope
): Promise<KindCoverage[]> => {
  const results = await env.DB.batch<KindRow>(
    PACKED_KINDS.map((kind) => kindStatement(env.DB, scope, kind))
  )
  const now = Math.floor(Date.now() / 1000)
  const assessed = PACKED_KINDS.map((kind, index) => {
    const row = results[index].results?.[0]
    if (!row) throw new Error(`coverage read returned no row for ${kind}`)
    return { kind, row, ...assess(kind, row, now) }
  })
  const queue = env.PACK_BACKFILL_QUEUE
  const buildable = assessed.filter((entry) => entry.buildable).map((entry) => entry.kind)
  const started =
    queue && buildable.length > 0
      ? await claimChainStarts(env.DB, scope, buildable, now)
      : new Set<PackKindName>()
  const report = assessed.map(({ kind, row, reason }) => ({
    kind,
    covered: reason === undefined,
    uncoveredRows: row.uncovered,
    ...(reason ? { reason } : {}),
    enqueued: started.has(kind)
  }))
  if (queue && started.size > 0) {
    await queue.sendBatch(
      [...started].map((kind) => ({
        body: { userId: scope.userId, vaultId: scope.vaultId, backfill: { kind, hop: 0 } }
      }))
    )
  }
  logger.info('bootstrap pack coverage', {
    user: scope.userId.slice(0, 8),
    vaultId: scope.vaultId,
    kinds: report
  })
  return report
}
