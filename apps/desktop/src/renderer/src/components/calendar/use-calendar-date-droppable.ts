import { useDroppable } from '@dnd-kit/core'
import { parseDateKey } from '@/lib/task-utils'

export interface CalendarDateDroppableArgs {
  /** Local date key, 'YYYY-MM-DD'. */
  date: string
  /**
   * 'preserve' — month cell: keep the task's existing dueTime.
   * 'clear'    — all-day cell: drop the time.
   * 'slot'     — timed column: the time is resolved from the pointer at drop time.
   */
  timeBehavior: 'preserve' | 'clear' | 'slot'
}

export interface CalendarDateDroppableResult {
  setNodeRef: (element: HTMLElement | null) => void
  isOver: boolean
}

/**
 * Registers a calendar cell as a `type: 'date'` drop target.
 *
 * `date` is carried as a Date object because the established droppable contract
 * expects one: drag-context announces `overData.date.toDateString()` and
 * use-drag-handlers reads `overData.date as Date`.
 */
export function useCalendarDateDroppable({
  date,
  timeBehavior
}: CalendarDateDroppableArgs): CalendarDateDroppableResult {
  const { setNodeRef, isOver } = useDroppable({
    id: `calendar-date:${date}:${timeBehavior}`,
    data: {
      type: 'date',
      date: parseDateKey(date),
      dateKey: date,
      // Omitting the key entirely means "preserve the task's time".
      ...(timeBehavior === 'clear' ? { dueTime: null } : {})
    }
  })

  return { setNodeRef, isOver }
}
