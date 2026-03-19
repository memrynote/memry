import React, { useMemo } from 'react'

import { cn } from '@/lib/utils'
import type { Task } from '@/data/sample-tasks'
import { isBefore, startOfDay } from '@/lib/task-utils'
import { getSubtasks, calculateProgress } from '@/lib/subtask-utils'
import { MiniProgressBar } from '@/components/tasks/mini-progress-bar'

interface CalendarTaskItemProps {
  task: Task
  allTasks?: Task[]
  compact?: boolean
  isToday?: boolean
  onClick?: (taskId: string) => void
}

const getPriorityBarColor = (priority: Task['priority']): string => {
  switch (priority) {
    case 'urgent':
      return 'var(--task-priority-urgent)'
    case 'high':
      return 'var(--task-priority-high)'
    case 'medium':
      return 'var(--task-priority-medium)'
    case 'low':
      return 'var(--task-priority-low)'
    default:
      return 'var(--cal-weekday)'
  }
}

export const CalendarTaskItem = ({
  task,
  allTasks = [],
  compact = false,
  isToday = false,
  onClick
}: CalendarTaskItemProps): React.JSX.Element => {
  const isCompleted = !!task.completedAt
  const isOverdue =
    task.dueDate !== null &&
    isBefore(startOfDay(task.dueDate), startOfDay(new Date())) &&
    !isCompleted

  const subtasks = useMemo(() => {
    if (allTasks.length === 0) return []
    return getSubtasks(task.id, allTasks)
  }, [task.id, allTasks])

  const subtaskProgress = useMemo(() => {
    return calculateProgress(subtasks)
  }, [subtasks])

  const hasSubtasks = subtasks.length > 0

  if (compact) {
    return (
      <span
        className={cn('inline-flex size-2 rounded-full', isOverdue && 'ring-2 ring-red-300')}
        style={{ backgroundColor: getPriorityBarColor(task.priority) }}
        title={task.title}
      />
    )
  }

  const handleClick = (): void => {
    if (onClick) onClick(task.id)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick?.(task.id)
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex items-center gap-1 rounded px-1.5 py-[3px] text-[11px] leading-[14px] font-normal',
        'cursor-pointer truncate transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        isOverdue
          ? 'bg-cal-task-overdue-bg hover:bg-cal-task-overdue-bg/80'
          : isToday
            ? 'bg-cal-task-bg-today hover:bg-white/90'
            : 'bg-cal-task-bg hover:bg-cal-cell-outside-bg',
        isCompleted && 'opacity-50 line-through'
      )}
      style={{
        color: isOverdue
          ? 'var(--cal-task-overdue-text)'
          : isToday
            ? 'var(--cal-task-text-today)'
            : 'var(--cal-task-text)',
        fontWeight: isToday ? 500 : 400
      }}
      aria-label={task.title}
    >
      {/* Priority bar */}
      <span
        className="block w-[3px] h-3 shrink-0 rounded-sm"
        style={{ backgroundColor: getPriorityBarColor(task.priority) }}
        aria-hidden="true"
      />

      {/* Mini progress bar for subtasks */}
      {hasSubtasks && !isCompleted && <MiniProgressBar progress={subtaskProgress} />}

      {/* Title */}
      <span className="truncate">{task.title}</span>
    </div>
  )
}

export default CalendarTaskItem
