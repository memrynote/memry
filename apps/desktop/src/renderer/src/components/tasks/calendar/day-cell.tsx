import React, { useMemo } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'

import { cn } from '@/lib/utils'
import { CalendarTaskItem } from './calendar-task-item'
import { formatDateKey, type CalendarDay } from '@/lib/task-utils'
import type { Task } from '@/data/sample-tasks'

interface DayCellProps {
  day: CalendarDay
  tasks: Task[]
  allTasks?: Task[]
  maxVisible?: number
  isSelected?: boolean
  isFocused?: boolean
  isCompact?: boolean
  onOpenDay: (date: Date) => void
  onTaskClick: (taskId: string) => void
  onAddTask: (date: Date) => void
}

const DraggableCalendarTask = ({
  task,
  children
}: {
  task: Task
  children: React.ReactNode
}): React.JSX.Element => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: {
      type: 'calendar-task',
      task,
      sourceType: 'calendar'
    }
  })

  const style = useMemo(() => {
    if (!transform) return undefined
    return {
      transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`
    }
  }, [transform])

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={cn(isDragging && 'z-10 opacity-80')}
    >
      {children}
    </div>
  )
}

export const DayCell = ({
  day,
  tasks,
  allTasks = [],
  maxVisible = 3,
  isSelected = false,
  isFocused = false,
  isCompact = false,
  onOpenDay,
  onTaskClick,
  onAddTask
}: DayCellProps): React.JSX.Element => {
  const { setNodeRef, isOver } = useDroppable({
    id: formatDateKey(day.date),
    data: { type: 'date', date: day.date }
  })

  const visibleTasks = tasks.slice(0, maxVisible)
  const overflowCount = Math.max(tasks.length - maxVisible, 0)

  const handleCellClick = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    if (target.closest('[data-task-item]')) return
    onAddTask(day.date)
  }

  const handleDayKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onOpenDay(day.date)
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      onAddTask(day.date)
    }
  }

  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      tabIndex={0}
      aria-label={day.date.toDateString()}
      onClick={handleCellClick}
      onKeyDown={handleDayKeyDown}
      className={cn(
        'relative flex min-h-[110px] flex-col gap-1 rounded-[6px] p-2 transition-colors cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        // Background
        day.isToday
          ? 'bg-cal-today-bg border-[1.5px] border-cal-today-border'
          : !day.isCurrentMonth
            ? 'bg-cal-cell-outside-bg'
            : day.isWeekend
              ? 'bg-cal-cell-weekend-bg'
              : 'bg-cal-cell-bg',
        // States
        isSelected && !day.isToday && 'ring-2 ring-primary',
        isFocused && 'ring-2 ring-ring',
        isOver && 'ring-2 ring-cal-today-border'
      )}
    >
      {/* Day number */}
      <div className="flex items-center gap-1.5">
        {day.isToday ? (
          <>
            <span
              className="inline-flex size-[22px] items-center justify-center rounded-full text-[11px] font-semibold text-white"
              style={{ backgroundColor: 'var(--cal-today-badge)' }}
            >
              {day.date.getDate()}
            </span>
            <span
              className="text-[9px] font-medium uppercase tracking-[0.06em]"
              style={{
                color: 'var(--cal-today-label)',
                fontFamily: 'var(--font-mono)'
              }}
            >
              Today
            </span>
          </>
        ) : (
          <span
            className={cn('text-xs', day.isCurrentMonth ? 'font-medium' : 'font-normal')}
            style={{
              color: day.isCurrentMonth ? 'var(--cal-date-current)' : 'var(--cal-date-outside)'
            }}
          >
            {day.date.getDate()}
          </span>
        )}
      </div>

      {/* Tasks */}
      <div className="flex flex-1 flex-col gap-1">
        {visibleTasks.map((task) => (
          <DraggableCalendarTask key={task.id} task={task}>
            <div data-task-item>
              <CalendarTaskItem
                task={task}
                allTasks={allTasks}
                compact={isCompact}
                isToday={day.isToday}
                onClick={() => onTaskClick(task.id)}
              />
            </div>
          </DraggableCalendarTask>
        ))}
      </div>

      {/* Overflow */}
      {overflowCount > 0 && (
        <button
          type="button"
          className="text-left text-[10px] font-medium pl-0.5 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ color: 'var(--cal-overflow)' }}
          onClick={(e) => {
            e.stopPropagation()
            onOpenDay(day.date)
          }}
        >
          +{overflowCount} more
        </button>
      )}
    </div>
  )
}

export default DayCell
