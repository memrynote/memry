/**
 * Builds the "Date" suggestion group shown by both the `@` mention menu and the
 * `/date` · `/remind` slash items: a plain-date row plus a "Remind me" row whose
 * default fires at the parsed instant — or, if that instant has already passed,
 * tomorrow at 09:00 (so `@Today` suggests "Tomorrow 9am" but `@next sunday`
 * suggests that Sunday's date).
 */

import { parseNaturalDate } from '@/lib/natural-date-parser'
import { getActiveLocale } from '@/lib/active-locale'
import { localeDateNames, toParserInput } from '@/lib/date-phrase-completion'
import { formatDateMentionLabel } from './date-mention'
import type { DateMentionValue } from './date-mention-popover'

// The inline ghost-text completion moved to `lib` so the task quick-add field
// can share it without importing the editor's BlockNote graph. Re-exported here
// because the mention plugin and its tests have always reached for it via this
// module.
export { predictDateCompletion, predictTime, isTimeInProgress } from '@/lib/date-phrase-completion'

export interface DateSuggestion {
  dateLabel: string
  dateValue: DateMentionValue
  remindSubtitle: string
  remindValue: DateMentionValue
}

function friendlyTime(d: Date): string {
  let h = d.getHours()
  const m = d.getMinutes()
  const meridiem = h < 12 ? 'am' : 'pm'
  h = h % 12 || 12
  return m ? `${h}:${String(m).padStart(2, '0')}${meridiem}` : `${h}${meridiem}`
}

function longDate(d: Date): string {
  const month = d.toLocaleDateString(getActiveLocale(), { month: 'long' })
  return `${d.getDate()} ${month} ${d.getFullYear()}`
}

function remindSubtitle(d: Date, withTime: boolean, bumped: boolean, now: Date): string {
  if (bumped) return `Tomorrow ${friendlyTime(d)}`
  if (withTime)
    return `${formatDateMentionLabel(d.toISOString(), false, { now })} ${friendlyTime(d)}`
  return longDate(d)
}

export function buildDateSuggestions(query: string, now: Date = new Date()): DateSuggestion | null {
  const parsed = parseNaturalDate(toParserInput(query.trim() || 'today'))
  if (!parsed.success) return null

  const time = parsed.result.time
  const hasTime = time !== null
  const base = new Date(parsed.result.date)
  if (time) {
    const [h, mi] = time.split(':').map(Number)
    base.setHours(h, mi, 0, 0)
  } else {
    base.setHours(9, 0, 0, 0)
  }

  const dateValue: DateMentionValue = {
    dateISO: base.toISOString(),
    hasTime,
    dateFormat: 'relative',
    remind: 'none',
    timeFormat: 'system'
  }
  const dateLabel = formatDateMentionLabel(base.toISOString(), hasTime, {
    dateFormat: 'relative',
    now
  })

  // Reminder defaults to the parsed instant; if it's already passed, bump to
  // tomorrow 09:00.
  let remindBase = base
  let remindHasTime = hasTime
  let bumped = false
  if (base.getTime() <= now.getTime()) {
    const tomorrow = new Date(now)
    tomorrow.setDate(now.getDate() + 1)
    tomorrow.setHours(9, 0, 0, 0)
    remindBase = tomorrow
    remindHasTime = false
    bumped = true
  }

  const remindValue: DateMentionValue = {
    dateISO: remindBase.toISOString(),
    hasTime: remindHasTime,
    dateFormat: 'relative',
    remind: 'at',
    timeFormat: 'system'
  }

  return {
    dateLabel,
    dateValue,
    remindSubtitle: remindSubtitle(remindBase, remindHasTime, bumped, now),
    remindValue
  }
}

// Leading tokens that signal "a date is being typed" but may not parse on their
// own yet (connectors that need a completion, plus partial weekday/month words).
const DATE_KEYWORDS = [
  'today',
  'tomorrow',
  'tmrw',
  'tmr',
  'yesterday',
  'next',
  'last',
  'this',
  'in',
  'week',
  'weekend',
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]

function looksDateish(query: string): boolean {
  const first = query.trim().toLowerCase().split(/\s+/)[0]
  if (!first) return false
  if (/^\d/.test(first)) return true
  // Locale weekday/month names count too, so a half-typed date in the app's
  // language holds the menu open exactly like a half-typed English one.
  const names = localeDateNames()
  const keywords = [...DATE_KEYWORDS, ...names.weekdays, ...names.months].map((kw) =>
    kw.toLowerCase()
  )
  return keywords.some((kw) => kw.startsWith(first) || first.startsWith(kw))
}

// Longest leading token-prefix that parses (so "today 12p" still resolves to
// "today" while the time is mid-typed).
function bestEffortSuggestion(query: string, now: Date): DateSuggestion | null {
  const trimmed = query.trim()
  const full = buildDateSuggestions(trimmed, now)
  if (full) return full

  const tokens = trimmed.split(/\s+/)
  for (let n = tokens.length - 1; n >= 1; n--) {
    const prefix = tokens.slice(0, n).join(' ')
    const s = buildDateSuggestions(prefix, now)
    if (s) return s
  }
  return null
}

export interface DateMentionEntry {
  /** Full date+remind suggestion, or null when nothing (yet) parses. */
  suggestion: DateSuggestion | null
  /** Query looks date-ish but does not parse yet → hold the menu open. */
  hint: boolean
}

/**
 * Resilient variant of {@link buildDateSuggestions} for the `@` mention menu:
 * keeps the Date group alive through intermediate keystrokes so the user can
 * finish typing a phrase (e.g. "next monday 14:32") without the menu closing.
 */
export function buildDateMentionEntry(query: string, now: Date = new Date()): DateMentionEntry {
  const suggestion = bestEffortSuggestion(query, now)
  if (suggestion) return { suggestion, hint: false }
  return { suggestion: null, hint: looksDateish(query) }
}
