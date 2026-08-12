/**
 * NotePlan calendar filename classification.
 *
 * NotePlan names its calendar files by period: `20260812.txt` for a day,
 * `2026-W33` / `2026-08` / `2026-Q3` / `2026` for the wider ones. Only day
 * files map onto a Memry journal entry (the journal is day-keyed); the rest
 * become ordinary notes.
 *
 * Pure — no fs access.
 */

export type CalendarKind = 'day' | 'week' | 'month' | 'quarter' | 'year'

export interface CalendarFile {
  kind: CalendarKind
  /** ISO `YYYY-MM-DD`. Set only when `kind` is `'day'`. */
  iso?: string
  /** Display label — used verbatim as the note title for non-day files. */
  label: string
}

const DAY_RE = /^(\d{4})(\d{2})(\d{2})$/
const WEEK_RE = /^(\d{4})-W(\d{2})$/
const MONTH_RE = /^(\d{4})-(\d{2})$/
const QUARTER_RE = /^(\d{4})-Q([1-4])$/
const YEAR_RE = /^\d{4}$/

/** True when y-m-d is a real calendar date (rejects 2026-02-31, month 13, day 0). */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  )
}

export function classifyCalendarStem(stem: string): CalendarFile | null {
  const day = DAY_RE.exec(stem)
  if (day) {
    const [, y, m, d] = day
    if (!isRealDate(Number(y), Number(m), Number(d))) return null
    const iso = `${y}-${m}-${d}`
    return { kind: 'day', iso, label: iso }
  }

  const week = WEEK_RE.exec(stem)
  if (week) {
    const w = Number(week[2])
    // ISO 8601 allows weeks 1–53.
    if (w < 1 || w > 53) return null
    return { kind: 'week', label: stem }
  }

  const quarter = QUARTER_RE.exec(stem)
  if (quarter) return { kind: 'quarter', label: stem }

  // Checked after the week and quarter forms, which are also `YYYY-XX`.
  const month = MONTH_RE.exec(stem)
  if (month) {
    const m = Number(month[2])
    if (m < 1 || m > 12) return null
    return { kind: 'month', label: stem }
  }

  if (YEAR_RE.test(stem)) return { kind: 'year', label: stem }

  return null
}
