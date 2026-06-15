import { eq, desc, and, like, sql, count } from 'drizzle-orm'
import { noteCache, type NoteCache } from '@memry/db-schema/schema/notes-cache'
import { parseJournalDate, formatJournalFilename } from '@memry/storage-vault'
import type { IndexDb } from '../../types'
import { type ActivityLevel, ACTIVITY_THRESHOLDS, calculateActivityLevel } from './query-helpers'
import { getJournalConfig } from '@main/vault/journal-config'

// ============================================================================
// Journal Entry Utilities
//
// A journal entry is a direct child of the configured journal folder whose
// filename matches the configured Obsidian-style date format. Config comes from
// the journal-config holder, kept in sync by the vault's getConfig().
// ============================================================================

function normalizeFolder(folder: string): string {
  return folder.endsWith('/') ? folder.slice(0, -1) : folder
}

/** Filename stem (no extension) when `path` is a direct child of the journal folder. */
function journalStem(path: string): string | null {
  const folder = normalizeFolder(getJournalConfig().journalFolder)
  if (!folder) return null
  const prefix = `${folder}/`
  if (!path.startsWith(prefix)) return null
  const rest = path.slice(prefix.length)
  if (rest.includes('/') || !rest.endsWith('.md')) return null
  return rest.slice(0, -3)
}

export function isJournalEntry(path: string): boolean {
  // Range-validate via parseJournalDate so detection and date extraction agree
  // (a regex-only match like journal/2026-13-01.md is NOT a journal entry).
  return extractDateFromPath(path) !== null
}

export function extractDateFromPath(path: string): string | null {
  const stem = journalStem(path)
  if (stem === null) return null
  return parseJournalDate(stem, getJournalConfig().journalDateFormat)
}

export function generateJournalPath(date: string): string {
  const { journalFolder, journalDateFormat } = getJournalConfig()
  const folder = normalizeFolder(journalFolder)
  const filename = formatJournalFilename(date, journalDateFormat)
  return folder ? `${folder}/${filename}.md` : `${filename}.md`
}

export function generateJournalId(date: string): string {
  return `j${date}`
}

// ============================================================================
// Journal Cache Queries
// ============================================================================

export function getJournalEntryByDate(db: IndexDb, date: string): NoteCache | undefined {
  return db.select().from(noteCache).where(eq(noteCache.date, date)).get()
}

export function journalEntryExistsByDate(db: IndexDb, date: string): boolean {
  const result = db
    .select({ id: noteCache.id })
    .from(noteCache)
    .where(eq(noteCache.date, date))
    .get()
  return result !== undefined
}

export function getHeatmapData(
  db: IndexDb,
  year: number
): { date: string; characterCount: number; level: ActivityLevel }[] {
  const startDate = `${year}-01-01`
  const endDate = `${year}-12-31`

  return db
    .select({
      date: noteCache.date,
      characterCount: noteCache.characterCount
    })
    .from(noteCache)
    .where(
      and(
        sql`${noteCache.date} IS NOT NULL`,
        sql`${noteCache.date} >= ${startDate}`,
        sql`${noteCache.date} <= ${endDate}`
      )
    )
    .orderBy(noteCache.date)
    .all()
    .map((row) => ({
      date: row.date!,
      characterCount: row.characterCount ?? 0,
      level: calculateActivityLevel(row.characterCount ?? 0)
    }))
}

export function getJournalMonthEntries(db: IndexDb, year: number, month: number): NoteCache[] {
  const monthStr = String(month).padStart(2, '0')
  const monthPrefix = `${year}-${monthStr}-`
  return db
    .select()
    .from(noteCache)
    .where(and(sql`${noteCache.date} IS NOT NULL`, like(noteCache.date, `${monthPrefix}%`)))
    .orderBy(desc(noteCache.date))
    .all()
}

export function getJournalYearStats(
  db: IndexDb,
  year: number
): {
  month: number
  entryCount: number
  totalWordCount: number
  totalCharacterCount: number
  averageLevel: number
}[] {
  const yearPrefix = `${year}-`

  return db
    .select({
      month: sql<number>`CAST(substr(${noteCache.date}, 6, 2) AS INTEGER)`,
      entryCount: sql<number>`COUNT(*)`,
      totalWordCount: sql<number>`COALESCE(SUM(${noteCache.wordCount}), 0)`,
      totalCharacterCount: sql<number>`COALESCE(SUM(${noteCache.characterCount}), 0)`,
      // Thresholds mirror ACTIVITY_THRESHOLDS in query-helpers.ts
      averageLevel: sql<number>`COALESCE(AVG(CASE
        WHEN ${noteCache.characterCount} = 0 THEN 0
        WHEN ${noteCache.characterCount} <= ${ACTIVITY_THRESHOLDS.MINIMAL} THEN 1
        WHEN ${noteCache.characterCount} <= ${ACTIVITY_THRESHOLDS.LIGHT} THEN 2
        WHEN ${noteCache.characterCount} <= ${ACTIVITY_THRESHOLDS.MODERATE} THEN 3
        ELSE 4
      END), 0)`
    })
    .from(noteCache)
    .where(and(sql`${noteCache.date} IS NOT NULL`, like(noteCache.date, `${yearPrefix}%`)))
    .groupBy(sql`substr(${noteCache.date}, 6, 2)`)
    .all()
    .map((e) => ({
      month: e.month,
      entryCount: e.entryCount,
      totalWordCount: e.totalWordCount,
      totalCharacterCount: e.totalCharacterCount,
      averageLevel: Math.round(e.averageLevel * 100) / 100
    }))
}

export function getJournalStreak(db: IndexDb): {
  currentStreak: number
  longestStreak: number
  lastEntryDate: string | null
} {
  const entries = db
    .select({ date: noteCache.date })
    .from(noteCache)
    .where(sql`${noteCache.date} IS NOT NULL`)
    .orderBy(desc(noteCache.date))
    .all()

  if (entries.length === 0) {
    return { currentStreak: 0, longestStreak: 0, lastEntryDate: null }
  }

  const lastEntryDate = entries[0].date!
  const dates = new Set(entries.map((e) => e.date!))

  const formatDateUtc = (date: Date) => date.toISOString().slice(0, 10)
  const addDaysUtc = (dateStr: string, delta: number) => {
    const date = new Date(`${dateStr}T00:00:00.000Z`)
    date.setUTCDate(date.getUTCDate() + delta)
    return formatDateUtc(date)
  }

  let currentStreak = 0
  const todayStr = formatDateUtc(new Date())
  let checkDateStr: string | null = todayStr

  if (!dates.has(todayStr)) {
    const yesterdayStr = addDaysUtc(todayStr, -1)
    checkDateStr = dates.has(yesterdayStr) ? yesterdayStr : null
  }

  if (checkDateStr) {
    let cursor = checkDateStr
    while (dates.has(cursor)) {
      currentStreak++
      cursor = addDaysUtc(cursor, -1)
    }
  }

  let longestStreak = 0
  let tempStreak = 0
  let prevDate: Date | null = null

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

export function listJournalEntries(db: IndexDb): NoteCache[] {
  return db
    .select()
    .from(noteCache)
    .where(sql`${noteCache.date} IS NOT NULL`)
    .orderBy(desc(noteCache.date))
    .all()
}

export function listJournalEntriesInRange(db: IndexDb, from: string, to: string): NoteCache[] {
  return db
    .select()
    .from(noteCache)
    .where(and(sql`${noteCache.date} >= ${from}`, sql`${noteCache.date} <= ${to}`))
    .orderBy(desc(noteCache.date))
    .all()
}

export function countJournalEntries(db: IndexDb): number {
  const result = db
    .select({ count: count() })
    .from(noteCache)
    .where(sql`${noteCache.date} IS NOT NULL`)
    .get()
  return result?.count ?? 0
}

export function clearJournalCache(db: IndexDb): void {
  db.delete(noteCache)
    .where(sql`${noteCache.date} IS NOT NULL`)
    .run()
}
