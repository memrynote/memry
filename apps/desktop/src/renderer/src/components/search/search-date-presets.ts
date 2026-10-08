import type { DateRange } from '@memry/contracts/search-api'
import { localDayRange } from '@/lib/local-day-range'
import { toLocalDateString } from '@/components/calendar/date-utils'

export type DatePresetId = 'today' | 'this-week' | 'this-month'

/**
 * The presets used to read the date off `toISOString()` and pin it to `T00:00:00.000Z`, so both
 * the day they named and the window they covered were UTC's, not the user's (#1954). At UTC-7 a
 * note edited at 18:00 local landed on tomorrow's date and fell outside "Today" entirely.
 *
 * `search.ts` filters `modifiedAt >= from && modifiedAt <= to`, an inclusive end, while
 * `localDayRange` hands back the half-open `[start, next start)`. One millisecond back off the
 * end is what reconciles the two without letting the next day's first instant through.
 */
function localDaysBetween(from: Date, to: Date): DateRange {
  return {
    from: localDayRange(toLocalDateString(from)).startAt,
    to: new Date(Date.parse(localDayRange(toLocalDateString(to)).endAt) - 1).toISOString()
  }
}

function presetStart(id: DatePresetId, now: Date): Date {
  switch (id) {
    case 'today':
      return now
    case 'this-week': {
      const start = new Date(now)
      start.setDate(now.getDate() - now.getDay())
      return start
    }
    case 'this-month':
      return new Date(now.getFullYear(), now.getMonth(), 1)
  }
}

export const DATE_PRESET_IDS: readonly DatePresetId[] = ['today', 'this-week', 'this-month']

export function datePresetRange(id: DatePresetId, now = new Date()): DateRange {
  return localDaysBetween(presetStart(id, now), now)
}

/** Readable span for a preset, e.g. "Jul 14" or "Jul 12 – 14". */
export function datePresetSpan(id: DatePresetId, locale: string, now = new Date()): string {
  const format = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
  const start = presetStart(id, now)
  return id === 'today' ? format.format(now) : format.formatRange(start, now)
}

export function datePresetFor(range: DateRange | null): DatePresetId | null {
  if (!range) return null
  return (
    DATE_PRESET_IDS.find((id) => {
      const preset = datePresetRange(id)
      return preset.from === range.from && preset.to === range.to
    }) ?? null
  )
}
