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
 * response, so it costs the client nothing: one D1 batch and at most one queue
 * send. The coverage the client trusts is the one the listing states
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
  /** Rows of the kind no coverage range holds: the part a client takes item by item. */
  uncoveredRows: number
  reason?: UncoveredReason
  /** True when this bootstrap enqueued the kind's compaction. */
  enqueued: boolean
}

interface KindRow {
  has_watermark: number
  anchor: number | null
  uncovered: number
  backlog: number
  oldest: number | null
}

const SOURCES: Record<PackKindName, { table: string; sort: string; time: string }> = {
  record: { table: 'sync_items', sort: 'server_cursor', time: 'updated_at' },
  crdt_snapshot: { table: 'crdt_snapshots', sort: 'created_at', time: 'created_at' },
  crdt_update: { table: 'crdt_updates', sort: 'server_cursor', time: 'created_at' }
}

/**
 * One row per kind: the watermark's coverage anchor, the rows above it (all
 * rows when it has none), and the build backlog above the watermark with its
 * oldest write time, the inputs of the minimum fill (pack-sizing.ts).
 */
const kindStatement = (db: D1Database, scope: VaultScope, kind: PackKindName) => {
  const { table, sort, time } = SOURCES[kind]
  const rows = `FROM ${table} s WHERE s.user_id = ? AND s.vault_id = ?`
  const vault = [scope.userId, scope.vaultId]
  return db
    .prepare(
      `SELECT w.user_id IS NOT NULL AS has_watermark, w.covered_through AS anchor,
         (SELECT COUNT(*) ${rows} AND s.${sort} > COALESCE(w.covered_through, 0)) AS uncovered,
         (SELECT COUNT(*) ${rows} AND s.${sort} > COALESCE(w.last_sort_value, 0)) AS backlog,
         (SELECT MIN(s.${time}) ${rows} AND s.${sort} > COALESCE(w.last_sort_value, 0)) AS oldest
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
 * Log the vault's coverage per kind and enqueue a backfill chain for each kind
 * a build can extend, on the nudge queue (PACK_QUEUE). The routine backfill
 * fan-out rides PACK_BACKFILL_QUEUE, so this first message runs ahead of it;
 * the chain's later hops follow on the backfill queue (pack-backfill.ts).
 * At most one message per kind per bootstrap, and duplicates are safe: every
 * build takes its watermark by compare-and-swap.
 */
export const reportBootstrapCoverage = async (
  env: { DB: D1Database; PACK_QUEUE?: Queue<PackCompactionMessageBody> },
  scope: VaultScope
): Promise<KindCoverage[]> => {
  const results = await env.DB.batch<KindRow>(
    PACKED_KINDS.map((kind) => kindStatement(env.DB, scope, kind))
  )
  const now = Math.floor(Date.now() / 1000)
  const report = PACKED_KINDS.map((kind, index) => {
    const row = results[index].results?.[0]
    if (!row) throw new Error(`coverage read returned no row for ${kind}`)
    const { reason, buildable } = assess(kind, row, now)
    return {
      kind,
      covered: reason === undefined,
      uncoveredRows: row.uncovered,
      ...(reason ? { reason } : {}),
      enqueued: buildable && env.PACK_QUEUE !== undefined
    }
  })
  const bodies = report
    .filter((entry) => entry.enqueued)
    .map((entry) => ({
      body: {
        userId: scope.userId,
        vaultId: scope.vaultId,
        backfill: { kind: entry.kind, hop: 0 }
      }
    }))
  if (env.PACK_QUEUE && bodies.length > 0) await env.PACK_QUEUE.sendBatch(bodies)
  logger.info('bootstrap pack coverage', {
    user: scope.userId.slice(0, 8),
    vaultId: scope.vaultId,
    kinds: report
  })
  return report
}
