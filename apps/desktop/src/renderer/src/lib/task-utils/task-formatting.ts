import { startOfDay, addDays, isSameDay, isBefore, differenceInDays } from './task-date-utils'

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

export const formatTime = (time: string): string => {
  const [hours, minutes] = time.split(':').map(Number)
  const period = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`
}

export const formatDateShort = (date: Date): string => {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export const formatDayName = (date: Date): string => {
  return date.toLocaleDateString('en-US', { weekday: 'long' })
}

export const formatOverdueRelative = (dueDate: Date): string => {
  const days = differenceInDays(startOfDay(new Date()), startOfDay(dueDate))
  if (days <= 0) return 'Today'
  return `${days}d late`
}

export const formatDueDate = (
  dueDate: Date | null,
  dueTime: string | null
): FormattedDueDate | null => {
  if (!dueDate) return null

  const today = startOfDay(new Date())
  const tomorrow = addDays(today, 1)
  const nextWeek = addDays(today, 7)
  const taskDate = startOfDay(dueDate)

  const timeStr = dueTime ? ` ${formatTime(dueTime)}` : ''

  if (isBefore(taskDate, today)) {
    return { label: formatOverdueRelative(dueDate), status: 'overdue' }
  }

  if (isSameDay(taskDate, today)) {
    return { label: 'Today' + timeStr, status: 'today' }
  }

  if (isSameDay(taskDate, tomorrow)) {
    return { label: 'Tomorrow' + timeStr, status: 'tomorrow' }
  }

  if (isBefore(taskDate, nextWeek)) {
    return { label: formatDayName(dueDate) + timeStr, status: 'upcoming' }
  }

  return { label: formatDateShort(dueDate) + timeStr, status: 'later' }
}
