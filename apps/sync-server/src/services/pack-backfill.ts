import { createLogger } from '../lib/logger'
import { PACKED_KINDS, compactOneRange } from './pack-compaction'
import type { PackKindName } from './pack-format'

const logger = createLogger('PackBackfill')

/**
 * Cron-paced backfill of historical items into packs (#1839).
 *
 * Pacing model — deliberately NO sleeps or busy loops inside the invocation:
 * Worker CPU time is billed wall-CPU, and sleeping burns neither less CPU nor
 * helps anyone. Instead each invocation does a BOUNDED amount of work (a few
 * packs total across all vaults) and relies on two resumable facts to make
 * progress over time:
 *   - watermarks (pack_watermarks) remember exactly where every
 *     user+vault+kind left off, and
 *   - the 6-hourly cleanup cron re-invokes this task (see index.ts), so the
 *     backlog drains at `PACKS_PER_BACKFILL_TICK` packs per tick until done.
 * A vault mid-backfill is simply continued next tick; nothing is lost, and a
 * crashed tick leaves the watermarks where they were.
 */

// Packs targeted per cron invocation, across ALL vaults combined.
//
// SUBREQUEST ARITHMETIC (see pack-compaction.ts): one pack costs ~269
// subrequests (budgeted at 300 below). The tick shares its invocation's
// paid-plan ceiling of 1000 with the sweep's other cleanup tasks, so
//   3 packs x 300 = 900  leaves ~100 for the rest of the sweep;
// 4 packs would push past the ceiling and kill the whole cron invocation.
// The loop stops as soon as this budget is spent, whichever limit binds
// first (tick count or subrequest estimate).
export const PACKS_PER_BACKFILL_TICK = 3

// Conservative per-pack subrequest estimate matching pack-compaction.ts (~269).
const SUBREQUESTS_PER_PACK = 300
const SUBREQUEST_CEILING_PER_TICK = 900

interface BacklogVaultRow {
  user_id: string
  vault_id: string
  oldest_pending: number
}

/**
 * Vaults with un-packed rows above their watermark, oldest backlog first.
 * The GROUP BY rides the existing (user_id, vault_id, server_cursor) index
 * for records; snapshots use the additive created_at index from 0007. A full
 * index scan every 6 hours is acceptable for an admin-paced maintenance job;
 * LIMIT keeps the result bounded regardless of account count.
 */
const findBacklogVaults = async (
  db: D1Database,
  kind: PackKindName,
  limit: number
): Promise<BacklogVaultRow[]> => {
  const source = kind === 'record' ? 'sync_items si' : 'crdt_snapshots si'
  const sortColumn = kind === 'record' ? 'si.server_cursor' : 'si.created_at'
  const result = await db
    .prepare(
      `SELECT si.user_id, si.vault_id, MIN(${sortColumn}) AS oldest_pending
       FROM ${source}
       LEFT JOIN pack_watermarks w
         ON w.user_id = si.user_id AND w.vault_id = si.vault_id AND w.item_kind = ?
       WHERE w.user_id IS NULL OR ${sortColumn} > w.last_sort_value
       GROUP BY si.user_id, si.vault_id
       ORDER BY oldest_pending ASC
       LIMIT ?`
    )
    .bind(kind, limit)
    .all<BacklogVaultRow>()
  return result.results ?? []
}

export interface BackfillTickResult {
  packsBuilt: number
  scopesVisited: number
  budgetRemaining: number
}

/**
 * One bounded backfill pass. Resumable by construction: every built pack
 * advances its watermark, so the next invocation continues where this stopped.
 */
export const runPackBackfill = async (
  db: D1Database,
  storage: R2Bucket,
  packsPerTick = PACKS_PER_BACKFILL_TICK
): Promise<BackfillTickResult> => {
  let budget = Math.min(packsPerTick * SUBREQUESTS_PER_PACK, SUBREQUEST_CEILING_PER_TICK)
  let packsBuilt = 0
  let scopesVisited = 0

  outer: for (const kind of PACKED_KINDS) {
    // Ask for more candidate scopes than the budget allows; extra rows are
    // simply not visited this tick (the query is ordered oldest-first, so the
    // worst backlogs drain first).
    const vaults = await findBacklogVaults(db, kind, packsPerTick * 4 + 8)
    for (const row of vaults) {
      if (budget < SUBREQUESTS_PER_PACK || packsBuilt >= packsPerTick) break outer
      try {
        const result = await compactOneRange(
          db,
          storage,
          { userId: row.user_id, vaultId: row.vault_id },
          kind
        )
        if (result.built) packsBuilt++
        budget -= SUBREQUESTS_PER_PACK
        scopesVisited++
      } catch (error) {
        // One broken vault must not starve the rest of the backlog forever,
        // but its failure IS interesting: log and move on. Watermark untouched
        // means the same vault is retried next tick.
        logger.error('backfill pack build failed', {
          userId: row.user_id,
          vaultId: row.vault_id,
          kind,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  return { packsBuilt, scopesVisited, budgetRemaining: budget }
}
