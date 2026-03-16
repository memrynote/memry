import React from 'react'
import { DragOverlay } from '@dnd-kit/core'

import { cn } from '@/lib/utils'
import { priorityConfig, type Task } from '@/data/sample-tasks'
import { isBefore, startOfDay } from '@/lib/task-utils'

interface CalendarDragOverlayProps {
  activeTask: Task | null
}

export const CalendarDragOverlay = ({
  activeTask
}: CalendarDragOverlayProps): React.JSX.Element => {
  if (!activeTask) {
    return <DragOverlay dropAnimation={null} />
  }

  const priorityColor = priorityConfig[activeTask.priority].color || '#9ca3af'
  const isCompleted = !!activeTask.completedAt
  const isOverdue =
    activeTask.dueDate !== null &&
    isBefore(startOfDay(activeTask.dueDate), startOfDay(new Date())) &&
    !isCompleted

  return (
    <DragOverlay dropAnimation={null}>
      <div
        className={cn(
          'flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-xs shadow-lg',
          isCompleted && 'opacity-60 line-through',
          isOverdue && 'border-task-due-overdue/30 bg-task-due-overdue-bg'
        )}
      >
        {activeTask.priority !== 'none' && (
          <span
            className="block size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: priorityColor }}
            aria-hidden="true"
          />
        )}
        <span className="truncate">{activeTask.title}</span>
      </div>
    </DragOverlay>
  )
}

export default CalendarDragOverlay
