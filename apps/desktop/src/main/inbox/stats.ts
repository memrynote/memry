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
import { inboxItems, inboxStats, inboxItemType } from '@memry/db-schema/schema/inbox'
import { eq, and, isNull, sql, lt, gte, desc, asc } from 'drizzle-orm'
import { generateId } from '../lib/id'
import { getSetting, setSetting } from '../database/queries/settings'

const log = createLogger('Inbox:Stats')

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_STALE_DAYS = 7
const STALE_THRESHOLD_KEY = 'inbox.staleThresholdDays'

// ============================================================================
// Stale Threshold Management
// ============================================================================

function readStaleThreshold(): number {
  try {
    const db = getDatabase()
    const stored = getSetting(db, STALE_THRESHOLD_KEY)
    if (stored !== null) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 365) return parsed
    }
  } catch {
    // DB not available yet — use default
  }
  return DEFAULT_STALE_DAYS
}

export function getStaleThreshold(): number {
  return readStaleThreshold()
}

export function setStaleThreshold(days: number): void {
  const clamped = Math.max(1, Math.min(365, days))
  try {
    const db = getDatabase()
    setSetting(db, STALE_THRESHOLD_KEY, String(clamped))
  } catch {
    log.warn('Failed to persist stale threshold — DB not available')
  }
}

export function isStale(createdAt: string): boolean {
  const created = new Date(createdAt)
  const now = new Date()
  const diffDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)
  return diffDays > readStaleThreshold()
}

/**
 * Get the cutoff date for stale items
 * @returns ISO date string representing the stale cutoff
 */
export function getStaleCutoffDate(): string {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - readStaleThreshold())
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

// ============================================================================
// Processing Streak
// ============================================================================

export function getProcessingStreak(): number {
  try {
    const db = getDatabase()
    const recentStats = db.select().from(inboxStats).orderBy(desc(inboxStats.date)).limit(90).all()

    let streak = 0
    const today = getTodayDate()
    const checkDate = new Date(today)

    for (let i = 0; i < 90; i++) {
      const dateStr = checkDate.toISOString().split('T')[0]
      const dayStats = recentStats.find((r) => r.date === dateStr)
      if (dayStats && (dayStats.processedCount || 0) > 0) {
        streak++
      } else if (i > 0) {
        break
      } else if (i === 0 && (!dayStats || (dayStats.processedCount || 0) === 0)) {
        const yesterday = new Date(checkDate)
        yesterday.setDate(yesterday.getDate() - 1)
        const yStr = yesterday.toISOString().split('T')[0]
        const yStats = recentStats.find((r) => r.date === yStr)
        if (yStats && (yStats.processedCount || 0) > 0) {
          checkDate.setDate(checkDate.getDate() - 1)
          streak++
          continue
        }
        break
      }
      checkDate.setDate(checkDate.getDate() - 1)
    }

    return streak
  } catch {
    return 0
  }
}

// ============================================================================
// Health Metrics
// ============================================================================

export interface InboxHealthMetrics {
  capturedThisWeek: number
  processedThisWeek: number
  captureProcessRatio: number
  ageDistribution: { fresh: number; aging: number; stale: number }
  oldestItemDays: number
  currentStreak: number
}

function sumCaptures(row: typeof inboxStats.$inferSelect): number {
  return (
    (row.captureCountLink || 0) +
    (row.captureCountNote || 0) +
    (row.captureCountImage || 0) +
    (row.captureCountVoice || 0) +
    (row.captureCountClip || 0) +
    (row.captureCountPdf || 0) +
    (row.captureCountSocial || 0)
  )
}

export function getInboxHealthMetrics(): InboxHealthMetrics {
  try {
    const db = getDatabase()
    const now = new Date()

    const weekAgoDate = new Date(now)
    weekAgoDate.setDate(weekAgoDate.getDate() - 7)
    const weekAgo = weekAgoDate.toISOString().split('T')[0]

    const weekRows = db.select().from(inboxStats).where(gte(inboxStats.date, weekAgo)).all()

    let capturedThisWeek = 0
    let processedThisWeek = 0
    for (const row of weekRows) {
      capturedThisWeek += sumCaptures(row)
      processedThisWeek += row.processedCount || 0
    }

    const captureProcessRatio =
      processedThisWeek > 0
        ? Math.round((capturedThisWeek / processedThisWeek) * 10) / 10
        : capturedThisWeek > 0
          ? capturedThisWeek
          : 0

    const pendingBase = and(
      isNull(inboxItems.filedAt),
      isNull(inboxItems.snoozedUntil),
      isNull(inboxItems.archivedAt)
    )

    const threeDaysAgo = new Date(now)
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)

    const staleCutoff = getStaleCutoffDate()

    const freshCount = db
      .select({ count: sql<number>`count(*)` })
      .from(inboxItems)
      .where(and(pendingBase, gte(inboxItems.createdAt, threeDaysAgo.toISOString())))
      .get()

    const agingCount = db
      .select({ count: sql<number>`count(*)` })
      .from(inboxItems)
      .where(
        and(
          pendingBase,
          lt(inboxItems.createdAt, threeDaysAgo.toISOString()),
          gte(inboxItems.createdAt, staleCutoff)
        )
      )
      .get()

    const staleCount = db
      .select({ count: sql<number>`count(*)` })
      .from(inboxItems)
      .where(and(pendingBase, lt(inboxItems.createdAt, staleCutoff)))
      .get()

    const oldestItem = db
      .select({ createdAt: inboxItems.createdAt })
      .from(inboxItems)
      .where(pendingBase)
      .orderBy(asc(inboxItems.createdAt))
      .limit(1)
      .get()

    let oldestItemDays = 0
    if (oldestItem) {
      oldestItemDays = Math.floor(
        (now.getTime() - new Date(oldestItem.createdAt).getTime()) / (1000 * 60 * 60 * 24)
      )
    }

    const currentStreak = getProcessingStreak()

    return {
      capturedThisWeek,
      processedThisWeek,
      captureProcessRatio,
      ageDistribution: {
        fresh: freshCount?.count || 0,
        aging: agingCount?.count || 0,
        stale: staleCount?.count || 0
      },
      oldestItemDays,
      currentStreak
    }
  } catch (error) {
    log.warn('Failed to compute health metrics:', error)
    return {
      capturedThisWeek: 0,
      processedThisWeek: 0,
      captureProcessRatio: 0,
      ageDistribution: { fresh: 0, aging: 0, stale: 0 },
      oldestItemDays: 0,
      currentStreak: 0
    }
  }
}
