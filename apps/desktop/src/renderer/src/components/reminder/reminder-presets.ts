/**
 * Reminder Presets
 *
 * Helper functions for generating reminder preset times.
 * Used by the reminder picker component.
 *
 * @module components/reminder/reminder-presets
 */

import { getI18n } from 'react-i18next'

import { getActiveLocale } from '@/lib/active-locale'
import type { ClockFormat } from '@/lib/time-format'
import { formatTimeOfDay } from '@/lib/time-format'

// ============================================================================
// Types
// ============================================================================

export interface ReminderPreset {
  id: string
  label: string
  description?: string
  getDate: () => Date
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the next occurrence of a specific hour
 * @param hour - Hour in 24-hour format (0-23)
 * @param date - Starting date (defaults to now)
 */
export function getNextOccurrenceOfHour(hour: number, date: Date = new Date()): Date {
  const result = new Date(date)
  result.setMinutes(0, 0, 0) // Reset minutes/seconds

  if (result.getHours() >= hour) {
    // Already past that hour today, go to next day
    result.setDate(result.getDate() + 1)
  }

  result.setHours(hour)
  return result
}

/**
 * Get tomorrow at a specific hour
 */
export function getTomorrow(hour = 9): Date {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(hour, 0, 0, 0)
  return date
}

/**
 * Get next Monday at a specific hour
 */
export function getNextMonday(hour = 9): Date {
  const date = new Date()
  const dayOfWeek = date.getDay() // 0 = Sunday, 1 = Monday, ...
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek) % 7 || 7

  date.setDate(date.getDate() + daysUntilMonday)
  date.setHours(hour, 0, 0, 0)
  return date
}

/**
 * Get next weekend (Saturday) at a specific hour
 */
export function getNextWeekend(hour = 10): Date {
  const date = new Date()
  const dayOfWeek = date.getDay() // 0 = Sunday, 1 = Monday, ...
  const daysUntilSaturday = (6 - dayOfWeek + 7) % 7 || 7

  date.setDate(date.getDate() + daysUntilSaturday)
  date.setHours(hour, 0, 0, 0)
  return date
}

/**
 * Get a date N days from now
 */
export function getInDays(days: number, hour = 9): Date {
  const date = new Date()
  date.setDate(date.getDate() + days)
  date.setHours(hour, 0, 0, 0)
  return date
}

/**
 * Get a date N weeks from now
 */
export function getInWeeks(weeks: number, hour = 9): Date {
  return getInDays(weeks * 7, hour)
}

/**
 * Get a date N months from now
 */
export function getInMonths(months: number, hour = 9): Date {
  const date = new Date()
  date.setMonth(date.getMonth() + months)
  date.setHours(hour, 0, 0, 0)
  return date
}

/**
 * Get later today (4 hours from now, or next morning if too late)
 */
export function getLaterToday(): Date {
  const date = new Date()
  const currentHour = date.getHours()

  if (currentHour >= 20) {
    // After 8 PM, set for tomorrow morning
    return getTomorrow(9)
  } else if (currentHour >= 17) {
    // After 5 PM, set for 8 PM today
    date.setHours(20, 0, 0, 0)
    return date
  } else {
    // Add 4 hours
    date.setHours(currentHour + 4, 0, 0, 0)
    return date
  }
}

// ============================================================================
// Standard Presets
// ============================================================================

// Labels and descriptions are read lazily (via getters) so they follow the
// active language instead of freezing whatever locale was loaded at import time.

/**
 * Standard reminder presets for general use
 */
export const standardPresets: ReminderPreset[] = [
  {
    id: 'later-today',
    get label() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.laterToday.label')
    },
    get description() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.laterToday.description', {
        count: 4
      })
    },
    getDate: getLaterToday
  },
  {
    id: 'tomorrow',
    get label() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.tomorrow.label')
    },
    get description() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.tomorrow.description')
    },
    getDate: () => getTomorrow(9)
  },
  {
    id: 'next-week',
    get label() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.nextWeek.label')
    },
    get description() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.nextWeek.description')
    },
    getDate: () => getNextMonday(9)
  },
  {
    id: 'in-one-month',
    get label() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.inMonths.label', { count: 1 })
    },
    get description() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.sameDayNextMonth')
    },
    getDate: () => getInMonths(1, 9)
  }
]

/**
 * Journal reflection presets (longer intervals for reviewing past entries)
 */
export const journalPresets: ReminderPreset[] = [
  {
    id: 'in-one-week',
    get label() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.inWeeks.label', { count: 1 })
    },
    get description() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.reviewInAWeek')
    },
    getDate: () => getInWeeks(1, 9)
  },
  {
    id: 'in-one-month',
    get label() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.inMonths.label', { count: 1 })
    },
    get description() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.monthlyReflection')
    },
    getDate: () => getInMonths(1, 9)
  },
  {
    id: 'in-three-months',
    get label() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.inMonths.label', { count: 3 })
    },
    get description() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.quarterlyReflection')
    },
    getDate: () => getInMonths(3, 9)
  },
  {
    id: 'in-one-year',
    get label() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.inYears.label', { count: 1 })
    },
    get description() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.anniversaryReminder')
    },
    getDate: () => getInMonths(12, 9)
  }
]

/**
 * Snooze presets (for snoozed reminders)
 */
export const snoozePresets: ReminderPreset[] = [
  {
    id: 'in-15-min',
    get label() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.inMinutes.label', { count: 15 })
    },
    getDate: () => {
      const date = new Date()
      date.setMinutes(date.getMinutes() + 15)
      return date
    }
  },
  {
    id: 'in-1-hour',
    get label() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.inHours.label', { count: 1 })
    },
    getDate: () => {
      const date = new Date()
      date.setHours(date.getHours() + 1)
      return date
    }
  },
  {
    id: 'in-3-hours',
    get label() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.inHours.label', { count: 3 })
    },
    getDate: () => {
      const date = new Date()
      date.setHours(date.getHours() + 3)
      return date
    }
  },
  {
    id: 'tomorrow-morning',
    get label() {
      return getI18n().getFixedT(null, 'inbox')('reminder.presets.tomorrowMorning')
    },
    getDate: () => getTomorrow(9)
  }
]

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format a date for display in reminder UI
 */
export function formatReminderDate(
  date: Date,
  clockFormat: ClockFormat = '12h',
  compact = false
): string {
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const isToday = date.toDateString() === now.toDateString()
  const isTomorrow = date.toDateString() === tomorrow.toDateString()

  // Runs outside React (plain helper), so it reaches i18next directly.
  const t = getI18n().getFixedT(null, 'inbox')
  const timeStr = formatTimeOfDay(date, clockFormat)

  // Compact form drops the "at" separator and shortens the weekday, for tight
  // surfaces like the task drawer badge where the verbose form wraps to two lines.
  if (isToday) {
    return compact
      ? t('reminder.dateTime.todayCompact', { time: timeStr })
      : t('reminder.dateTime.todayAt', { time: timeStr })
  }

  if (isTomorrow) {
    return compact
      ? t('reminder.dateTime.tomorrowCompact', { time: timeStr })
      : t('reminder.dateTime.tomorrowAt', { time: timeStr })
  }

  // Check if within this week
  const daysUntil = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
  const dateStr =
    daysUntil < 7
      ? date.toLocaleDateString(getActiveLocale(), { weekday: compact ? 'short' : 'long' })
      : date.toLocaleDateString(getActiveLocale(), {
          month: 'short',
          day: 'numeric',
          year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
        })

  return compact
    ? t('reminder.dateTime.dateCompact', { date: dateStr, time: timeStr })
    : t('reminder.dateTime.dateAt', { date: dateStr, time: timeStr })
}

/**
 * Format a relative time string (e.g., "in 2 hours", "in 3 days")
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()

  if (diffMs < 0) {
    return 'overdue'
  }

  const minutes = Math.floor(diffMs / (1000 * 60))
  const hours = Math.floor(diffMs / (1000 * 60 * 60))
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (minutes < 60) {
    return `in ${minutes} minute${minutes !== 1 ? 's' : ''}`
  }

  if (hours < 24) {
    return `in ${hours} hour${hours !== 1 ? 's' : ''}`
  }

  if (days < 7) {
    return `in ${days} day${days !== 1 ? 's' : ''}`
  }

  const weeks = Math.floor(days / 7)
  if (weeks < 4) {
    return `in ${weeks} week${weeks !== 1 ? 's' : ''}`
  }

  const months = Math.floor(days / 30)
  if (months < 12) {
    return `in ${months} month${months !== 1 ? 's' : ''}`
  }

  const years = Math.floor(days / 365)
  return `in ${years} year${years !== 1 ? 's' : ''}`
}

/**
 * Check if a date is in the past
 */
export function isOverdue(date: Date | string): boolean {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.getTime() < Date.now()
}

/**
 * Get the appropriate label for a reminder based on its time
 */
export function getReminderTimeLabel(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date

  if (isOverdue(d)) {
    return 'Overdue'
  }

  return formatRelativeTime(d)
}
