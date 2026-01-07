import { Check } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatDueDate } from '@/lib/task-utils'
import { TaskCheckbox, PriorityBadge } from '@/components/tasks/task-badges'
import type { Task } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface SubtaskRowProps {
  subtask: Task
  isLast: boolean
  onToggleComplete: (taskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
}

// ============================================================================
// SUBTASK ROW COMPONENT
// ============================================================================

export const SubtaskRow = ({
  subtask,
  isLast,
  onToggleComplete,
  onClick,
  className
}: SubtaskRowProps): React.JSX.Element => {
  const isCompleted = !!subtask.completedAt
  const formattedDate = formatDueDate(subtask.dueDate, subtask.dueTime)

  const handleClick = (): void => {
    onClick?.(subtask.id)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && onClick) {
      e.preventDefault()
      onClick(subtask.id)
    }
  }

  const handleToggleComplete = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onToggleComplete(subtask.id)
  }

  return (
    <div
      role="button"
      tabIndex={onClick ? 0 : -1}
      onClick={handleClick}
      onKeyDown={onClick ? handleKeyDown : undefined}
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 ml-2',
        'hover:bg-accent/50 cursor-pointer rounded-r-lg',
        'transition-colors duration-150',
        onClick && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
      aria-label={`Subtask: ${subtask.title}${isCompleted ? ', completed' : ''}`}
    >
      {/* Tree connector */}
      <span
        className="text-muted-foreground/50 text-sm font-mono w-4 select-none"
        aria-hidden="true"
      >
        {isLast ? '└─' : '├─'}
      </span>

      {/* Subtask checkbox */}
      <div onClick={handleToggleComplete}>
        <TaskCheckbox checked={isCompleted} onChange={() => onToggleComplete(subtask.id)} />
      </div>

      {/* Subtask title */}
      <span
        className={cn(
          'flex-1 text-sm truncate',
          isCompleted && 'line-through text-muted-foreground'
        )}
      >
        {subtask.title}
      </span>

      {/* Completion status or metadata */}
      {isCompleted ? (
        <span className="text-xs text-green-600 dark:text-green-500 flex items-center gap-1">
          <Check className="w-3 h-3" aria-hidden="true" />
          <span>Done</span>
        </span>
      ) : (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {subtask.priority !== 'none' && <PriorityBadge priority={subtask.priority} size="sm" />}
          {formattedDate && (
            <span className={cn(formattedDate.status === 'overdue' && 'text-destructive')}>
              {formattedDate.label}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export default SubtaskRow
