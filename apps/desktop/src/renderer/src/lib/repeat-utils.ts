import type { TFunction } from 'i18next'
import { getI18n } from 'react-i18next'
import type { RepeatConfig, RepeatFrequency } from '@/data/task-model'
import { getActiveLocale } from './active-locale'
import {
  addDays,
  addWeeks,
  addMonths,
  startOfDay,
  isAfter,
  endOfMonth,
  subDays
} from './task-utils'

/**
 * Translator function from the `common` namespace, used to localize
 * recurrence labels in `getRepeatDisplayText`. Callers pass the result of
 * `useT('common').t` (or `i18next.getFixedT(null, 'common')` in tests) so this
 * pure utility stays React-free.
 */
export type RepeatLabelTranslator = TFunction<'common'>

// ============================================================================
// CONSTANTS
// ============================================================================

// January 7 2024 is a Sunday, so these seven UTC days spell out a full week in
// the Sunday-first order the repeat pickers index by.
const WEEK_REFERENCE_DAYS = Array.from(
  { length: 7 },
  (_, index) => new Date(Date.UTC(2024, 0, 7 + index))
)

/**
 * Array-shaped label list whose entries are resolved on read. Building them once
 * at import time would freeze them to the fallback locale, because
 * `setActiveLocale` (and i18next itself) only run after the module graph has
 * been evaluated. Kept array-shaped because callers index and `.map()` over
 * these constants.
 */
const lazyLabels = (length: number, build: () => string[]): string[] => {
  let builtFor: string | null = null
  let built: string[] = []

  const resolve = (): string[] => {
    const locale = getActiveLocale()
    if (locale !== builtFor) {
      built = build()
      builtFor = locale
    }
    return built
  }

  const labels = new Array<string>(length)
  for (let index = 0; index < length; index++) {
    Object.defineProperty(labels, index, {
      get: () => resolve()[index],
      enumerable: true,
      configurable: true
    })
  }
  return labels
}

const buildWeekdayNames = (style: 'long' | 'short'): string[] => {
  const formatter = new Intl.DateTimeFormat(getActiveLocale(), {
    weekday: style,
    timeZone: 'UTC'
  })
  return WEEK_REFERENCE_DAYS.map((day) => formatter.format(day))
}

export const DAY_NAMES = lazyLabels(7, () => buildWeekdayNames('long'))
export const SHORT_DAY_NAMES = lazyLabels(7, () => buildWeekdayNames('short'))
export const ORDINALS = lazyLabels(6, () => {
  const t = getI18n().getFixedT(null, 'common')
  return [
    '',
    t('recurrence.ordinal.first'),
    t('recurrence.ordinal.second'),
    t('recurrence.ordinal.third'),
    t('recurrence.ordinal.fourth'),
    t('recurrence.ordinal.last')
  ]
})

// ============================================================================
// HELPER: GET ORDINAL SUFFIX
// ============================================================================

export const getOrdinalSuffix = (n: number): string => {
  if (n >= 11 && n <= 13) return 'th'
  switch (n % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

/**
 * `recurrence.everyNMonthsOnDay` interpolates `{day}{suffix}`, and the suffix
 * list above is English-only, so feeding it to a translated frame produced
 * "Jeden Monat auf dem 10th". A bare day number is the closer fallback in every
 * other language until that key is rewritten as an ICU `selectordinal`, which
 * needs all 32 locales retranslated.
 */
const daySuffixForActiveLocale = (day: number): string =>
  getActiveLocale() === 'en' ? getOrdinalSuffix(day) : ''

// ============================================================================
// HELPER: GET WEEK OF MONTH FOR DATE
// ============================================================================

export const getWeekOfMonth = (date: Date): number => {
  const dayOfMonth = date.getDate()
  return Math.ceil(dayOfMonth / 7)
}

// ============================================================================
// HELPER: CHECK IF DATE IS LAST OCCURRENCE OF WEEKDAY IN MONTH
// ============================================================================

export const isLastWeekdayOfMonth = (date: Date): boolean => {
  const nextWeek = addDays(date, 7)
  return nextWeek.getMonth() !== date.getMonth()
}

// ============================================================================
// HELPER: GET NTH WEEKDAY OF MONTH
// ============================================================================

export const findNthWeekdayOfMonth = (
  year: number,
  month: number,
  nth: number, // 1-4 or 5 for last
  dayOfWeek: number // 0-6
): Date => {
  if (nth === 5) {
    // Last occurrence - start from end of month
    const lastDay = endOfMonth(new Date(year, month, 1))
    let current = lastDay

    while (current.getDay() !== dayOfWeek) {
      current = subDays(current, 1)
    }

    return startOfDay(current)
  }

  // Find first occurrence of day in month
  let first = new Date(year, month, 1)
  while (first.getDay() !== dayOfWeek) {
    first = addDays(first, 1)
  }

  // Add weeks to get to nth
  return startOfDay(addWeeks(first, nth - 1))
}

// ============================================================================
// HELPER: ADD YEARS TO DATE
// ============================================================================

export const addYears = (date: Date, years: number): Date => {
  const result = new Date(date)
  result.setFullYear(result.getFullYear() + years)
  return result
}

// ============================================================================
// CALCULATE NEXT OCCURRENCE
// ============================================================================

export const calculateNextOccurrence = (fromDate: Date, config: RepeatConfig): Date | null => {
  const {
    frequency,
    interval,
    daysOfWeek,
    monthlyType,
    dayOfMonth,
    weekOfMonth,
    dayOfWeekForMonth
  } = config

  let next: Date

  switch (frequency) {
    case 'daily':
      next = addDays(fromDate, interval)
      break

    case 'weekly':
      if (daysOfWeek && daysOfWeek.length > 0) {
        // Find next matching day
        next = findNextWeekday(fromDate, daysOfWeek, interval)
      } else {
        next = addWeeks(fromDate, interval)
      }
      break

    case 'monthly':
      if (monthlyType === 'dayOfMonth' && dayOfMonth) {
        next = addMonths(fromDate, interval)
        // Clamp to valid day of month
        const daysInMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
        const targetDay = Math.min(dayOfMonth, daysInMonth)
        next.setDate(targetDay)
      } else if (monthlyType === 'weekPattern' && weekOfMonth && dayOfWeekForMonth !== undefined) {
        // Find nth weekday of next month
        const nextMonth = addMonths(fromDate, interval)
        next = findNthWeekdayOfMonth(
          nextMonth.getFullYear(),
          nextMonth.getMonth(),
          weekOfMonth,
          dayOfWeekForMonth
        )
      } else {
        next = addMonths(fromDate, interval)
      }
      break

    case 'yearly':
      next = addYears(fromDate, interval)
      break

    default:
      return null
  }

  // Check end conditions
  if (config.endType === 'date' && config.endDate && isAfter(next, config.endDate)) {
    return null
  }

  if (config.endType === 'count' && config.endCount && config.completedCount >= config.endCount) {
    return null
  }

  return startOfDay(next)
}

// ============================================================================
// HELPER: FIND NEXT WEEKDAY
// ============================================================================

const findNextWeekday = (fromDate: Date, daysOfWeek: number[], interval: number): Date => {
  const sortedDays = [...daysOfWeek].sort((a, b) => a - b)
  const currentDay = fromDate.getDay()

  // First, check if there's another day in the same week (for interval = 1)
  if (interval === 1) {
    const nextDayInWeek = sortedDays.find((d) => d > currentDay)
    if (nextDayInWeek !== undefined) {
      return addDays(fromDate, nextDayInWeek - currentDay)
    }
  }

  // Move to the next interval week and pick the first day
  const daysUntilEndOfWeek = 6 - currentDay
  const daysToNextWeek = daysUntilEndOfWeek + 1 + (interval - 1) * 7
  const startOfNextWeek = addDays(fromDate, daysToNextWeek)

  // Find the first matching day in that week
  const firstDay = sortedDays[0]
  const targetDate = addDays(startOfNextWeek, firstDay)

  return targetDate
}

// ============================================================================
// CALCULATE NEXT N OCCURRENCES (FOR PREVIEW)
// ============================================================================

export const calculateNextOccurrences = (
  startDate: Date,
  config: RepeatConfig,
  count: number = 5
): Date[] => {
  const occurrences: Date[] = []
  let current = startOfDay(startDate)
  let generated = 0

  // Add the start date as the first occurrence
  occurrences.push(current)
  generated++

  while (occurrences.length < count && generated < 100) {
    // Check end conditions before calculating next
    if (config.endType === 'date' && config.endDate && isAfter(current, config.endDate)) {
      break
    }
    if (config.endType === 'count' && config.endCount && generated >= config.endCount) {
      break
    }

    const next = calculateNextOccurrence(current, config)
    if (!next) break

    occurrences.push(next)
    current = next
    generated++
  }

  return occurrences
}

// ============================================================================
// GET REPEAT DISPLAY TEXT
// ============================================================================

export const getRepeatDisplayText = (config: RepeatConfig, t: RepeatLabelTranslator): string => {
  const {
    frequency,
    interval,
    daysOfWeek,
    monthlyType,
    dayOfMonth,
    weekOfMonth,
    dayOfWeekForMonth
  } = config

  switch (frequency) {
    case 'daily':
      return t('recurrence.everyNDays', { count: interval })

    case 'weekly': {
      if (!daysOfWeek || daysOfWeek.length === 0) {
        return t('recurrence.everyNWeeks', { count: interval })
      }

      // Check for weekdays (Mon-Fri)
      if (daysOfWeek.length === 5 && [1, 2, 3, 4, 5].every((d) => daysOfWeek.includes(d))) {
        return t('recurrence.everyNWeeksOnWeekdays', { count: interval })
      }

      // Check for weekends (Sat-Sun)
      if (daysOfWeek.length === 2 && daysOfWeek.includes(0) && daysOfWeek.includes(6)) {
        return t('recurrence.everyNWeeksOnWeekends', { count: interval })
      }

      const daysList = [...daysOfWeek]
        .sort((a, b) => a - b)
        .map((d) => (daysOfWeek.length > 2 ? SHORT_DAY_NAMES[d] : DAY_NAMES[d]))
        .join(', ')

      return t('recurrence.everyNWeeksOnDays', { count: interval, days: daysList })
    }

    case 'monthly':
      if (monthlyType === 'dayOfMonth' && dayOfMonth) {
        const suffix = daySuffixForActiveLocale(dayOfMonth)
        return t('recurrence.everyNMonthsOnDay', {
          count: interval,
          day: dayOfMonth,
          suffix
        })
      } else if (monthlyType === 'weekPattern' && weekOfMonth && dayOfWeekForMonth !== undefined) {
        const weekText = ORDINALS[weekOfMonth]
        const dayText = DAY_NAMES[dayOfWeekForMonth]
        return t('recurrence.everyNMonthsOnWeekDay', {
          count: interval,
          week: weekText,
          day: dayText
        })
      }
      return t('recurrence.everyNMonths', { count: interval })

    case 'yearly':
      return t('recurrence.everyNYears', { count: interval })

    default:
      return t('recurrence.repeats')
  }
}

// ============================================================================
// GET REPEAT PRESETS BASED ON DUE DATE
// ============================================================================

export interface RepeatPreset {
  id: string
  label: string
  config: RepeatConfig
}

export const getRepeatPresets = (dueDate: Date | null): RepeatPreset[] => {
  const t = getI18n().getFixedT(null, 'common')
  const today = dueDate || new Date()
  const dayOfWeek = today.getDay()
  const dayOfMonth = today.getDate()
  const weekOfMonth = getWeekOfMonth(today)
  const isLast = isLastWeekdayOfMonth(today)

  const dayName = DAY_NAMES[dayOfWeek]
  const weekText = ORDINALS[isLast ? 5 : weekOfMonth]
  const monthDay = new Intl.DateTimeFormat(getActiveLocale(), {
    month: 'long',
    day: 'numeric'
  }).format(today)

  const baseConfig: Omit<RepeatConfig, 'frequency' | 'interval'> = {
    endType: 'never',
    completedCount: 0,
    createdAt: new Date()
  }

  return [
    {
      id: 'daily',
      label: t('recurrence.everyNDays', { count: 1 }),
      config: {
        ...baseConfig,
        frequency: 'daily',
        interval: 1
      }
    },
    {
      id: 'weekdays',
      label: t('recurrence.preset.everyWeekday'),
      config: {
        ...baseConfig,
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [1, 2, 3, 4, 5]
      }
    },
    {
      id: 'weekly',
      label: t('recurrence.everyNWeeksOnDays', { count: 1, days: dayName }),
      config: {
        ...baseConfig,
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [dayOfWeek]
      }
    },
    {
      id: 'biweekly',
      label: t('recurrence.everyNWeeksOnDays', { count: 2, days: dayName }),
      config: {
        ...baseConfig,
        frequency: 'weekly',
        interval: 2,
        daysOfWeek: [dayOfWeek]
      }
    },
    {
      id: 'monthly-day',
      label: t('recurrence.everyNMonthsOnDay', {
        count: 1,
        day: dayOfMonth,
        suffix: daySuffixForActiveLocale(dayOfMonth)
      }),
      config: {
        ...baseConfig,
        frequency: 'monthly',
        interval: 1,
        monthlyType: 'dayOfMonth',
        dayOfMonth
      }
    },
    {
      id: 'monthly-week',
      label: t('recurrence.everyNMonthsOnWeekDay', {
        count: 1,
        week: weekText,
        day: dayName
      }),
      config: {
        ...baseConfig,
        frequency: 'monthly',
        interval: 1,
        monthlyType: 'weekPattern',
        weekOfMonth: isLast ? 5 : weekOfMonth,
        dayOfWeekForMonth: dayOfWeek
      }
    },
    {
      id: 'yearly',
      label: t('recurrence.preset.everyYearOnDate', { date: monthDay }),
      config: {
        ...baseConfig,
        frequency: 'yearly',
        interval: 1
      }
    }
  ]
}

// ============================================================================
// CREATE DEFAULT REPEAT CONFIG
// ============================================================================

export const createDefaultRepeatConfig = (
  frequency: RepeatFrequency = 'weekly',
  dueDate: Date | null = null
): RepeatConfig => {
  const today = dueDate || new Date()

  return {
    frequency,
    interval: 1,
    daysOfWeek: frequency === 'weekly' ? [today.getDay()] : undefined,
    monthlyType: frequency === 'monthly' ? 'dayOfMonth' : undefined,
    dayOfMonth: frequency === 'monthly' ? today.getDate() : undefined,
    endType: 'never',
    completedCount: 0,
    createdAt: new Date()
  }
}

// ============================================================================
// CHECK IF SHOULD CREATE NEXT OCCURRENCE
// ============================================================================

export const shouldCreateNextOccurrence = (config: RepeatConfig): boolean => {
  if (config.endType === 'never') return true

  if (config.endType === 'count' && config.endCount) {
    return config.completedCount < config.endCount
  }

  if (config.endType === 'date' && config.endDate) {
    return !isAfter(new Date(), config.endDate)
  }

  return true
}

// ============================================================================
// GET PROGRESS FOR COUNT-LIMITED REPEATS
// ============================================================================

export const getRepeatProgress = (
  config: RepeatConfig
): { current: number; total: number; percentage: number } | null => {
  if (config.endType !== 'count' || !config.endCount) return null

  return {
    current: config.completedCount,
    total: config.endCount,
    percentage: Math.round((config.completedCount / config.endCount) * 100)
  }
}
