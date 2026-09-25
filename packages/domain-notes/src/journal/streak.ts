/**
 * The journal streak: consecutive days with an entry.
 *
 * Pure: the caller supplies `today` as a `YYYY-MM-DD` calendar key. Desktop
 * passes its UTC date (`getJournalStreak`, unchanged behaviour); the phone
 * passes the device's local date (spec 005-journal D3). Day arithmetic runs on
 * calendar keys through UTC dates, so no time zone can shift a day.
 *
 * @module journal/streak
 */

export interface JournalStreak {
  currentStreak: number
  longestStreak: number
  lastEntryDate: string | null
}

/** `YYYY-MM-DD` of a UTC instant. What desktop has always used for "today". */
export function utcDateKey(instant: Date): string {
  return instant.toISOString().slice(0, 10)
}

/** `dateKey` moved by `delta` calendar days. */
export function addDaysToKey(dateKey: string, delta: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return utcDateKey(date)
}

/**
 * Current and longest runs over a set of entry dates.
 *
 * The current run counts back from `today` when today has an entry, otherwise
 * from yesterday when yesterday has one, otherwise it is 0. The longest run is
 * the longest chain of consecutive dates anywhere in the set.
 */
export function computeJournalStreak(dates: Iterable<string>, today: string): JournalStreak {
  const set = new Set(dates)
  if (set.size === 0) {
    return { currentStreak: 0, longestStreak: 0, lastEntryDate: null }
  }

  const sortedDates = Array.from(set).sort()
  const lastEntryDate = sortedDates[sortedDates.length - 1]

  let currentStreak = 0
  let checkDateStr: string | null = today
  if (!set.has(today)) {
    const yesterdayStr = addDaysToKey(today, -1)
    checkDateStr = set.has(yesterdayStr) ? yesterdayStr : null
  }
  if (checkDateStr) {
    let cursor = checkDateStr
    while (set.has(cursor)) {
      currentStreak++
      cursor = addDaysToKey(cursor, -1)
    }
  }

  let longestStreak = 0
  let tempStreak = 0
  let prevDate: Date | null = null
  for (const dateStr of sortedDates) {
    const currentDate = new Date(dateStr + 'T00:00:00.000Z')
    if (prevDate === null) {
      tempStreak = 1
    } else {
      const diffDays = Math.round(
        (currentDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24)
      )
      tempStreak = diffDays === 1 ? tempStreak + 1 : 1
    }
    longestStreak = Math.max(longestStreak, tempStreak)
    prevDate = currentDate
  }

  return { currentStreak, longestStreak, lastEntryDate }
}
