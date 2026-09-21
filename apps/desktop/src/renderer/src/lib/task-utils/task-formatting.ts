import { getI18n } from 'react-i18next'
import { startOfDay, addDays, isSameDay, isBefore, differenceInDays } from './task-date-utils'
import { getActiveLocale } from '@/lib/active-locale'
import { formatTimeString } from '@/lib/time-format'
import type { ClockFormat } from '@/lib/time-format'

// ============================================================================
// DATE FORMATTING
// ============================================================================

export type DueDateStatus = 'overdue' | 'today' | 'tomorrow' | 'upcoming' | 'later' | 'none'

export type OverdueTier = 'mild' | 'moderate' | 'severe'

export const getDaysOverdue = (dueDate: Date | null): number => {
  if (!dueDate) return 0
  const today = startOfDay(new Date())
  const taskDate = startOfDay(dueDate)
  if (!isBefore(taskDate, today)) return 0
  return Math.round((today.getTime() - taskDate.getTime()) / (1000 * 60 * 60 * 24))
}

export const getOverdueTier = (daysOverdue: number): OverdueTier => {
  if (daysOverdue >= 7) return 'severe'
  if (daysOverdue >= 4) return 'moderate'
  return 'mild'
}

export const overdueTierStyles = {
  mild: {
    rowBg: 'bg-amber-50/50 dark:bg-amber-950/15',
    chipBg: 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400'
  },
  moderate: {
    rowBg: 'bg-rose-50/60 dark:bg-rose-950/20',
    chipBg: 'bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-400'
  },
  severe: {
    rowBg: 'bg-rose-50/70 dark:bg-rose-950/25',
    chipBg: 'bg-rose-100 dark:bg-rose-900/50 text-rose-800 dark:text-rose-300'
  }
} as const

export interface FormattedDueDate {
  label: string
  status: DueDateStatus
}

export const formatTime = (time: string, clockFormat: ClockFormat = '12h'): string => {
  return formatTimeString(time, clockFormat)
}

export const formatDateShort = (date: Date): string => {
  return date.toLocaleDateString(getActiveLocale(), { month: 'short', day: 'numeric' })
}

export const formatDayName = (date: Date): string => {
  return date.toLocaleDateString(getActiveLocale(), { weekday: 'long' })
}

export const formatOverdueRelative = (dueDate: Date): string => {
  const t = getI18n().getFixedT(null, 'common')
  const days = differenceInDays(startOfDay(new Date()), startOfDay(dueDate))
  if (days <= 0) return t('dateRelative.today')
  return t('dateRelative.daysLate', { count: days })
}

export type RelativeDateTone = 'neutral' | 'overdue'

export interface RelativeDateHint {
  label: string
  tone: RelativeDateTone
}

export interface RelativeDateHintOptions {
  /** A past due date is late; a past start date has simply already begun. */
  kind?: 'due' | 'start'
  isCompleted?: boolean
  now?: Date
}

// Upcoming dates stay in days for two weeks, then switch to weeks: "in 13 days"
// is still a number you can plan around, "in 87 days" is not. Overdue dates are
// always days, never weeks, so a long-neglected task reads as a concrete count
// instead of a rounded "3 weeks" (#1861).
const RELATIVE_HINT_DAYS_MAX = 14

// `differenceInDays` floors a raw millisecond diff, so the 23-hour spring-forward
// day reports 0 for two distinct calendar days. Round instead.
const diffInCalendarDays = (a: Date, b: Date): number =>
  Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86_400_000)

/**
 * Relative distance to a date, for display next to the absolute date rather than
 * instead of it: "Mar 15" alone never says whether that is tomorrow or next month.
 */
export const formatRelativeDateHint = (
  date: Date | null,
  options: RelativeDateHintOptions = {}
): RelativeDateHint | null => {
  if (!date || options.isCompleted) return null

  const t = getI18n().getFixedT(null, 'common')
  const days = diffInCalendarDays(date, options.now ?? new Date())

  if (days === 0) return { label: t('dateRelative.today'), tone: 'neutral' }
  if (days === 1) return { label: t('dateRelative.tomorrow'), tone: 'neutral' }

  if (days > 1) {
    const label =
      days <= RELATIVE_HINT_DAYS_MAX
        ? t('dateRelative.inDays', { count: days })
        : t('dateRelative.inWeeks', { count: Math.round(days / 7) })
    return { label, tone: 'neutral' }
  }

  const elapsed = -days
  if (options.kind === 'start') {
    const label =
      elapsed === 1 ? t('dateRelative.yesterday') : t('dateRelative.daysAgo', { count: elapsed })
    return { label, tone: 'neutral' }
  }

  return { label: t('dateRelative.daysOverdue', { count: elapsed }), tone: 'overdue' }
}

export const formatDueDate = (
  dueDate: Date | null,
  dueTime: string | null
): FormattedDueDate | null => {
  if (!dueDate) return null

  const t = getI18n().getFixedT(null, 'common')
  const today = startOfDay(new Date())
  const tomorrow = addDays(today, 1)
  const nextWeek = addDays(today, 7)
  const taskDate = startOfDay(dueDate)

  const timeStr = dueTime ? ` ${formatTime(dueTime)}` : ''

  if (isBefore(taskDate, today)) {
    return { label: formatOverdueRelative(dueDate), status: 'overdue' }
  }

  if (isSameDay(taskDate, today)) {
    return { label: t('dateRelative.today') + timeStr, status: 'today' }
  }

  if (isSameDay(taskDate, tomorrow)) {
    return { label: t('dateRelative.tomorrow') + timeStr, status: 'tomorrow' }
  }

  if (isBefore(taskDate, nextWeek)) {
    return { label: formatDayName(dueDate) + timeStr, status: 'upcoming' }
  }

  return { label: formatDateShort(dueDate) + timeStr, status: 'later' }
}
