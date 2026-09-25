/**
 * Month and year arithmetic for the journal's Month and Year views.
 *
 * Pure: no clock (`today` is passed in as a `YYYY-MM-DD` key), no locale
 * (month names stay in the renderer). Moved from
 * `apps/desktop/src/renderer/src/lib/journal-utils.ts` and the `averageLevel`
 * rule of `getJournalYearStats` so the iOS core is held to them by the
 * `journal.json` vectors.
 *
 * @module journal/stats
 */

import { calculateActivityLevel, type ActivityLevel } from '@memry/contracts/journal-api'

/** One day of a month, relative to `today`. */
export interface JournalMonthDay {
  /** `YYYY-MM-DD` */
  date: string
  isToday: boolean
  isFuture: boolean
}

/** One day of the heatmap: its characters and their activity level. */
export interface JournalHeatmapDay {
  date: string
  characterCount: number
  level: ActivityLevel
}

/** The Year view's card for one month (`getMonthStats` without its label). */
export interface JournalMonthActivity {
  /** 0-11 */
  month: number
  /** Days of the month whose entry has at least one character. */
  entryCount: number
  totalChars: number
  /** Highest level per 7-day block from the 1st, at most 5 blocks. */
  activityDots: ActivityLevel[]
}

/** One day's counts, as the index row carries them. */
export interface JournalDayCounts {
  date: string
  wordCount: number | null
  characterCount: number | null
}

/** `getJournalYearStats`' row for one month that has entries. */
export interface JournalYearMonthStats {
  /** 1-12 */
  month: number
  entryCount: number
  totalWordCount: number
  totalCharacterCount: number
  /** Mean of the per-day activity levels, rounded to two decimals. */
  averageLevel: number
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** Days in a month, `month` 0-11. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/** Every day of `month` (0-11), flagged against `today`. */
export function monthDays(year: number, month: number, today: string): JournalMonthDay[] {
  const days: JournalMonthDay[] = []
  const count = daysInMonth(year, month)
  for (let day = 1; day <= count; day++) {
    const date = `${year}-${pad2(month + 1)}-${pad2(day)}`
    days.push({ date, isToday: date === today, isFuture: date > today })
  }
  return days
}

/** The heatmap entry for one day's character count. */
export function heatmapDay(date: string, characterCount: number): JournalHeatmapDay {
  return { date, characterCount, level: calculateActivityLevel(characterCount) }
}

/** The twelve Year-view cards for `year`, from that year's heatmap. */
export function monthActivity(
  year: number,
  heatmapData: ReadonlyArray<{ date: string; characterCount: number; level: ActivityLevel }>
): JournalMonthActivity[] {
  const stats: JournalMonthActivity[] = []
  for (let month = 0; month < 12; month++) {
    const monthPrefix = `${year}-${pad2(month + 1)}`
    const monthEntries = heatmapData.filter((entry) => entry.date.startsWith(monthPrefix))

    const entryCount = monthEntries.filter((e) => e.characterCount > 0).length
    const totalChars = monthEntries.reduce((sum, e) => sum + e.characterCount, 0)

    const count = daysInMonth(year, month)
    const weekCount = Math.ceil(count / 7)
    const activityDots: ActivityLevel[] = []
    for (let week = 0; week < Math.min(weekCount, 5); week++) {
      const weekStart = week * 7 + 1
      const weekEnd = Math.min(weekStart + 6, count)
      let maxLevel: ActivityLevel = 0
      for (let day = weekStart; day <= weekEnd; day++) {
        const dateStr = `${year}-${pad2(month + 1)}-${pad2(day)}`
        const entry = monthEntries.find((e) => e.date === dateStr)
        if (entry && entry.level > maxLevel) {
          maxLevel = entry.level
        }
      }
      activityDots.push(maxLevel)
    }

    stats.push({ month, entryCount, totalChars, activityDots })
  }
  return stats
}

/** Mean activity level of a set of days, rounded to two decimals; 0 when empty. */
// A NULL `character_count` counts as 0 here. Desktop's old SQL `CASE` fell
// through to level 4 for NULL; 0 is the honest reading and matches the core.
export function averageActivityLevel(characterCounts: ReadonlyArray<number | null>): number {
  if (characterCounts.length === 0) return 0
  const sum = characterCounts.reduce<number>(
    (total, count) => total + calculateActivityLevel(count ?? 0),
    0
  )
  return Math.round((sum / characterCounts.length) * 100) / 100
}

/**
 * `getJournalYearStats` over already-selected rows of one year: one row per
 * month that has at least one entry, in month order.
 */
export function yearMonthStats(days: ReadonlyArray<JournalDayCounts>): JournalYearMonthStats[] {
  const byMonth = new Map<number, JournalDayCounts[]>()
  for (const day of days) {
    const month = Number(day.date.slice(5, 7))
    const bucket = byMonth.get(month)
    if (bucket) bucket.push(day)
    else byMonth.set(month, [day])
  }
  return Array.from(byMonth.keys())
    .sort((a, b) => a - b)
    .map((month) => {
      const rows = byMonth.get(month) ?? []
      return {
        month,
        entryCount: rows.length,
        totalWordCount: rows.reduce((sum, row) => sum + (row.wordCount ?? 0), 0),
        totalCharacterCount: rows.reduce((sum, row) => sum + (row.characterCount ?? 0), 0),
        averageLevel: averageActivityLevel(rows.map((row) => row.characterCount))
      }
    })
}
