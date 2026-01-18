/**
 * Sync Queue Manager
 *
 * Manages the persistent queue of sync operations.
 * Items are added when local changes occur and processed by the sync engine.
 *
 * Features:
 * - Priority queue (higher priority = synced first)
 * - Exponential backoff for failed items
 * - Max 10 retry attempts before permanent failure
 * - Batch retrieval for efficient processing
 *
 * @module main/sync/queue
 */

import { eq, and, or, lte, asc, desc, sql, count } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDatabase } from '../database/client'
import {
  syncQueue,
  syncQueueStatus,
  type SyncQueueItem,
  type NewSyncQueueItem,
  type SyncItemType,
  type SyncOperation,
  type SyncQueueStatus,
} from '@shared/db/schema/sync'
import { MAX_RETRY_ATTEMPTS } from './retry'

// =============================================================================
// Types
// =============================================================================

/** Priority levels for sync operations */
export const SyncPriority = {
  /** Critical operations (e.g., settings changes) */
  CRITICAL: 100,
  /** High priority (e.g., task completions) */
  HIGH: 75,
  /** Normal priority (e.g., content updates) */
  NORMAL: 50,
  /** Low priority (e.g., background sync) */
  LOW: 25,
  /** Background operations (e.g., cleanup) */
  BACKGROUND: 0,
} as const

export type SyncPriorityLevel = (typeof SyncPriority)[keyof typeof SyncPriority]

/** Queue item input for adding new items */
export interface QueueItemInput {
  type: SyncItemType
  itemId: string
  operation: SyncOperation
  payload: string
  priority?: number
}

/** Queue statistics */
export interface QueueStats {
  total: number
  pending: number
  inProgress: number
  failed: number
  byType: Record<SyncItemType, number>
}

// =============================================================================
// Queue Manager Class
// =============================================================================

/**
 * Sync Queue Manager
 *
 * Handles adding, retrieving, and managing sync queue items.
 */
export class SyncQueueManager {
  // ---------------------------------------------------------------------------
  // Add Operations
  // ---------------------------------------------------------------------------

  /**
   * Add an item to the sync queue.
   *
   * If an item with the same type and itemId already exists and is pending,
   * we update it rather than creating a duplicate.
   *
   * @param input - Queue item input
   * @returns Created or updated queue item
   */
  async addItem(input: QueueItemInput): Promise<SyncQueueItem> {
    const db = getDatabase()

    console.log('[Sync Queue] Adding item:', {
      type: input.type,
      itemId: input.itemId,
      operation: input.operation,
      priority: input.priority ?? SyncPriority.NORMAL
    })

    // Check for existing pending item with same type and itemId
    const existing = await db.query.syncQueue.findFirst({
      where: and(
        eq(syncQueue.type, input.type),
        eq(syncQueue.itemId, input.itemId),
        eq(syncQueue.status, syncQueueStatus.PENDING)
      ),
    })

    if (existing) {
      // Update existing item with new payload
      console.log(`[Sync Queue] Deduplicating: updating existing item ${existing.id}`)
      const [updated] = await db
        .update(syncQueue)
        .set({
          payload: input.payload,
          operation: input.operation,
          priority: input.priority ?? SyncPriority.NORMAL,
          createdAt: new Date().toISOString(),
        })
        .where(eq(syncQueue.id, existing.id))
        .returning()

      return updated
    }

    // Create new queue item
    const newItem: NewSyncQueueItem = {
      id: nanoid(),
      type: input.type,
      itemId: input.itemId,
      operation: input.operation,
      payload: input.payload,
      priority: input.priority ?? SyncPriority.NORMAL,
      attempts: 0,
      status: syncQueueStatus.PENDING,
      createdAt: new Date().toISOString(),
    }

    const [inserted] = await db.insert(syncQueue).values(newItem).returning()

    console.log(`[Sync Queue] Item added: ${inserted.id}`)
    return inserted
  }

  /**
   * Add multiple items to the sync queue.
   *
   * @param items - Array of queue item inputs
   * @returns Array of created queue items
   */
  async addItems(items: QueueItemInput[]): Promise<SyncQueueItem[]> {
    const results: SyncQueueItem[] = []

    for (const item of items) {
      const result = await this.addItem(item)
      results.push(result)
    }

    return results
  }

  // ---------------------------------------------------------------------------
  // Retrieve Operations
  // ---------------------------------------------------------------------------

  /**
   * Get the next batch of items ready for processing.
   *
   * Items are returned in priority order (highest first),
   * then by creation time (oldest first).
   *
   * @param limit - Maximum number of items to retrieve
   * @returns Array of queue items ready for sync
   */
  async getNextItems(limit: number = 10): Promise<SyncQueueItem[]> {
    const db = getDatabase()
    const now = new Date().toISOString()

    // Get pending items and failed items that are ready for retry
    const items = await db
      .select()
      .from(syncQueue)
      .where(
        or(
          // Pending items
          eq(syncQueue.status, syncQueueStatus.PENDING),
          // Failed items that are due for retry
          and(
            eq(syncQueue.status, syncQueueStatus.FAILED),
            lte(syncQueue.attempts, MAX_RETRY_ATTEMPTS),
            or(
              // No last attempt (shouldn't happen, but handle it)
              sql`${syncQueue.lastAttempt} IS NULL`,
              // Last attempt + backoff delay has passed
              sql`datetime(${syncQueue.lastAttempt}, '+' || (1 << COALESCE(${syncQueue.attempts}, 0)) || ' seconds') <= datetime(${now})`
            )
          )
        )
      )
      .orderBy(desc(syncQueue.priority), asc(syncQueue.createdAt))
      .limit(limit)

    return items
  }

  /**
   * Get a specific queue item by ID.
   *
   * @param id - Queue item ID
   * @returns Queue item or undefined
   */
  async getItem(id: string): Promise<SyncQueueItem | undefined> {
    const db = getDatabase()
    return db.query.syncQueue.findFirst({
      where: eq(syncQueue.id, id),
    })
  }

  /**
   * Get all items for a specific item ID.
   *
   * @param itemId - The item ID to get queue entries for
   * @returns Array of queue items
   */
  async getItemsByItemId(itemId: string): Promise<SyncQueueItem[]> {
    const db = getDatabase()
    return db.query.syncQueue.findMany({
      where: eq(syncQueue.itemId, itemId),
      orderBy: [desc(syncQueue.createdAt)],
    })
  }

  // ---------------------------------------------------------------------------
  // Status Update Operations
  // ---------------------------------------------------------------------------

  /**
   * Mark an item as in-progress (being processed).
   *
   * @param id - Queue item ID
   * @returns Updated item or undefined if not found
   */
  async markInProgress(id: string): Promise<SyncQueueItem | undefined> {
    const db = getDatabase()

    const [updated] = await db
      .update(syncQueue)
      .set({
        status: syncQueueStatus.IN_PROGRESS,
        lastAttempt: new Date().toISOString(),
        attempts: sql`COALESCE(${syncQueue.attempts}, 0) + 1`,
      })
      .where(eq(syncQueue.id, id))
      .returning()

    return updated
  }

  /**
   * Mark an item as successfully processed.
   * This removes the item from the queue.
   *
   * @param id - Queue item ID
   * @returns True if item was removed
   */
  async markProcessed(id: string): Promise<boolean> {
    const db = getDatabase()
    const result = await db.delete(syncQueue).where(eq(syncQueue.id, id))
    return result.changes > 0
  }

  /**
   * Mark an item as failed.
   *
   * If max retries exceeded, the item remains failed permanently.
   * Note: attempts is already incremented by markInProgress, so we use the existing value.
   *
   * @param id - Queue item ID
   * @param error - Error message
   * @returns Updated item or undefined
   */
  async markFailed(id: string, error: string): Promise<SyncQueueItem | undefined> {
    const db = getDatabase()

    // Get current item to check attempts
    const item = await this.getItem(id)
    if (!item) return undefined

    // Use existing attempts value (already incremented by markInProgress)
    const attempts = item.attempts ?? 0
    const isPermanentFailure = attempts >= MAX_RETRY_ATTEMPTS

    const [updated] = await db
      .update(syncQueue)
      .set({
        status: isPermanentFailure ? syncQueueStatus.FAILED : syncQueueStatus.PENDING,
        errorMessage: isPermanentFailure ? `Permanently failed after ${attempts} attempts: ${error}` : error,
        lastAttempt: new Date().toISOString(),
        // Don't update attempts - already incremented by markInProgress
      })
      .where(eq(syncQueue.id, id))
      .returning()

    return updated
  }

  /**
   * Reset a failed item to pending for retry.
   *
   * @param id - Queue item ID
   * @returns Updated item or undefined
   */
  async resetItem(id: string): Promise<SyncQueueItem | undefined> {
    const db = getDatabase()

    const [updated] = await db
      .update(syncQueue)
      .set({
        status: syncQueueStatus.PENDING,
        errorMessage: null,
        attempts: 0,
        lastAttempt: null,
      })
      .where(eq(syncQueue.id, id))
      .returning()

    return updated
  }

  // ---------------------------------------------------------------------------
  // Queue Management Operations
  // ---------------------------------------------------------------------------

  /**
   * Get the total queue size.
   *
   * @returns Number of items in the queue
   */
  async getQueueSize(): Promise<number> {
    const db = getDatabase()
    const [result] = await db.select({ count: count() }).from(syncQueue)
    return result?.count ?? 0
  }

  /**
   * Get the count of pending items.
   *
   * @returns Number of pending items
   */
  async getPendingCount(): Promise<number> {
    const db = getDatabase()
    const [result] = await db
      .select({ count: count() })
      .from(syncQueue)
      .where(eq(syncQueue.status, syncQueueStatus.PENDING))
    return result?.count ?? 0
  }

  /**
   * Get pending items by type.
   *
   * @param type - Sync item type
   * @returns Number of pending items of that type
   */
  async getPendingByType(type: SyncItemType): Promise<number> {
    const db = getDatabase()
    const [result] = await db
      .select({ count: count() })
      .from(syncQueue)
      .where(and(eq(syncQueue.type, type), eq(syncQueue.status, syncQueueStatus.PENDING)))
    return result?.count ?? 0
  }

  /**
   * Get detailed queue statistics.
   *
   * @returns Queue statistics
   */
  async getStats(): Promise<QueueStats> {
    const db = getDatabase()

    // Get counts by status
    const statusCounts = await db
      .select({
        status: syncQueue.status,
        count: count(),
      })
      .from(syncQueue)
      .groupBy(syncQueue.status)

    // Get counts by type
    const typeCounts = await db
      .select({
        type: syncQueue.type,
        count: count(),
      })
      .from(syncQueue)
      .groupBy(syncQueue.type)

    // Build stats object
    const stats: QueueStats = {
      total: 0,
      pending: 0,
      inProgress: 0,
      failed: 0,
      byType: {} as Record<SyncItemType, number>,
    }

    for (const { status, count: cnt } of statusCounts) {
      stats.total += cnt
      switch (status as SyncQueueStatus) {
        case syncQueueStatus.PENDING:
          stats.pending = cnt
          break
        case syncQueueStatus.IN_PROGRESS:
          stats.inProgress = cnt
          break
        case syncQueueStatus.FAILED:
          stats.failed = cnt
          break
      }
    }

    for (const { type, count: cnt } of typeCounts) {
      stats.byType[type as SyncItemType] = cnt
    }

    return stats
  }

  /**
   * Clear all completed items (no-op since processed items are deleted).
   * This exists for API consistency.
   *
   * @returns Number of items cleared (always 0)
   */
  async clearCompleted(): Promise<number> {
    // Processed items are deleted immediately, so nothing to clear
    return 0
  }

  /**
   * Clear all failed items that have exceeded max retries.
   *
   * @returns Number of items cleared
   */
  async clearPermanentlyFailed(): Promise<number> {
    const db = getDatabase()
    const result = await db
      .delete(syncQueue)
      .where(and(eq(syncQueue.status, syncQueueStatus.FAILED), sql`${syncQueue.attempts} >= ${MAX_RETRY_ATTEMPTS}`))
    return result.changes
  }

  /**
   * Retry all failed items (reset to pending).
   *
   * @returns Number of items reset
   */
  async retryFailed(): Promise<number> {
    const db = getDatabase()
    const result = await db
      .update(syncQueue)
      .set({
        status: syncQueueStatus.PENDING,
        attempts: 0,
        errorMessage: null,
        lastAttempt: null,
      })
      .where(eq(syncQueue.status, syncQueueStatus.FAILED))
    return result.changes
  }

  /**
   * Clear the entire queue.
   *
   * @returns Number of items cleared
   */
  async clearAll(): Promise<number> {
    const db = getDatabase()
    const result = await db.delete(syncQueue)
    return result.changes
  }

  /**
   * Reset any items that are stuck in "in_progress" status.
   * This can happen if the app crashes during sync.
   *
   * @returns Number of items reset
   */
  async resetStuckItems(): Promise<number> {
    const db = getDatabase()

    // Reset items that have been in_progress for more than 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    const result = await db
      .update(syncQueue)
      .set({
        status: syncQueueStatus.PENDING,
      })
      .where(
        and(eq(syncQueue.status, syncQueueStatus.IN_PROGRESS), sql`${syncQueue.lastAttempt} < ${fiveMinutesAgo}`)
      )

    return result.changes
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/** Singleton queue manager instance */
let _queueManager: SyncQueueManager | null = null

/**
 * Get the sync queue manager singleton.
 *
 * @returns SyncQueueManager instance
 */
export function getSyncQueue(): SyncQueueManager {
  if (!_queueManager) {
    _queueManager = new SyncQueueManager()
  }
  return _queueManager
}

/**
 * Reset the queue manager singleton (for testing).
 */
export function resetSyncQueue(): void {
  _queueManager = null
}
