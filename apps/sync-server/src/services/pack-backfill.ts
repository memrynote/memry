import { PACK_LIST_MAX_PACKS_PER_VAULT } from '@memry/contracts/sync-api'

import { createLogger } from '../lib/logger'
import { PACKED_KINDS, compactOneRange } from './pack-compaction'
import type { PackKindName } from './pack-format'
import type { VaultScope } from './pack-index-write'
import type { PackBackfillStep, PackCompactionMessageBody } from './pack-queue'
import { deleteReplacedPackObjects } from './pack-replaced-objects'
import { ROLLUP_SUBREQUESTS, rollupKind } from './pack-rollup'
import { PACK_COUNT_BOUND_SQL, PACK_MIN_FILL_ROWS, PACK_SETTLE_SECONDS } from './pack-sizing'

const logger = createLogger('PackBackfill')

/**
 * Backfill of historical items into packs (#1839), fanned out over the pack
 * queue (#5278).
 *
 * The 6-hourly cron builds nothing itself. It enqueues one backfill message per
 * vault and kind with work left: a build backlog that meets the minimum fill,
 * or more packs listed than the kind's bound. Each message runs in its own
 * consumer invocation with its own subrequest budget, rolls up and builds until
 * the kind is drained or the budget is spent, and re-enqueues itself while work
 * may remain. A vault's backlog drains in minutes instead of 3 packs per tick.
 *
 * Bounds:
 * - Fan-out: at most BACKFILL_MESSAGES_PER_TICK messages per tick, one
 *   sendBatch (Queues takes at most 100 per call).
 * - Chain: a message re-enqueues only when it spent its budget with work still
 *   making progress, and at most BACKFILL_MAX_HOPS messages follow one cron
 *   message. A message that finds nothing to roll up or build ends the chain.
 * - Per message: SUBREQUEST_BUDGET_PER_MESSAGE, 3 builds or 12 rollups.
 *
 * Watermarks remember where each user+vault+kind left off, and every build
 * takes its watermark with a compare-and-swap, so a duplicate or redelivered
 * message never lists a range twice; a dropped chain resumes on the next tick.
 */

export const BACKFILL_MESSAGES_PER_TICK = 100
export const BACKFILL_MAX_HOPS = 64
// Delay before a chain's next message, so nudges and other vaults' messages
// interleave with a long chain instead of queueing behind it.
export const BACKFILL_HOP_DELAY_SECONDS = 10

// SUBREQUEST ARITHMETIC (see pack-compaction.ts): one pack costs ~269
// subrequests (budgeted at 300), one rollup ROLLUP_SUBREQUESTS (72). A message
// owns its invocation: the Workers Paid plan allows 10,000 subrequests per
// invocation (developers.cloudflare.com/workers/platform/limits), and the
// budget stays at 900 of the 1000 compaction has always planned around, so a
// message's CPU and memory stay those of a compaction nudge.
const SUBREQUESTS_PER_PACK = 300
const SUBREQUEST_BUDGET_PER_MESSAGE = 900

interface BacklogVaultRow {
  user_id: string
  vault_id: string
  oldest_pending: number
}

/**
 * Vaults with un-packed rows above their watermark, oldest backlog first.
 * The GROUP BY rides the existing (user_id, vault_id, server_cursor) index
 * for records, updates ride the partial server_cursor index from 0011 (a NULL
 * cursor never packs, so it is no backlog), and snapshots use the additive
 * created_at index from 0007. A full
 * index scan every 6 hours is acceptable for an admin-paced maintenance job;
 * LIMIT keeps the result bounded regardless of account count. A vault at the
 * listing cap is left out, and a backlog counts only once it meets the
 * minimum fill (pack-sizing.ts), so the tick spends no budget on a vault whose
 * build would be a noop.
 */
const findBacklogVaults = async (
  db: D1Database,
  kind: PackKindName,
  limit: number
): Promise<BacklogVaultRow[]> => {
  const source =
    kind === 'record'
      ? 'sync_items si'
      : kind === 'crdt_update'
        ? 'crdt_updates si'
        : 'crdt_snapshots si'
  const sortColumn = kind === 'crdt_snapshot' ? 'si.created_at' : 'si.server_cursor'
  const timeColumn = kind === 'record' ? 'si.updated_at' : 'si.created_at'
  // A vault at the listing cap (§8.14) builds nothing, so it is no backlog:
  // left in, it sorts first every tick and spends the budget of every vault.
  const room = {
    sql: '(SELECT COUNT(*) FROM pack_index p WHERE p.user_id = si.user_id AND p.vault_id = si.vault_id) < ?',
    bind: [PACK_LIST_MAX_PACKS_PER_VAULT]
  }
  const fill = {
    sql: ` AND (COUNT(*) >= ? OR MIN(${timeColumn}) <= ?)`,
    bind: [PACK_MIN_FILL_ROWS, Math.floor(Date.now() / 1000) - PACK_SETTLE_SECONDS]
  }
  const result = await db
    .prepare(
      `SELECT si.user_id, si.vault_id, MIN(${sortColumn}) AS oldest_pending
       FROM ${source}
       LEFT JOIN pack_watermarks w
         ON w.user_id = si.user_id AND w.vault_id = si.vault_id AND w.item_kind = ?
       WHERE ${sortColumn} IS NOT NULL AND (w.user_id IS NULL OR ${sortColumn} > w.last_sort_value)
       GROUP BY si.user_id, si.vault_id
       HAVING ${room.sql}${fill.sql}
       ORDER BY oldest_pending ASC
       LIMIT ?`
    )
    .bind(kind, ...room.bind, ...fill.bind, limit)
    .all<BacklogVaultRow>()
  return result.results ?? []
}

/** Kinds that list more packs than their bound (pack-sizing.ts), most packs first. */
const findRollupScopes = async (
  db: D1Database,
  limit: number
): Promise<Array<{ user_id: string; vault_id: string; item_kind: PackKindName }>> => {
  const result = await db
    .prepare(
      `SELECT user_id, vault_id, item_kind, COUNT(*) AS packs FROM pack_index
       GROUP BY user_id, vault_id, item_kind
       HAVING COUNT(*) > ${PACK_COUNT_BOUND_SQL}
       ORDER BY packs DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<{ user_id: string; vault_id: string; item_kind: PackKindName }>()
  return result.results ?? []
}

/**
 * The cron tick: delete replaced pack objects past their grace, then enqueue
 * one backfill message per vault and kind with work, rollups first. Builds
 * nothing in-line, so it spends a few subrequests of the sweep's invocation.
 */
export const runPackBackfill = async (
  db: D1Database,
  storage: R2Bucket,
  queue: Queue<PackCompactionMessageBody> | undefined
): Promise<{ enqueued: number }> => {
  try {
    await deleteReplacedPackObjects(db, storage)
  } catch (error) {
    logger.error('replaced pack object deletion failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
  const bodies = new Map<string, PackCompactionMessageBody>()
  const add = (userId: string, vaultId: string, kind: PackKindName): void => {
    if (bodies.size >= BACKFILL_MESSAGES_PER_TICK) return
    bodies.set(JSON.stringify([userId, vaultId, kind]), {
      userId,
      vaultId,
      backfill: { kind, hop: 0 }
    })
  }
  for (const row of await findRollupScopes(db, BACKFILL_MESSAGES_PER_TICK)) {
    add(row.user_id, row.vault_id, row.item_kind)
  }
  for (const kind of PACKED_KINDS) {
    if (bodies.size >= BACKFILL_MESSAGES_PER_TICK) break
    for (const row of await findBacklogVaults(db, kind, BACKFILL_MESSAGES_PER_TICK)) {
      add(row.user_id, row.vault_id, kind)
    }
  }
  if (!queue) {
    logger.warn('no pack queue bound; pack backfill not enqueued', { scopes: bodies.size })
    return { enqueued: 0 }
  }
  if (bodies.size > 0) await queue.sendBatch([...bodies.values()].map((body) => ({ body })))
  return { enqueued: bodies.size }
}

export interface BackfillMessageResult {
  rollups: number
  packsBuilt: number
  /** True when the message found nothing left to roll up or build. */
  drained: boolean
  /** True when it enqueued the chain's next message. */
  continued: boolean
}

/** A rollup failure leaves the listing as it was; the build still runs. */
const rolledUp = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope,
  kind: PackKindName
): Promise<boolean> => {
  try {
    return (await rollupKind(db, storage, scope, kind)) !== null
  } catch (error) {
    logger.error('backfill rollup failed', {
      vaultId: scope.vaultId,
      kind,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

/**
 * One backfill message: roll the kind up while it is above its bound and build
 * while its backlog meets the minimum fill, within one invocation's budget.
 * A build that lists nothing (no fill, listing cap, nothing left) ends the
 * kind. Throws on a build failure or replaced objects still due, so Queues
 * redelivers; a redelivery finds committed builds' watermarks moved.
 */
export const runBackfillMessage = async (
  db: D1Database,
  storage: R2Bucket,
  queue: Queue<PackCompactionMessageBody> | undefined,
  scope: VaultScope,
  step: PackBackfillStep
): Promise<BackfillMessageResult> => {
  // As in compactVault: this deletion and the one after the builds keep a
  // purged body's objects inside their deadline (protocol 08 §8.13).
  await deleteReplacedPackObjects(db, storage, scope)
  let budget = SUBREQUEST_BUDGET_PER_MESSAGE
  let rollups = 0
  let packsBuilt = 0
  let drained = false
  let failure: { error: unknown } | null = null
  try {
    for (;;) {
      if (budget >= ROLLUP_SUBREQUESTS && (await rolledUp(db, storage, scope, step.kind))) {
        rollups++
        budget -= ROLLUP_SUBREQUESTS
        continue
      }
      if (budget < SUBREQUESTS_PER_PACK) break
      const result = await compactOneRange(db, storage, scope, step.kind)
      budget -= SUBREQUESTS_PER_PACK
      if (!result.built) {
        drained = true
        break
      }
      packsBuilt++
    }
  } catch (error) {
    failure = { error }
  }
  if ((await deleteReplacedPackObjects(db, storage, scope)).pending) {
    throw new Error(
      'replaced pack objects still due after the backfill message',
      failure ? { cause: failure.error } : {}
    )
  }
  if (failure) throw failure.error

  const hop = step.hop + 1
  const continued = !drained && hop < BACKFILL_MAX_HOPS && queue !== undefined
  if (continued) {
    await queue.send(
      { userId: scope.userId, vaultId: scope.vaultId, backfill: { kind: step.kind, hop } },
      { delaySeconds: BACKFILL_HOP_DELAY_SECONDS }
    )
  } else if (!drained) {
    logger.warn('pack backfill chain stopped with work left; the next tick resumes it', {
      vaultId: scope.vaultId,
      kind: step.kind,
      hop
    })
  }
  return { rollups, packsBuilt, drained, continued }
}
