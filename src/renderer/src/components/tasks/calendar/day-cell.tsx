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

  const dayNumber = (
    <span
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-full text-sm font-medium',
        day.isToday && 'bg-primary text-primary-foreground',
        !day.isToday && day.isCurrentMonth && 'text-foreground',
        !day.isToday && !day.isCurrentMonth && 'text-muted-foreground'
      )}
    >
      {day.date.getDate()}
    </span>
  )

  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      tabIndex={0}
      aria-label={day.date.toDateString()}
      onClick={handleCellClick}
      onKeyDown={handleDayKeyDown}
      className={cn(
        'relative flex min-h-[110px] flex-col gap-1 rounded-md border border-border p-2 transition-colors cursor-pointer',
        'hover:bg-accent/40 hover:border-accent-foreground/20',
        day.isWeekend && 'bg-muted/30',
        isSelected && 'ring-2 ring-primary',
        isFocused && 'ring-2 ring-ring bg-accent/30',
        isOver && 'border-primary/60 bg-primary/5',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
    >
      <div className="flex items-center justify-between">{dayNumber}</div>

      <div className="flex flex-1 flex-col gap-1">
        {visibleTasks.map((task) => (
          <DraggableCalendarTask key={task.id} task={task}>
            <div data-task-item>
              <CalendarTaskItem
                task={task}
                allTasks={allTasks}
                compact={isCompact}
                onClick={() => onTaskClick(task.id)}
              />
            </div>
          </DraggableCalendarTask>
        ))}
      </div>

      {overflowCount > 0 && (
        <button
          type="button"
          className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
