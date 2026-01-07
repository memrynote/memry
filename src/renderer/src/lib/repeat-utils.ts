import type { RepeatConfig, RepeatFrequency, RepeatEndType, MonthlyType } from '@/data/sample-tasks'
import {
  addDays,
  addWeeks,
  addMonths,
  startOfDay,
  isBefore,
  isAfter,
  endOfMonth,
  subDays
} from './task-utils'

// ============================================================================
// CONSTANTS
// ============================================================================

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
]
export const SHORT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'last']

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

export const getRepeatDisplayText = (config: RepeatConfig): string => {
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
      return interval === 1 ? 'Every day' : `Every ${interval} days`

    case 'weekly':
      if (!daysOfWeek || daysOfWeek.length === 0) {
        return interval === 1 ? 'Every week' : `Every ${interval} weeks`
      }

      // Check for weekdays (Mon-Fri)
      if (daysOfWeek.length === 5 && [1, 2, 3, 4, 5].every((d) => daysOfWeek.includes(d))) {
        return interval === 1 ? 'Every weekday' : `Every ${interval} weeks on weekdays`
      }

      // Check for weekends (Sat-Sun)
      if (daysOfWeek.length === 2 && daysOfWeek.includes(0) && daysOfWeek.includes(6)) {
        return interval === 1 ? 'Every weekend' : `Every ${interval} weeks on weekends`
      }

      const daysList = [...daysOfWeek]
        .sort((a, b) => a - b)
        .map((d) => (daysOfWeek.length > 2 ? SHORT_DAY_NAMES[d] : DAY_NAMES[d]))
        .join(', ')

      return interval === 1 ? `Every week on ${daysList}` : `Every ${interval} weeks on ${daysList}`

    case 'monthly':
      if (monthlyType === 'dayOfMonth' && dayOfMonth) {
        const suffix = getOrdinalSuffix(dayOfMonth)
        return interval === 1
          ? `Every month on the ${dayOfMonth}${suffix}`
          : `Every ${interval} months on the ${dayOfMonth}${suffix}`
      } else if (monthlyType === 'weekPattern' && weekOfMonth && dayOfWeekForMonth !== undefined) {
        const weekText = ORDINALS[weekOfMonth]
        const dayText = DAY_NAMES[dayOfWeekForMonth]
        return interval === 1
          ? `Every month on the ${weekText} ${dayText}`
          : `Every ${interval} months on the ${weekText} ${dayText}`
      }
      return interval === 1 ? 'Every month' : `Every ${interval} months`

    case 'yearly':
      return interval === 1 ? 'Every year' : `Every ${interval} years`

    default:
      return 'Repeats'
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
  const today = dueDate || new Date()
  const dayOfWeek = today.getDay()
  const dayOfMonth = today.getDate()
  const weekOfMonth = getWeekOfMonth(today)
  const isLast = isLastWeekdayOfMonth(today)

  const dayName = DAY_NAMES[dayOfWeek]
  const weekText = isLast ? 'last' : ORDINALS[weekOfMonth]
  const monthName = today.toLocaleDateString('en-US', { month: 'long' })

  const baseConfig: Omit<RepeatConfig, 'frequency' | 'interval'> = {
    endType: 'never',
    completedCount: 0,
    createdAt: new Date()
  }

  return [
    {
      id: 'daily',
      label: 'Every day',
      config: {
        ...baseConfig,
        frequency: 'daily',
        interval: 1
      }
    },
    {
      id: 'weekdays',
      label: 'Every weekday (Mon-Fri)',
      config: {
        ...baseConfig,
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [1, 2, 3, 4, 5]
      }
    },
    {
      id: 'weekly',
      label: `Every week on ${dayName}`,
      config: {
        ...baseConfig,
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [dayOfWeek]
      }
    },
    {
      id: 'biweekly',
      label: `Every 2 weeks on ${dayName}`,
      config: {
        ...baseConfig,
        frequency: 'weekly',
        interval: 2,
        daysOfWeek: [dayOfWeek]
      }
    },
    {
      id: 'monthly-day',
      label: `Every month on the ${dayOfMonth}${getOrdinalSuffix(dayOfMonth)}`,
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
      label: `Every month on the ${weekText} ${dayName}`,
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
      label: `Every year on ${monthName} ${dayOfMonth}`,
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
