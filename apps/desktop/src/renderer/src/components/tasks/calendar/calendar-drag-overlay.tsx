import React from 'react'
import { DragOverlay } from '@dnd-kit/core'

import { cn } from '@/lib/utils'
import type { Task } from '@/data/sample-tasks'
import { isBefore, startOfDay } from '@/lib/task-utils'

interface CalendarDragOverlayProps {
  activeTask: Task | null
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

export const CalendarDragOverlay = ({
  activeTask
}: CalendarDragOverlayProps): React.JSX.Element => {
  if (!activeTask) {
    return <DragOverlay dropAnimation={null} />
  }

  const isCompleted = !!activeTask.completedAt
  const isOverdue =
    activeTask.dueDate !== null &&
    isBefore(startOfDay(activeTask.dueDate), startOfDay(new Date())) &&
    !isCompleted

  return (
    <DragOverlay dropAnimation={null}>
      <div
        className={cn(
          'flex items-center gap-1 rounded px-1.5 py-[3px] text-[11px] leading-[14px] shadow-lg',
          isOverdue ? 'bg-cal-task-overdue-bg' : 'bg-cal-task-bg-today',
          isCompleted && 'opacity-50 line-through'
        )}
        style={{
          color: isOverdue ? 'var(--cal-task-overdue-text)' : 'var(--cal-task-text)'
        }}
      >
        <span
          className="block w-[3px] h-3 shrink-0 rounded-sm"
          style={{ backgroundColor: getPriorityBarColor(activeTask.priority) }}
          aria-hidden="true"
        />
        <span className="truncate">{activeTask.title}</span>
      </div>
    </DragOverlay>
  )
}

export default CalendarDragOverlay
