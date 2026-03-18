import { cn } from '@/lib/utils'
import { PriorityBadge, DueDateBadge } from '@/components/tasks/task-badges'
import type { Task } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface MultiDragOverlayProps {
  /** Tasks being dragged */
  tasks: Task[]
  /** Maximum number of stacked previews to show */
  maxPreview?: number
}

// ============================================================================
// MULTI-DRAG OVERLAY COMPONENT
// ============================================================================

/**
 * Displays a stacked card preview when dragging multiple tasks
 * Shows the first few tasks stacked with a count badge
 */
export const MultiDragOverlay = ({
  tasks,
  maxPreview = 3
}: MultiDragOverlayProps): React.JSX.Element => {
  const visibleTasks = tasks.slice(0, maxPreview)
  const totalCount = tasks.length

  return (
    <div className="relative" data-testid="drag-overlay">
      {/* Stacked cards effect - render in reverse order so first is on top */}
      {visibleTasks.map((task, index) => {
        // Calculate offset for stacking effect
        const offset = index * 4
        const zIndex = 30 - index * 10

        return (
          <div
            key={task.id}
            className={cn(
              'absolute bg-card rounded-sm shadow-lg border p-3 w-64',
              'transition-transform duration-150'
            )}
            style={{
              transform: `translate(${offset}px, ${offset}px)`,
              zIndex
            }}
          >
            {index === 0 ? (
              // First card shows task details
              <>
                <div className="font-medium truncate text-sm">{task.title}</div>
                {totalCount > 1 && (
                  <div className="text-sm text-primary mt-1">
                    +{totalCount - 1} more task{totalCount > 2 ? 's' : ''}
                  </div>
                )}
                {/* Show metadata for single task */}
                {totalCount === 1 && (
                  <div className="flex items-center gap-2 mt-2">
                    {task.priority !== 'none' && (
                      <PriorityBadge priority={task.priority} variant="full" size="sm" />
                    )}
                    {task.dueDate && (
                      <DueDateBadge
                        dueDate={task.dueDate}
                        dueTime={task.dueTime}
                        variant="compact"
                      />
                    )}
                  </div>
                )}
              </>
            ) : (
              // Other cards are empty placeholders for stacking visual
              <div className="h-10" />
            )}
          </div>
        )
      })}

      {/* Count badge - positioned at top-right of the stack */}
      <div
        className={cn(
          'absolute -top-2 -right-2 z-40',
          'flex items-center justify-center',
          'w-6 h-6 bg-primary text-primary-foreground',
          'text-xs font-bold rounded-full shadow-md'
        )}
      >
        {totalCount}
      </div>
    </div>
  )
}

// ============================================================================
// SINGLE TASK PREVIEW
// ============================================================================

interface SingleTaskPreviewProps {
  task: Task
  isCompleted?: boolean
  isOverdue?: boolean
}

/**
 * Single task preview for drag overlay
 */
export const SingleTaskPreview = ({
  task,
  isCompleted = false,
  isOverdue = false
}: SingleTaskPreviewProps): React.JSX.Element => {
  return (
    <div
      data-testid="drag-overlay"
      className={cn(
        'bg-card rounded-sm shadow-xl border p-3 w-64',
        'rotate-2 scale-105',
        isOverdue && !isCompleted && 'bg-rose-50/60 dark:bg-rose-950/20',
        isCompleted && 'opacity-70 bg-muted/30'
      )}
    >
      <div className="flex items-center gap-2">
        {task.priority !== 'none' && !isCompleted && (
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              backgroundColor:
                task.priority === 'high'
                  ? 'var(--task-priority-high)'
                  : task.priority === 'medium'
                    ? 'var(--task-priority-medium)'
                    : 'var(--task-priority-low)'
            }}
          />
        )}
        <span
          className={cn(
            'font-medium truncate text-sm',
            isCompleted && 'text-muted-foreground line-through'
          )}
        >
          {task.title}
        </span>
      </div>

      {!isCompleted && (task.dueDate || task.priority !== 'none') && (
        <div className="flex items-center gap-2 mt-2">
          {task.priority !== 'none' && (
            <PriorityBadge priority={task.priority} variant="full" size="sm" />
          )}
          {task.dueDate && (
            <DueDateBadge dueDate={task.dueDate} dueTime={task.dueTime} variant="compact" />
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// COMPACT MULTI-TASK BADGE
// ============================================================================

interface MultiTaskBadgeProps {
  count: number
  className?: string
}

/**
 * A compact badge showing the number of selected tasks
 */
export const MultiTaskBadge = ({ count, className }: MultiTaskBadgeProps): React.JSX.Element => {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center',
        'px-2 py-0.5 bg-primary text-primary-foreground',
        'text-xs font-medium rounded-full',
        className
      )}
    >
      {count} task{count !== 1 ? 's' : ''}
    </span>
  )
}

export default MultiDragOverlay
