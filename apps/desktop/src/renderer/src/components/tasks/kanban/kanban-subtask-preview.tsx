import { Check, Circle } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatDateShort } from '@/lib/task-utils'
import type { Task } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface KanbanSubtaskPreviewProps {
  parentTitle: string
  subtasks: Task[]
  maxVisible?: number
}

// ============================================================================
// KANBAN SUBTASK PREVIEW COMPONENT
// Shows list of subtasks with completion status in a hover card
// ============================================================================

export const KanbanSubtaskPreview = ({
  parentTitle,
  subtasks,
  maxVisible = 5
}: KanbanSubtaskPreviewProps): React.JSX.Element => {
  const visibleSubtasks = subtasks.slice(0, maxVisible)
  const overflowCount = Math.max(subtasks.length - maxVisible, 0)

  return (
    <div className="space-y-2">
      {/* Parent task title */}
      <h4 className="font-medium text-sm truncate">{parentTitle}</h4>

      {/* Subtask list */}
      <div className="space-y-1">
        {visibleSubtasks.map((subtask) => {
          const isCompleted = !!subtask.completedAt

          return (
            <div key={subtask.id} className="flex items-center gap-2 text-sm">
              {/* Completion icon */}
              {isCompleted ? (
                <Check className="w-3 h-3 text-task-complete shrink-0" />
              ) : (
                <Circle className="w-3 h-3 text-gray-300 shrink-0" />
              )}

              {/* Subtask title */}
              <span
                className={cn(
                  'flex-1 truncate',
                  isCompleted && 'text-muted-foreground line-through'
                )}
              >
                {subtask.title}
              </span>

              {/* Due date for incomplete subtasks */}
              {!isCompleted && subtask.dueDate && (
                <span className="text-xs text-muted-foreground shrink-0">
                  {formatDateShort(subtask.dueDate)}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Overflow indicator */}
      {overflowCount > 0 && (
        <p className="text-xs text-muted-foreground">
          +{overflowCount} more subtask{overflowCount !== 1 ? 's' : ''}
        </p>
      )}
    </div>
  )
}

export default KanbanSubtaskPreview
