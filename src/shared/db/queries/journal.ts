/**
 * Journal cache query functions for Drizzle ORM.
 * These queries operate on index.db (rebuildable cache).
 *
 * @module db/queries/journal
 */

import { eq, desc, like, sql, count } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  journalCache,
  journalTags,
  type JournalCache,
  type InsertJournalCache,
  type InsertJournalTag
} from '../schema/journal-cache'
import * as schema from '../schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ============================================================================
// Journal Cache CRUD
// ============================================================================

/**
 * Insert a new journal entry into the cache.
 */
export function insertJournalEntry(db: DrizzleDb, entry: InsertJournalCache): JournalCache {
  return db.insert(journalCache).values(entry).returning().get()
}

/**
 * Update an existing journal entry in the cache.
 */
export function updateJournalEntry(
  db: DrizzleDb,
  id: string,
  updates: Partial<Omit<JournalCache, 'id'>>
): JournalCache | undefined {
  return db
    .update(journalCache)
    .set({
      ...updates,
      indexedAt: new Date().toISOString()
    })
    .where(eq(journalCache.id, id))
    .returning()
    .get()
}

/**
 * Delete a journal entry from the cache.
 */
export function deleteJournalEntry(db: DrizzleDb, id: string): void {
  db.delete(journalCache).where(eq(journalCache.id, id)).run()
}

/**
 * Get a journal entry from cache by ID.
 */
export function getJournalEntryById(db: DrizzleDb, id: string): JournalCache | undefined {
  return db.select().from(journalCache).where(eq(journalCache.id, id)).get()
}

/**
 * Get a journal entry from cache by date (YYYY-MM-DD).
 */
export function getJournalEntryByDate(db: DrizzleDb, date: string): JournalCache | undefined {
  return db.select().from(journalCache).where(eq(journalCache.date, date)).get()
}

/**
 * Check if a journal entry exists for a date.
 */
export function journalEntryExists(db: DrizzleDb, date: string): boolean {
  const result = db
    .select({ id: journalCache.id })
    .from(journalCache)
    .where(eq(journalCache.date, date))
    .get()
  return result !== undefined
}

// ============================================================================
// Heatmap & Calendar Queries
// ============================================================================

/**
 * Get heatmap data for a year.
 * Returns all entries with date, characterCount, and activityLevel.
 */
export function getHeatmapData(
  db: DrizzleDb,
  year: number
): { date: string; characterCount: number; level: number }[] {
  const yearPrefix = `${year}-`
  return db
    .select({
      date: journalCache.date,
      characterCount: journalCache.characterCount,
      level: journalCache.activityLevel
    })
    .from(journalCache)
    .where(like(journalCache.date, `${yearPrefix}%`))
    .orderBy(journalCache.date)
    .all()
}

/**
 * Get entries for a specific month with preview data.
 * Used for month view display.
 */
export function getMonthEntries(db: DrizzleDb, year: number, month: number): JournalCache[] {
  const monthStr = String(month).padStart(2, '0')
  const monthPrefix = `${year}-${monthStr}-`
  return db
    .select()
    .from(journalCache)
    .where(like(journalCache.date, `${monthPrefix}%`))
    .orderBy(desc(journalCache.date))
    .all()
}

/**
 * Get statistics for each month in a year.
 * Used for year view display.
 */
export function getYearStats(
  db: DrizzleDb,
  year: number
): {
  month: number
  entryCount: number
  totalWordCount: number
  totalCharacterCount: number
  averageLevel: number
}[] {
  const yearPrefix = `${year}-`

  // Get all entries for the year grouped by month
  const entries = db
    .select({
      month: sql<number>`CAST(substr(${journalCache.date}, 6, 2) AS INTEGER)`,
      entryCount: sql<number>`COUNT(*)`,
      totalWordCount: sql<number>`COALESCE(SUM(${journalCache.wordCount}), 0)`,
      totalCharacterCount: sql<number>`COALESCE(SUM(${journalCache.characterCount}), 0)`,
      averageLevel: sql<number>`COALESCE(AVG(${journalCache.activityLevel}), 0)`
    })
    .from(journalCache)
    .where(like(journalCache.date, `${yearPrefix}%`))
    .groupBy(sql`substr(${journalCache.date}, 6, 2)`)
    .all()

  return entries.map((e) => ({
    month: e.month,
    entryCount: e.entryCount,
    totalWordCount: e.totalWordCount,
    totalCharacterCount: e.totalCharacterCount,
    averageLevel: Math.round(e.averageLevel * 100) / 100
  }))
}

// ============================================================================
// Tags Management
// ============================================================================

/**
 * Set tags for a journal entry (replaces existing tags).
 */
export function setJournalTags(db: DrizzleDb, entryId: string, tags: string[]): void {
  // Delete existing tags
  db.delete(journalTags).where(eq(journalTags.entryId, entryId)).run()

  // Insert new tags
  if (tags.length > 0) {
    const tagRows: InsertJournalTag[] = tags.map((tag) => ({
      entryId,
      tag: tag.toLowerCase().trim()
    }))
    db.insert(journalTags).values(tagRows).run()
  }
}

/**
 * Get tags for a journal entry.
 */
export function getJournalTags(db: DrizzleDb, entryId: string): string[] {
  const rows = db
    .select({ tag: journalTags.tag })
    .from(journalTags)
    .where(eq(journalTags.entryId, entryId))
    .all()
  return rows.map((r) => r.tag)
}

/**
 * Get all tags used in journal entries with counts.
 */
export function getAllJournalTags(db: DrizzleDb): { tag: string; count: number }[] {
  return db
    .select({
      tag: journalTags.tag,
      count: sql<number>`COUNT(*)`
    })
    .from(journalTags)
    .groupBy(journalTags.tag)
    .orderBy(desc(sql`COUNT(*)`))
    .all()
}

// ============================================================================
// Streak Calculation
// ============================================================================

/**
 * Calculate current and longest journaling streak.
 * A streak is consecutive days with journal entries.
 */
export function getJournalStreak(db: DrizzleDb): {
  currentStreak: number
  longestStreak: number
  lastEntryDate: string | null
} {
  // Get all entry dates in descending order
  const entries = db
    .select({ date: journalCache.date })
    .from(journalCache)
    .orderBy(desc(journalCache.date))
    .all()

  if (entries.length === 0) {
    return { currentStreak: 0, longestStreak: 0, lastEntryDate: null }
  }

  const lastEntryDate = entries[0].date
  const dates = new Set(entries.map((e) => e.date))

  // Calculate current streak (from today or last entry backwards)
  let currentStreak = 0
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Start from today and go backwards
  let checkDate = new Date(today)

  // If today doesn't have an entry, start from the last entry date
  const todayStr = checkDate.toISOString().split('T')[0]
  if (!dates.has(todayStr)) {
    // Check if last entry was yesterday (streak still valid)
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    if (dates.has(yesterdayStr)) {
      checkDate = yesterday
    } else {
      // Streak is broken, current streak is 0
      currentStreak = 0
    }
  }

  // Count consecutive days backwards
  if (currentStreak === 0 && dates.has(checkDate.toISOString().split('T')[0])) {
    while (dates.has(checkDate.toISOString().split('T')[0])) {
      currentStreak++
      checkDate.setDate(checkDate.getDate() - 1)
    }
  }

  // Calculate longest streak
  let longestStreak = 0
  let tempStreak = 0
  let prevDate: Date | null = null

  // Sort dates ascending for longest streak calculation
  const sortedDates = Array.from(dates).sort()

  for (const dateStr of sortedDates) {
    const currentDate = new Date(dateStr + 'T00:00:00.000Z')

    if (prevDate === null) {
      tempStreak = 1
    } else {
      const diffDays = Math.round(
        (currentDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24)
      )

      if (diffDays === 1) {
        tempStreak++
      } else {
        tempStreak = 1
      }
    }

    longestStreak = Math.max(longestStreak, tempStreak)
    prevDate = currentDate
  }

  return { currentStreak, longestStreak, lastEntryDate }
}

// ============================================================================
// Bulk Operations
// ============================================================================

/**
 * Delete all journal entries from cache.
 * Used for cache rebuild.
 */
export function clearJournalCache(db: DrizzleDb): void {
  db.delete(journalCache).run()
}

/**
 * Get total count of journal entries.
 */
export function countJournalEntries(db: DrizzleDb): number {
  const result = db.select({ count: count() }).from(journalCache).get()
  return result?.count ?? 0
}

/**
 * List all journal entries (for indexing/rebuild).
 */
export function listAllJournalEntries(db: DrizzleDb): JournalCache[] {
  return db.select().from(journalCache).orderBy(desc(journalCache.date)).all()
}
