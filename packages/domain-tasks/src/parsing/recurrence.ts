/**
 * Recurrence math: the next occurrence of a repeating task, the series end, and
 * what completing a repeating task produces (spec 004 D3).
 *
 * Moved verbatim from the renderer's `repeat-utils.ts` and
 * `use-undoable-task-actions.ts`. Every date is a local calendar date and no
 * function reads the clock.
 */

import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  endOfMonth,
  isAfter,
  startOfDay,
  subDays
} from './dates.ts'
import type { RepeatAnchor, RepeatConfig } from './types.ts'

export const getWeekOfMonth = (date: Date): number => Math.ceil(date.getDate() / 7)

export const isLastWeekdayOfMonth = (date: Date): boolean =>
  addDays(date, 7).getMonth() !== date.getMonth()

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
  return addDays(startOfNextWeek, sortedDays[0])
}

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

export const shouldCreateNextOccurrence = (config: RepeatConfig, now: Date): boolean => {
  if (config.endType === 'never') return true

  if (config.endType === 'count' && config.endCount) {
    return config.completedCount < config.endCount
  }

  if (config.endType === 'date' && config.endDate) {
    return !isAfter(now, config.endDate)
  }

  return true
}

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

/** What completing a repeating task produces. */
export interface RepeatCompletion {
  /** The next occurrence's due date, or null when the series has ended. */
  nextDueDate: Date | null
  /** `completedCount` the next occurrence carries. */
  completedCount: number
}

/**
 * Completing a repeating task (the renderer's `completeTaskWithUndo`): the task
 * closes, and when the series continues a new task is due on `nextDueDate`
 * carrying `completedCount`.
 *
 * `repeatFrom === 'completion'` restarts the interval on the completion day, so
 * finishing Monday's daily task on Thursday schedules Friday; anything else —
 * including the null every task written before this was honored carries —
 * keeps the fixed cadence off the due date.
 */
export const completeRepeatingTask = (
  task: { dueDate: Date; repeatConfig: RepeatConfig; repeatFrom: RepeatAnchor | null },
  completedAt: Date
): RepeatCompletion => {
  const config = task.repeatConfig
  const completedCount = config.completedCount + 1
  const anchorDate = task.repeatFrom === 'completion' ? startOfDay(completedAt) : task.dueDate
  const nextDate = calculateNextOccurrence(anchorDate, config)
  const shouldCreate = shouldCreateNextOccurrence({ ...config, completedCount }, completedAt)
  return { nextDueDate: shouldCreate && nextDate ? nextDate : null, completedCount }
}
