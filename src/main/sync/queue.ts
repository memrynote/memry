import { eq, and, sql, desc, asc, lt, lte, count } from 'drizzle-orm'
import { syncQueue } from '@shared/db/schema/sync-queue'
import type { SyncItemType, SyncOperation } from '@shared/contracts/sync-api'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

type DrizzleDb = BetterSQLite3Database

export const DEFAULT_MAX_ATTEMPTS = 5

const DEAD_LETTER_PURGE_THRESHOLD = 50
export const ERROR_RETENTION_DAYS = 7

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

export class SyncQueueManager {
  constructor(private readonly db: DrizzleDb) {}

  private onItemEnqueued: (() => void) | null = null

  setOnItemEnqueued(callback: () => void): void {
    this.onItemEnqueued = callback
  }

  enqueue(input: EnqueueInput): string {
    const { type, itemId, operation, payload, priority = 0 } = input

    this.maybeAutoPurge()

    const id = this.db.transaction((tx) => {
      const existing = tx
        .select({ id: syncQueue.id })
        .from(syncQueue)
        .where(
          and(
            eq(syncQueue.itemId, itemId),
            eq(syncQueue.type, type),
            eq(syncQueue.operation, operation),
            eq(syncQueue.attempts, 0)
          )
        )
        .get()

      if (existing) {
        tx.update(syncQueue).set({ payload, priority }).where(eq(syncQueue.id, existing.id)).run()
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

    this.onItemEnqueued?.()
    return id
  }

  dequeue(batchSize: number): Array<typeof syncQueue.$inferSelect> {
    const items = this.db
      .select()
      .from(syncQueue)
      .where(lt(syncQueue.attempts, DEFAULT_MAX_ATTEMPTS))
      .orderBy(desc(syncQueue.priority), asc(syncQueue.createdAt))
      .limit(batchSize)
      .all()

    if (items.length > 0) {
      const ids = items.map((i) => i.id)
      this.db
        .update(syncQueue)
        .set({
          attempts: sql`${syncQueue.attempts} + 1`,
          lastAttempt: new Date()
        })
        .where(sql`${syncQueue.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
        .run()
    }

    return items
  }

  peek(count = 10): Array<typeof syncQueue.$inferSelect> {
    return this.db
      .select()
      .from(syncQueue)
      .orderBy(desc(syncQueue.priority), asc(syncQueue.createdAt))
      .limit(count)
      .all()
  }

  markSuccess(id: string): void {
    this.db.delete(syncQueue).where(eq(syncQueue.id, id)).run()
  }

  markFailed(id: string, error: string): void {
    this.db
      .update(syncQueue)
      .set({
        lastAttempt: new Date(),
        errorMessage: error
      })
      .where(eq(syncQueue.id, id))
      .run()
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

  getFailedCount(): number {
    const result = this.db
      .select({ count: count() })
      .from(syncQueue)
      .where(and(sql`${syncQueue.attempts} > 0`, lt(syncQueue.attempts, DEFAULT_MAX_ATTEMPTS)))
      .get()
    return result?.count ?? 0
  }

  clear(): void {
    this.db.delete(syncQueue).run()
  }

  removeById(id: string): void {
    this.db.delete(syncQueue).where(eq(syncQueue.id, id)).run()
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
    const result = this.db
      .delete(syncQueue)
      .where(
        and(
          sql`${syncQueue.attempts} >= ${DEFAULT_MAX_ATTEMPTS}`,
          lte(syncQueue.createdAt, olderThan)
        )
      )
      .run()
    return result.changes
  }

  private maybeAutoPurge(): void {
    const stats = this.getQueueStats()
    if (stats.deadLetter >= DEAD_LETTER_PURGE_THRESHOLD) {
      const sevenDaysAgo = new Date(Date.now() - ERROR_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      this.purgeOldErrors(sevenDaysAgo)
    }
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
