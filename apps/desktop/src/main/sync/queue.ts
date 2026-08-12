import { eq, and, sql, desc, asc, lt, lte, count, notInArray } from 'drizzle-orm'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import type { SyncItemType, SyncOperation } from '@memry/contracts/sync-api'
import type { DataDb } from '../database'
import { createLogger } from '../lib/logger'
import { toSafeToken } from '@memry/contracts/telemetry-api'
import { trackMainEvent } from '../telemetry/track'
import { trackMainLog } from '../telemetry/diagnostics'

const log = createLogger('SyncQueue')

export const DEFAULT_MAX_ATTEMPTS = 5

const DEAD_LETTER_PURGE_THRESHOLD = 50
export const ERROR_RETENTION_DAYS = 7

/**
 * How many enqueues may pass between two auto-purge probes.
 *
 * Purging dead-lettered rows older than ERROR_RETENTION_DAYS is housekeeping,
 * not correctness: nothing reads those rows, and they can only accumulate at
 * the pace of `markFailed`. Re-evaluating the threshold on every single
 * enqueue therefore bought nothing and cost a scan of `sync_queue` per queued
 * mutation, which a bulk import or an import-sized burst pays thousands of
 * times. The probe runs on the first enqueue and every Nth one after that.
 */
const AUTO_PURGE_CHECK_EVERY_N_ENQUEUES = 50

export interface EnqueueInput {
  type: SyncItemType
  itemId: string
  operation: SyncOperation
  payload: string
  priority?: number
}

export interface QueueStats {
  pending: number
  failed: number
  deadLetter: number
  total: number
}

/**
 * Fold two mutations for the same item into the single operation that has to
 * reach the server. A later delete wins outright; otherwise an unacked create
 * survives, because the server has never seen the item and an `update` for an
 * id it does not know is not the same request.
 *
 * Exported because two call sites collapse rows for the same `(type, itemId)`:
 * `enqueue` (into an `attempts = 0` row) and the push coordinator's batch
 * dedupe (rows that could not coalesce because the older one had already
 * failed). They must agree, or the precedence depends on which path ran.
 */
export function coalesceSyncOperations(existing: string, incoming: string): string {
  if (incoming === 'delete') return 'delete'
  if (existing === 'create' || incoming === 'create') return 'create'
  return incoming
}

export class SyncQueueManager {
  constructor(private readonly db: DataDb) {}

  private onItemEnqueued: (() => void) | null = null

  /** Seeded at the interval so the very first enqueue still probes. */
  private enqueuesSincePurgeCheck = AUTO_PURGE_CHECK_EVERY_N_ENQUEUES

  setOnItemEnqueued(callback: () => void): void {
    this.onItemEnqueued = callback
  }

  enqueue(input: EnqueueInput): string {
    const { type, itemId, operation, payload, priority = 0 } = input

    this.maybeAutoPurge()

    const id = this.db.transaction((tx) => {
      const existing = tx
        .select({ id: syncQueue.id, operation: syncQueue.operation })
        .from(syncQueue)
        .where(
          and(eq(syncQueue.itemId, itemId), eq(syncQueue.type, type), eq(syncQueue.attempts, 0))
        )
        .get()

      if (existing) {
        const coalescedOp = coalesceSyncOperations(existing.operation, operation)
        tx.update(syncQueue)
          .set({ payload, priority, operation: coalescedOp })
          .where(eq(syncQueue.id, existing.id))
          .run()
        return existing.id
      }

      const newId = crypto.randomUUID()
      tx.insert(syncQueue)
        .values({
          id: newId,
          type,
          itemId,
          operation,
          payload,
          priority,
          attempts: 0,
          createdAt: new Date()
        })
        .run()
      return newId
    })

    log.debug('enqueue: item queued', {
      id: id.slice(0, 8),
      type,
      itemId: itemId.slice(0, 8),
      operation
    })
    this.onItemEnqueued?.()
    return id
  }

  /**
   * Rows still inside their retry budget, highest priority / oldest first.
   *
   * `excludeIds` holds rows the caller has already failed during the current
   * push cycle. It matters because the push loop dequeues repeatedly in one
   * `push()` call: without the exclusion it re-dequeues the row it just failed
   * on the very next iteration, so all `DEFAULT_MAX_ATTEMPTS` are spent against
   * a single burst of back-to-back requests and one transient server rejection
   * dead-letters a user's edit for good. The budget is meant to span sync
   * cycles, and the delay between them is the cycle interval itself — so the
   * exclusion is per-call state only and is deliberately never persisted.
   *
   * Excluding by id rather than by `lastAttempt` keeps this independent of the
   * system clock: a backwards clock jump must never hide a pending edit.
   */
  dequeue(batchSize: number, excludeIds?: Iterable<string>): Array<typeof syncQueue.$inferSelect> {
    const excluded = excludeIds ? Array.from(excludeIds) : []
    const withinBudget = lt(syncQueue.attempts, DEFAULT_MAX_ATTEMPTS)

    return this.db
      .select()
      .from(syncQueue)
      .where(
        excluded.length > 0 ? and(withinBudget, notInArray(syncQueue.id, excluded)) : withinBudget
      )
      .orderBy(desc(syncQueue.priority), asc(syncQueue.createdAt))
      .limit(batchSize)
      .all()
  }

  peek(count = 10): Array<typeof syncQueue.$inferSelect> {
    return this.db
      .select()
      .from(syncQueue)
      .orderBy(desc(syncQueue.priority), asc(syncQueue.createdAt))
      .limit(count)
      .all()
  }

  /**
   * Drop an item the server accepted.
   *
   * `pushedPayload` makes the delete conditional, and callers that push over
   * the network MUST pass it. `enqueue` coalesces a new mutation into any
   * existing `attempts = 0` row, and nothing marks a row as in flight — so a
   * rename made while a push is awaiting its response lands in the very row
   * the push is about to delete. Deleting unconditionally loses that mutation
   * forever: its clock bump is already persisted, so the local item stays
   * permanently ahead of the server and no later pull can repair it (the note
   * that produced this guard synced across devices as "Untitled").
   *
   * @returns true when the row was removed, false when it changed under us and
   * was kept for the next push iteration.
   */
  markSuccess(id: string, pushedPayload?: string): boolean {
    const where =
      pushedPayload === undefined
        ? eq(syncQueue.id, id)
        : and(eq(syncQueue.id, id), eq(syncQueue.payload, pushedPayload))

    const changes = this.db.delete(syncQueue).where(where).run().changes

    if (changes === 0 && pushedPayload !== undefined) {
      log.info('markSuccess: item changed while in flight, keeping it queued', {
        id: id.slice(0, 8)
      })
      return false
    }

    log.debug('markSuccess: deleting item', { id: id.slice(0, 8) })
    return true
  }

  markFailed(id: string, error: string): void {
    log.warn('markFailed: item push rejected', { id: id.slice(0, 8), error })
    this.db
      .update(syncQueue)
      .set({
        attempts: sql`${syncQueue.attempts} + 1`,
        lastAttempt: new Date(),
        errorMessage: error
      })
      .where(eq(syncQueue.id, id))
      .run()

    // Dead-letter transition: once attempts reaches the budget the row simply
    // stops matching dequeue's filter and the edit silently never syncs again.
    // Equality (not >=) so the event fires exactly once per row.
    const row = this.db
      .select({ attempts: syncQueue.attempts, type: syncQueue.type })
      .from(syncQueue)
      .where(eq(syncQueue.id, id))
      .get()
    if (row && row.attempts === DEFAULT_MAX_ATTEMPTS) {
      log.error('markFailed: retry budget exhausted — item dead-lettered', {
        id: id.slice(0, 8),
        type: row.type,
        error
      })
      trackMainEvent('sync_error', {
        surface: 'sync',
        action: 'queue_dead_letter',
        result: 'failed',
        errorCode: toSafeToken(error, 'rejected'),
        source: 'push',
        dimensions: { itemType: row.type }
      })
    }
  }

  getSize(): number {
    const result = this.db.select({ count: count() }).from(syncQueue).get()
    return result?.count ?? 0
  }

  getPendingCount(): number {
    const result = this.db
      .select({ count: count() })
      .from(syncQueue)
      .where(lt(syncQueue.attempts, DEFAULT_MAX_ATTEMPTS))
      .get()
    return result?.count ?? 0
  }

  getRawPendingCount(): number {
    const result = this.db.get<{ cnt: number }>(
      sql`SELECT count(*) as cnt FROM sync_queue WHERE attempts < ${DEFAULT_MAX_ATTEMPTS}`
    )
    return result?.cnt ?? 0
  }

  getFailedCount(): number {
    const result = this.db
      .select({ count: count() })
      .from(syncQueue)
      .where(and(sql`${syncQueue.attempts} > 0`, lt(syncQueue.attempts, DEFAULT_MAX_ATTEMPTS)))
      .get()
    return result?.count ?? 0
  }

  clear(): void {
    log.warn('clear: deleting ALL queue items', { count: this.getSize() })
    this.db.delete(syncQueue).run()
  }

  removeById(id: string): void {
    log.debug('removeById: deleting item', { id: id.slice(0, 8) })
    this.db.delete(syncQueue).where(eq(syncQueue.id, id)).run()
  }

  removeByItemId(itemId: string): number {
    log.debug('removeByItemId: deleting items', { itemId: itemId.slice(0, 8) })
    return this.db.delete(syncQueue).where(eq(syncQueue.itemId, itemId)).run().changes
  }

  getRetryableItems(maxAttempts = DEFAULT_MAX_ATTEMPTS): Array<typeof syncQueue.$inferSelect> {
    return this.db
      .select()
      .from(syncQueue)
      .where(and(sql`${syncQueue.attempts} > 0`, lt(syncQueue.attempts, maxAttempts)))
      .orderBy(asc(syncQueue.attempts), asc(syncQueue.createdAt))
      .all()
  }

  purgeOldErrors(olderThan: Date): number {
    const beforeCount = this.getSize()
    const result = this.db
      .delete(syncQueue)
      .where(
        and(
          sql`${syncQueue.attempts} >= ${DEFAULT_MAX_ATTEMPTS}`,
          lte(syncQueue.createdAt, olderThan)
        )
      )
      .run()
    if (result.changes > 0) {
      log.debug('purgeOldErrors: purged', { purged: result.changes, beforeCount })
      // Permanent deletion of dead-lettered user edits — countable remotely.
      trackMainLog('warn', {
        scope: 'SyncQueue',
        action: 'dead_letter_purged',
        metrics: { itemCount: result.changes }
      })
    }
    return result.changes
  }

  private maybeAutoPurge(): void {
    this.enqueuesSincePurgeCheck++
    if (this.enqueuesSincePurgeCheck < AUTO_PURGE_CHECK_EVERY_N_ENQUEUES) return
    this.enqueuesSincePurgeCheck = 0

    if (!this.hasDeadLetterBacklog()) return
    const sevenDaysAgo = new Date(Date.now() - ERROR_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    this.purgeOldErrors(sevenDaysAgo)
  }

  /**
   * Whether at least DEAD_LETTER_PURGE_THRESHOLD rows have exhausted their
   * retry budget. `LIMIT 1 OFFSET threshold-1` stops walking as soon as the
   * threshold-th row is reached, so it never counts the rest of the table —
   * and the exact dead-letter total was never used, only compared.
   */
  private hasDeadLetterBacklog(): boolean {
    const row = this.db.get<{ found: number }>(
      sql`SELECT 1 AS found FROM sync_queue WHERE attempts >= ${DEFAULT_MAX_ATTEMPTS} LIMIT 1 OFFSET ${DEAD_LETTER_PURGE_THRESHOLD - 1}`
    )
    return row !== undefined
  }

  getQueueStats(): QueueStats {
    const total = this.getSize()
    const pending = this.db
      .select({ count: count() })
      .from(syncQueue)
      .where(eq(syncQueue.attempts, 0))
      .get()

    const deadLetter = this.db
      .select({ count: count() })
      .from(syncQueue)
      .where(sql`${syncQueue.attempts} >= ${DEFAULT_MAX_ATTEMPTS}`)
      .get()

    const failed = this.db
      .select({ count: count() })
      .from(syncQueue)
      .where(and(sql`${syncQueue.attempts} > 0`, lt(syncQueue.attempts, DEFAULT_MAX_ATTEMPTS)))
      .get()

    return {
      pending: pending?.count ?? 0,
      failed: failed?.count ?? 0,
      deadLetter: deadLetter?.count ?? 0,
      total
    }
  }
}
