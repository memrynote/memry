import { formatDateKey } from '@/lib/task-utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { DEFAULT_BLOCK_MINUTES } from './time-grid-constants'

/** The task fields that place a task on the time grid. */
export interface TaskBlockSchedule {
  dueDate: string
  dueTime: string
  durationMinutes?: number | null
}

function minutesBetween(startAt: string, endAt: string): number {
  return Math.round((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60_000)
}

function dueDateTime(instant: string): { dueDate: string; dueTime: string } {
  const date = new Date(instant)
  return {
    dueDate: formatDateKey(date),
    dueTime: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
}

/**
 * What moving or resizing a task block writes, and what undo writes back.
 *
 * `durationMinutes` travels only when the block's length changed. A plain move
 * leaves it out, so a task that never had a length keeps `null` instead of
 * gaining the default one, and its sync field clock is not bumped.
 */
export function taskBlockChange(
  item: CalendarProjectionItem,
  startAt: string,
  endAt: string
): { next: TaskBlockSchedule; previous: TaskBlockSchedule } {
  const previousLength = item.endAt ? minutesBetween(item.startAt, item.endAt) : null
  const nextLength = minutesBetween(startAt, endAt)
  const resized = nextLength !== (previousLength ?? DEFAULT_BLOCK_MINUTES)

  return {
    next: { ...dueDateTime(startAt), ...(resized ? { durationMinutes: nextLength } : {}) },
    previous: {
      ...dueDateTime(item.startAt),
      ...(resized ? { durationMinutes: previousLength } : {})
    }
  }
}
