import React, { useMemo } from "react"

import { DayCell } from "./day-cell"
import { formatDateKey, type CalendarDay } from "@/lib/task-utils"
import type { Task } from "@/data/sample-tasks"

const WEEKDAYS_SUN_START = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const WEEKDAYS_MON_START = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

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
  onAddTask,
}: CalendarGridProps): React.JSX.Element => {
  const weekdayLabels = useMemo(
    () => (weekStartsOn === 0 ? WEEKDAYS_SUN_START : WEEKDAYS_MON_START),
    [weekStartsOn]
  )

  return (
    <div className="flex flex-col gap-3">
      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium uppercase text-muted-foreground">
        {weekdayLabels.map((day) => (
          <div key={day} className="py-1">
            {day}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid flex-1 grid-cols-7 gap-1">
        {days.map((day) => {
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
    </div>
  )
}

export default CalendarGrid

