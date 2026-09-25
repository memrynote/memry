import { eq, desc, and, like, sql, count } from 'drizzle-orm'
import { noteCache, type NoteCache } from '@memry/db-schema/schema/notes-cache'
import { parseJournalDate, formatJournalFilename } from '@memry/storage-vault'
import type { IndexDb } from '../../types'
import { type ActivityLevel, calculateActivityLevel } from './query-helpers'
import { getJournalConfig } from '@main/vault/journal-config'
import { computeJournalStreak, utcDateKey, yearMonthStats } from '@memry/domain-notes/journal'

// ============================================================================
// Journal Entry Utilities
//
// A journal entry is a direct child of the configured journal folder whose
// filename matches the configured journal date format. Config comes from
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

  // The per-month aggregation (and the averageLevel rule) lives in
  // `@memry/domain-notes/journal` so the iOS core is held to it by vectors.
  const rows = db
    .select({
      date: noteCache.date,
      wordCount: noteCache.wordCount,
      characterCount: noteCache.characterCount
    })
    .from(noteCache)
    .where(and(sql`${noteCache.date} IS NOT NULL`, like(noteCache.date, `${yearPrefix}%`)))
    .all()
    .map((row) => ({
      date: row.date!,
      wordCount: row.wordCount,
      characterCount: row.characterCount
    }))

  return yearMonthStats(rows)
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

  // Desktop counts from its UTC date, as it always has; the walk itself is
  // `computeJournalStreak`, shared with the iOS core through vectors.
  return computeJournalStreak(
    entries.map((e) => e.date!),
    utcDateKey(new Date())
  )
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
