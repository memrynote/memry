/**
 * Natural-language recurrence for quick-add: turns "every monday", "every 2
 * weeks" or "every weekday" into the same {@link RepeatConfig} the repeat
 * picker produces, so a repeating task can be captured without opening the
 * detail dialog.
 *
 * English only for now — a phrase in any other language simply does not parse
 * and stays part of the task title, which is the safe failure.
 */

import type { RepeatConfig } from '@/data/task-model'
import { addDays, startOfDay } from './task-utils'

// ============================================================================
// TYPES
// ============================================================================

export interface RepeatPhraseMatch {
  /** Index of the phrase in the scanned input. */
  start: number
  /** Exclusive end index of the phrase. */
  end: number
  /** The matched text, verbatim (what the pill paints over). */
  text: string
  config: RepeatConfig
}

// ============================================================================
// CONSTANTS
// ============================================================================

const WEEKDAY_INDEXES: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6
}

/** "every" plus at most this many words — the cap on the greedy phrase scan. */
const MAX_PHRASE_WORDS = 6

const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKEND = [0, 6]

// ============================================================================
// PHRASE → CONFIG
// ============================================================================

const baseConfig = (): Omit<RepeatConfig, 'frequency' | 'interval'> => ({
  endType: 'never',
  completedCount: 0,
  createdAt: new Date()
})

/** "other" reads as every second; a plain number is the interval it spells. */
const parseInterval = (raw: string | undefined): number | null => {
  if (raw === undefined) return 1
  if (raw === 'other') return 2
  if (!/^\d+$/.test(raw)) return null
  const value = Number.parseInt(raw, 10)
  return value >= 1 && value <= 999 ? value : null
}

const parseWeekdayList = (rest: string): number[] | null => {
  const words = rest
    .replace(/\band\b/g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
  if (words.length === 0) return null

  const days = new Set<number>()
  for (const word of words) {
    const index = WEEKDAY_INDEXES[word]
    if (index === undefined) return null
    days.add(index)
  }
  return [...days].sort((a, b) => a - b)
}

/**
 * Parse a full "every …" phrase. `anchor` supplies the day-of-month a bare
 * "every month" repeats on — pass the task's due date when it has one.
 */
export const parseRepeatPhrase = (
  phrase: string,
  anchor: Date = new Date()
): RepeatConfig | null => {
  const normalized = phrase.toLowerCase().replace(/\s+/g, ' ').trim()
  const everyMatch = /^every\s+(.+)$/.exec(normalized)
  if (!everyMatch) return null

  const rest = everyMatch[1]

  // "every weekday" / "every weekend" — fixed day sets, no interval.
  if (rest === 'weekday' || rest === 'weekdays') {
    return { ...baseConfig(), frequency: 'weekly', interval: 1, daysOfWeek: WEEKDAYS }
  }
  if (rest === 'weekend' || rest === 'weekends') {
    return { ...baseConfig(), frequency: 'weekly', interval: 1, daysOfWeek: WEEKEND }
  }

  // "every day", "every 2 weeks", "every other month", "every year".
  const unitMatch = /^(?:(\d+|other)\s+)?(day|week|month|year)s?$/.exec(rest)
  if (unitMatch) {
    const interval = parseInterval(unitMatch[1])
    if (interval === null) return null

    switch (unitMatch[2]) {
      case 'day':
        return { ...baseConfig(), frequency: 'daily', interval }
      case 'week':
        return { ...baseConfig(), frequency: 'weekly', interval }
      case 'month':
        return {
          ...baseConfig(),
          frequency: 'monthly',
          interval,
          monthlyType: 'dayOfMonth',
          dayOfMonth: anchor.getDate()
        }
      default:
        return { ...baseConfig(), frequency: 'yearly', interval }
    }
  }

  // "every monday", "every mon and fri", "every other tuesday".
  const dayListMatch = /^(?:(\d+|other)\s+)?(.+)$/.exec(rest)
  if (dayListMatch) {
    const interval = parseInterval(dayListMatch[1])
    const daysOfWeek = parseWeekdayList(dayListMatch[2])
    if (interval !== null && daysOfWeek !== null) {
      return { ...baseConfig(), frequency: 'weekly', interval, daysOfWeek }
    }
  }

  return null
}

// ============================================================================
// PHRASE LOOKUP
// ============================================================================

/**
 * Find the first "every …" run in the input that reads as a recurrence.
 *
 * Longest match wins, so "water plants every 2 weeks at noon" keeps "at noon"
 * in the title while "every 2 weeks" becomes the config. A run that does not
 * parse ("every door") is left alone entirely.
 */
export const findRepeatPhrase = (
  input: string,
  anchor: Date = new Date()
): RepeatPhraseMatch | null => {
  for (const every of input.matchAll(/\bevery\b/gi)) {
    const start = every.index
    const rest = input.slice(start)
    const wordEnds = [...rest.matchAll(/\S+/g)]
      .slice(0, MAX_PHRASE_WORDS)
      .map((word) => word.index + word[0].length)

    // Two words minimum ("every day"); longest first.
    for (let count = wordEnds.length; count >= 2; count--) {
      const text = rest.slice(0, wordEnds[count - 1])
      const config = parseRepeatPhrase(text, anchor)
      if (config) return { start, end: start + text.length, text, config }
    }
  }
  return null
}

// ============================================================================
// FIRST DUE DATE
// ============================================================================

/**
 * The date a freshly captured repeating task is due on when the user typed no
 * due date of their own. A repeat only rolls forward from a due date (see
 * `use-undoable-task-actions`), so "every monday" has to land on a Monday or
 * the recurrence never fires.
 */
export const firstOccurrenceFor = (config: RepeatConfig, from: Date = new Date()): Date => {
  const start = startOfDay(from)
  const days = config.daysOfWeek
  if (config.frequency !== 'weekly' || !days || days.length === 0) return start

  for (let offset = 0; offset < 7; offset++) {
    const candidate = addDays(start, offset)
    if (days.includes(candidate.getDay())) return candidate
  }
  return start
}
