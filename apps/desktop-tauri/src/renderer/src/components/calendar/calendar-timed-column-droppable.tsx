import { useDroppable } from '@dnd-kit/core'
import { type ReactNode } from 'react'
import { parseDateKey } from '@/lib/task-utils'
import { cn } from '@/lib/utils'

interface CalendarTimedColumnDroppableProps {
  date: string
  hourHeight: number
  children: ReactNode
}

/**
 * One droppable per day column rather than per 15-minute slot (96 slots/day
 * would mean 672 droppables in a week). `timeBehavior: 'slot'` tells
 * handleDragEnd to derive the time from where the chip landed.
 */
export function CalendarTimedColumnDroppable({
  date,
  hourHeight,
  children
}: CalendarTimedColumnDroppableProps): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: `calendar-timed-column:${date}`,
    data: {
      type: 'date',
      date: parseDateKey(date),
      dateKey: date,
      timeBehavior: 'slot',
      hourHeight
    }
  })

  return (
    <div
      ref={setNodeRef}
      data-drop-date={date}
      className={cn('relative h-full', isOver && 'bg-tint/10')}
    >
      {children}
    </div>
  )
}
