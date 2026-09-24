import type { TFunction } from 'i18next'
import { getI18n } from 'react-i18next'
import type { RepeatConfig, RepeatFrequency } from '@/data/task-model'
import { getActiveLocale } from './active-locale'
import {
  getWeekOfMonth,
  isLastWeekdayOfMonth,
  shouldCreateNextOccurrence as shouldCreateNextOccurrenceAt
} from '@memry/domain-tasks/parsing'

// The recurrence math lives in `@memry/domain-tasks/parsing` so the iOS core is
// held to it by conformance vectors (spec 004 D3, D5).
export {
  addYears,
  calculateNextOccurrence,
  calculateNextOccurrences,
  findNthWeekdayOfMonth,
  getRepeatProgress,
  getWeekOfMonth,
  isLastWeekdayOfMonth
} from '@memry/domain-tasks/parsing'

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

export const shouldCreateNextOccurrence = (config: RepeatConfig, now: Date = new Date()): boolean =>
  shouldCreateNextOccurrenceAt(config, now)
