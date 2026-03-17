import React, { useMemo } from 'react'

import { DayCell } from './day-cell'
import { formatDateKey, type CalendarDay } from '@/lib/task-utils'
import type { Task } from '@/data/sample-tasks'

const WEEKDAYS_SUN_START = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS_MON_START = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

interface CalendarGridProps {
  days: CalendarDay[]
  tasksByDate: Map<string, Task[]>
  allTasks?: Task[]
  weekStartsOn?: 0 | 1
  selectedDate: Date | null
  focusedDate: Date | null
  maxVisibleTasks?: number
  isCompact?: boolean
  onOpenDay: (date: Date) => void
  onTaskClick: (taskId: string) => void
  onAddTask: (date: Date) => void
}

export const CalendarGrid = ({
  days,
  tasksByDate,
  allTasks = [],
  weekStartsOn = 0,
  selectedDate,
  focusedDate,
  maxVisibleTasks = 3,
  isCompact = false,
  onOpenDay,
  onTaskClick,
  onAddTask
}: CalendarGridProps): React.JSX.Element => {
  const weekdayLabels = useMemo(
    () => (weekStartsOn === 0 ? WEEKDAYS_SUN_START : WEEKDAYS_MON_START),
    [weekStartsOn]
  )

  const weeks = useMemo(() => {
    const result: CalendarDay[][] = []
    for (let i = 0; i < days.length; i += 7) {
      result.push(days.slice(i, i + 7))
    }
    return result
  }, [days])

  return (
    <div className="flex flex-col" style={{ gap: 'var(--cal-grid-gap)' }}>
      {/* Weekday header */}
      <div className="grid grid-cols-7 px-0 pb-2" style={{ gap: 'var(--cal-grid-gap)' }}>
        {weekdayLabels.map((day) => (
          <div
            key={day}
            className="py-1 px-2 text-[10px] font-medium uppercase tracking-[0.08em]"
            style={{
              color: 'var(--cal-weekday)',
              fontFamily: 'var(--font-mono)'
            }}
          >
            {day}
          </div>
        ))}
      </div>

      {/* Week rows */}
      {weeks.map((week, weekIndex) => (
        <div key={weekIndex} className="grid grid-cols-7" style={{ gap: 'var(--cal-grid-gap)' }}>
          {week.map((day) => {
            const dateKey = formatDateKey(day.date)
            const dayTasks = tasksByDate.get(dateKey) || []
            const isSelected =
              selectedDate !== null &&
              selectedDate.getFullYear() === day.date.getFullYear() &&
              selectedDate.getMonth() === day.date.getMonth() &&
              selectedDate.getDate() === day.date.getDate()
            const isFocused =
              focusedDate !== null &&
              focusedDate.getFullYear() === day.date.getFullYear() &&
              focusedDate.getMonth() === day.date.getMonth() &&
              focusedDate.getDate() === day.date.getDate()

            return (
              <DayCell
                key={dateKey}
                day={day}
                tasks={dayTasks}
                allTasks={allTasks}
                maxVisible={maxVisibleTasks}
                isSelected={isSelected}
                isFocused={isFocused}
                isCompact={isCompact}
                onOpenDay={onOpenDay}
                onTaskClick={onTaskClick}
                onAddTask={onAddTask}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

export default CalendarGrid
