import { type ReactNode } from 'react'
import { useCalendarDateDroppable } from './use-calendar-date-droppable'
import { cn } from '@/lib/utils'

interface CalendarAllDayCellProps {
  date: string
  children: ReactNode
  className?: string
}

/** All-day cells clear dueTime: a task dropped here is due on the day, at no time. */
export function CalendarAllDayCell({
  date,
  children,
  className
}: CalendarAllDayCellProps): React.JSX.Element {
  const { setNodeRef, isOver } = useCalendarDateDroppable({ date, timeBehavior: 'clear' })

  return (
    <div ref={setNodeRef} data-date={date} className={cn(className, isOver && 'bg-tint/15')}>
      {children}
    </div>
  )
}
