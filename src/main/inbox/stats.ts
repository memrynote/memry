/**
 * Inbox Stats Module
 *
 * Handles stale item detection, inbox statistics tracking,
 * and capture patterns analysis.
 *
 * @module main/inbox/stats
 */

import { createLogger } from '../lib/logger'
import { getDatabase } from '../database'
import { inboxItems, inboxStats, inboxItemType } from '@shared/db/schema/inbox'
import { eq, and, isNull, sql, lt } from 'drizzle-orm'
import { generateId } from '../lib/id'

const log = createLogger('Inbox:Stats')

// ============================================================================
// Constants
// ============================================================================

/** Default stale threshold in days */
const DEFAULT_STALE_DAYS = 7

/** Current stale threshold (can be changed via settings) */
let staleThresholdDays = DEFAULT_STALE_DAYS

// ============================================================================
// Stale Threshold Management
// ============================================================================

/**
 * Get the current stale threshold in days
 */
export function getStaleThreshold(): number {
  return staleThresholdDays
}

/**
 * Set the stale threshold in days
 * @param days - Number of days after which an item is considered stale (1-365)
 */
export function setStaleThreshold(days: number): void {
  staleThresholdDays = Math.max(1, Math.min(365, days))
}

/**
 * Check if a date is stale based on current threshold
 * @param createdAt - ISO date string
 * @returns Whether the date is older than the threshold
 */
export function isStale(createdAt: string): boolean {
  const created = new Date(createdAt)
  const now = new Date()
  const diffDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)
  return diffDays > staleThresholdDays
}

/**
 * Get the cutoff date for stale items
 * @returns ISO date string representing the stale cutoff
 */
export function getStaleCutoffDate(): string {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - staleThresholdDays)
  return cutoff.toISOString()
}

// ============================================================================
// Stale Items Operations
// ============================================================================

/**
 * Get all stale inbox items (not filed, not snoozed, older than threshold)
 * @returns Array of stale item IDs
 */
export function getStaleItemIds(): string[] {
  try {
    const db = getDatabase()
    const staleCutoff = getStaleCutoffDate()

    const staleItems = db
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .where(
        and(
          isNull(inboxItems.filedAt),
          isNull(inboxItems.snoozedUntil),
          isNull(inboxItems.archivedAt),
          lt(inboxItems.createdAt, staleCutoff)
        )
      )
      .all()

    return staleItems.map((item) => item.id)
  } catch {
    log.warn('No database available for stale item query')
    return []
  }
}

/**
 * Count stale items in the inbox
 * @returns Number of stale items
 */
export function countStaleItems(): number {
  try {
    const db = getDatabase()
    const staleCutoff = getStaleCutoffDate()

    const result = db
      .select({ count: sql<number>`count(*)` })
      .from(inboxItems)
      .where(
        and(
          isNull(inboxItems.filedAt),
          isNull(inboxItems.snoozedUntil),
          isNull(inboxItems.archivedAt),
          lt(inboxItems.createdAt, staleCutoff)
        )
      )
      .get()

    return result?.count || 0
  } catch {
    return 0
  }
}

// ============================================================================
// Stats Tracking
// ============================================================================

/**
 * Get today's date in YYYY-MM-DD format
 */
function getTodayDate(): string {
  return new Date().toISOString().split('T')[0]
}

/**
 * Get or create today's stats record
 * @returns The stats record for today
 */
function getOrCreateTodayStats(db: ReturnType<typeof getDatabase>): typeof inboxStats.$inferSelect {
  const today = getTodayDate()

  let stats = db.select().from(inboxStats).where(eq(inboxStats.date, today)).get()

  if (!stats) {
    const id = generateId()
    db.insert(inboxStats)
      .values({
        id,
        date: today,
        captureCountLink: 0,
        captureCountNote: 0,
        captureCountImage: 0,
        captureCountVoice: 0,
        captureCountClip: 0,
        captureCountPdf: 0,
        captureCountSocial: 0,
        processedCount: 0,
        archivedCount: 0
      })
      .run()

    stats = db.select().from(inboxStats).where(eq(inboxStats.date, today)).get()!
  }

  return stats
}

/**
 * Increment capture count for a specific item type
 * @param itemType - The type of item captured
 */
export function incrementCaptureCount(itemType: string): void {
  try {
    const db = getDatabase()
    const stats = getOrCreateTodayStats(db)

    const columnMap: Record<string, keyof typeof inboxStats.$inferSelect> = {
      [inboxItemType.LINK]: 'captureCountLink',
      [inboxItemType.NOTE]: 'captureCountNote',
      [inboxItemType.IMAGE]: 'captureCountImage',
      [inboxItemType.VOICE]: 'captureCountVoice',
      [inboxItemType.CLIP]: 'captureCountClip',
      [inboxItemType.PDF]: 'captureCountPdf',
      [inboxItemType.SOCIAL]: 'captureCountSocial'
    }

    const column = columnMap[itemType]
    if (!column) {
      log.warn(`Unknown item type: ${itemType}`)
      return
    }

    const currentValue = (stats[column] as number) || 0
    db.update(inboxStats)
      .set({ [column]: currentValue + 1 })
      .where(eq(inboxStats.id, stats.id))
      .run()

    log.debug(`Incremented ${column} to ${currentValue + 1}`)
  } catch (error) {
    log.warn('Failed to increment capture count:', error)
  }
}

/**
 * Increment the processed (filed) count for today
 * @param count - Number of items processed (default: 1)
 */
export function incrementProcessedCount(count = 1): void {
  try {
    const db = getDatabase()
    const stats = getOrCreateTodayStats(db)

    const currentValue = stats.processedCount || 0
    db.update(inboxStats)
      .set({ processedCount: currentValue + count })
      .where(eq(inboxStats.id, stats.id))
      .run()

    log.debug(`Incremented processedCount to ${currentValue + count}`)
  } catch (error) {
    log.warn('Failed to increment processed count:', error)
  }
}

/**
 * Increment the archived count for today
 * @param count - Number of items archived (default: 1)
 */
export function incrementArchivedCount(count = 1): void {
  try {
    const db = getDatabase()
    const stats = getOrCreateTodayStats(db)

    const currentValue = stats.archivedCount || 0
    db.update(inboxStats)
      .set({ archivedCount: currentValue + count })
      .where(eq(inboxStats.id, stats.id))
      .run()

    log.debug(`Incremented archivedCount to ${currentValue + count}`)
  } catch (error) {
    log.warn('Failed to increment archived count:', error)
  }
}

// ============================================================================
// Stats Retrieval
// ============================================================================

/**
 * Get stats for today
 * @returns Today's stats or null if not available
 */
export function getTodayStats(): typeof inboxStats.$inferSelect | null {
  try {
    const db = getDatabase()
    const today = getTodayDate()
    return db.select().from(inboxStats).where(eq(inboxStats.date, today)).get() || null
  } catch {
    return null
  }
}

/**
 * Get total captures and processed items for today
 * @returns Object with capturedToday and processedToday counts
 */
export function getTodayActivity(): { capturedToday: number; processedToday: number } {
  const stats = getTodayStats()
  if (!stats) {
    return { capturedToday: 0, processedToday: 0 }
  }

  const capturedToday =
    (stats.captureCountLink || 0) +
    (stats.captureCountNote || 0) +
    (stats.captureCountImage || 0) +
    (stats.captureCountVoice || 0) +
    (stats.captureCountClip || 0) +
    (stats.captureCountPdf || 0) +
    (stats.captureCountSocial || 0)

  return {
    capturedToday,
    processedToday: stats.processedCount || 0
  }
}

/**
 * Calculate average time to process items (in minutes)
 * Based on filing history from the last 30 days
 * @returns Average processing time in minutes, or 0 if no data
 */
export function getAverageTimeToProcess(): number {
  try {
    const db = getDatabase()

    // Get items filed in the last 30 days
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const cutoff = thirtyDaysAgo.toISOString()

    const filedItems = db
      .select({
        createdAt: inboxItems.createdAt,
        filedAt: inboxItems.filedAt
      })
      .from(inboxItems)
      .where(and(sql`${inboxItems.filedAt} IS NOT NULL`, sql`${inboxItems.filedAt} > ${cutoff}`))
      .all()

    if (filedItems.length === 0) return 0

    let totalMinutes = 0
    let validCount = 0

    for (const item of filedItems) {
      if (item.createdAt && item.filedAt) {
        const created = new Date(item.createdAt)
        const filed = new Date(item.filedAt)
        const diffMinutes = (filed.getTime() - created.getTime()) / (1000 * 60)
        if (diffMinutes >= 0) {
          totalMinutes += diffMinutes
          validCount++
        }
      }
    }

    return validCount > 0 ? Math.round(totalMinutes / validCount) : 0
  } catch {
    return 0
  }
}
