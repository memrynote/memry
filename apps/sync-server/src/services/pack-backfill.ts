import { PACK_LIST_MAX_PACKS_PER_VAULT } from '@memry/contracts/sync-api'

import { createLogger } from '../lib/logger'
import { PACKED_KINDS, compactOneRange, type PackBuildOutcome } from './pack-compaction'
import type { PackKindName } from './pack-format'
import type { VaultScope } from './pack-index-write'
import type { PackBackfillStep, PackCompactionMessageBody } from './pack-queue'
import { withReplacedObjectPasses } from './pack-message-passes'
import { deleteReplacedPackObjects } from './pack-replaced-objects'
import { ROLLUP_SUBREQUESTS, rollupKind } from './pack-rollup'
import { MAX_PACKED_ITEM_BYTES } from './pack-selection'
import { healSnapshotRemainder } from './pack-snapshot-heal'
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
 * may remain. Messages ride their own queue (PACK_BACKFILL_QUEUE), so a push
 * nudge or a purge's delayed retry never waits behind a backfill. The two
 * consumers can run one message each for the same vault at once: builds take
 * the watermark by compare-and-swap and a rollup swap applies only while its
 * inputs are still listed, so neither lists a range twice. A vault's backlog drains in minutes instead of 3 packs per tick.
 *
 * Bounds:
 * - Fan-out: at most BACKFILL_MESSAGES_PER_SOURCE messages per source (the
 *   rollup scopes and each kind's backlog), BACKFILL_MESSAGES_PER_TICK in all,
 *   one sendBatch (Queues takes at most 100 per call).
 * - Chain: a message re-enqueues itself unless a build ended the chain
 *   (ENDS_CHAIN: below the fill, the listing cap, a held range), and at most
 *   BACKFILL_MAX_HOPS messages follow one cron message.
 * - Per message: SUBREQUEST_BUDGET_PER_MESSAGE, 3 builds or 12 rollups.
 *
 * Watermarks remember where each user+vault+kind left off, and every build
 * takes its watermark with a compare-and-swap, so a duplicate or redelivered
 * message never lists a range twice; a dropped chain resumes on the next tick.
 */

// Each source (the rollup scopes, and each kind's build backlog) gets its own
// share, so one source's backlog cannot starve another's, and a tick sends
// at most 4 x 25 = 100 messages in one sendBatch.
export const BACKFILL_MESSAGES_PER_SOURCE = 25
export const BACKFILL_MESSAGES_PER_TICK = BACKFILL_MESSAGES_PER_SOURCE * (PACKED_KINDS.length + 1)
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

/**
 * Vaults holding a snapshot row at or below the watermark that no listed pack
 * holds (healSnapshotRemainder), with room to list one more pack. One pass
 * over the vaults' snapshot rows against the document ids their packs hold,
 * every 6 hours like findBacklogVaults. A vault with a pack built before
 * migration 0024 is left out: D1 does not know what that pack holds.
 */
const findSnapshotRemainderVaults = async (
  db: D1Database,
  limit: number
): Promise<Array<{ user_id: string; vault_id: string }>> => {
  const result = await db
    .prepare(
      `WITH packed AS MATERIALIZED (
         SELECT DISTINCT p.user_id, p.vault_id, d.value AS note_id
         FROM pack_index p, json_each(p.documents) d WHERE p.item_kind = 'crdt_snapshot')
       SELECT DISTINCT s.user_id, s.vault_id
       FROM pack_watermarks w
       JOIN crdt_snapshots s ON s.user_id = w.user_id AND s.vault_id = w.vault_id
       LEFT JOIN packed k ON k.user_id = s.user_id AND k.vault_id = s.vault_id AND k.note_id = s.note_id
       WHERE w.item_kind = 'crdt_snapshot' AND k.note_id IS NULL
         AND (s.created_at < w.last_sort_value
           OR (s.created_at = w.last_sort_value AND s.note_id <= w.last_sort_tiebreak))
         AND s.size_bytes <= ?
         AND NOT EXISTS (SELECT 1 FROM pack_index n WHERE n.user_id = s.user_id
           AND n.vault_id = s.vault_id AND n.item_kind = 'crdt_snapshot' AND n.documents IS NULL)
         AND (SELECT COUNT(*) FROM pack_index c WHERE c.user_id = s.user_id
           AND c.vault_id = s.vault_id) < ?
       LIMIT ?`
    )
    .bind(MAX_PACKED_ITEM_BYTES, PACK_LIST_MAX_PACKS_PER_VAULT, limit)
    .all<{ user_id: string; vault_id: string }>()
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
    bodies.set(JSON.stringify([userId, vaultId, kind]), {
      userId,
      vaultId,
      backfill: { kind, hop: 0 }
    })
  }
  for (const row of await findRollupScopes(db, BACKFILL_MESSAGES_PER_SOURCE)) {
    add(row.user_id, row.vault_id, row.item_kind)
  }
  for (const kind of PACKED_KINDS) {
    const vaults: Array<{ user_id: string; vault_id: string }> = await findBacklogVaults(
      db,
      kind,
      BACKFILL_MESSAGES_PER_SOURCE
    )
    // A snapshot remainder below the watermark shares the kind's share of the
    // tick (D-TIE-REMAINDER): its chain runs the heal once the backlog is gone.
    if (kind === 'crdt_snapshot' && vaults.length < BACKFILL_MESSAGES_PER_SOURCE) {
      vaults.push(
        ...(await findSnapshotRemainderVaults(db, BACKFILL_MESSAGES_PER_SOURCE - vaults.length))
      )
    }
    for (const row of vaults) add(row.user_id, row.vault_id, kind)
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
  /** True when a build ended the chain (ENDS_CHAIN): nothing more to list now. */
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

// Outcomes a further build of the kind cannot change within the chain: below
// the fill (an empty scan included), the listing cap after the message's own
// rollups, a range collision that holds the watermark, and a range abandoned
// for a record row the shed empties, which the next build meets again until
// the daily shed runs (VERIFY-5279 V5). Any other noop moved the watermark or
// lost a race, so the next build may still list.
const ENDS_CHAIN: ReadonlySet<PackBuildOutcome> = new Set(['not_ready', 'cap', 'held', 'abandoned'])

/**
 * One backfill message: roll the kind up while it is above its bound and build
 * while its backlog meets the minimum fill, within one invocation's budget,
 * after the purge rewrite pass and between the replaced-object passes of
 * withReplacedObjectPasses. Throws on a
 * build failure or replaced objects still due, so Queues redelivers; a
 * redelivery finds committed builds' watermarks moved.
 */
export const runBackfillMessage = async (
  db: D1Database,
  storage: R2Bucket,
  queue: Queue<PackCompactionMessageBody> | undefined,
  scope: VaultScope,
  step: PackBackfillStep
): Promise<BackfillMessageResult> => {
  let rollups = 0
  let packsBuilt = 0
  let drained = false
  let healing = false
  // Pending purge rewrites do not fail a backfill message: the purge's own
  // delayed message owns the deadline (pack-replaced-objects.ts), and a
  // redelivery here would drop the chain (VERIFY-5283 V2).
  const passes = { rewritesFatal: false }
  await withReplacedObjectPasses(db, storage, scope, 'backfill message', passes, async () => {
    let budget = SUBREQUEST_BUDGET_PER_MESSAGE
    for (;;) {
      if (budget >= ROLLUP_SUBREQUESTS && (await rolledUp(db, storage, scope, step.kind))) {
        rollups++
        budget -= ROLLUP_SUBREQUESTS
        continue
      }
      if (budget < SUBREQUESTS_PER_PACK) return
      const result = await compactOneRange(db, storage, scope, step.kind)
      budget -= SUBREQUESTS_PER_PACK
      if (result.built) packsBuilt++
      else if (ENDS_CHAIN.has(result.reason)) {
        // Snapshots: with nothing left above the watermark, pack what a build
        // left below it (D-TIE-REMAINDER). A lost race retries; anything else
        // means no remainder is left that a build can pack. Without the budget
        // for it, a message that healed hands the rest to the next hop, so a
        // remainder of several packs drains in one chain instead of one pack
        // per cron tick (REVIEW-5315 L2); any other message ends the chain and
        // the cron's next message heals.
        if (step.kind !== 'crdt_snapshot' || result.reason !== 'not_ready') {
          drained = true
          return
        }
        if (budget < SUBREQUESTS_PER_PACK) {
          drained = !healing
          return
        }
        const healed = await healSnapshotRemainder(db, storage, scope)
        budget -= SUBREQUESTS_PER_PACK
        if (healed.built) {
          packsBuilt++
          healing = true
        } else if (healed.reason !== 'unlisted') {
          drained = true
          return
        }
      }
    }
  })

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
