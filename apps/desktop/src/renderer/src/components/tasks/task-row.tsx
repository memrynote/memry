import { cn } from '@/lib/utils'
import { formatDueDate, formatDateShort, formatTime } from '@/lib/task-utils'
import { InlineStatusPopover } from '@/components/tasks/inline-status-popover'
import { InlinePriorityPopover } from '@/components/tasks/inline-priority-popover'
import { SelectionCheckbox } from '@/components/tasks/bulk-actions'
import { RepeatIndicator } from '@/components/tasks/repeat-indicator'
import type { Task } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface TaskRowProps {
  task: Task
  project: Project
  projects: Project[]
  isCompleted: boolean
  isSelected?: boolean
  showProjectBadge?: boolean
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onClick?: (taskId: string) => void
  className?: string
  isSelectionMode?: boolean
  isCheckedForSelection?: boolean
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
}

// ============================================================================
// HELPERS
// ============================================================================

const resolveStatus = (
  task: Task,
  statuses: Status[]
): { type: 'todo' | 'in_progress' | 'done'; color: string } => {
  const status = statuses.find((s) => s.id === task.statusId)
  return {
    type: (status?.type as 'todo' | 'in_progress' | 'done') || 'todo',
    color: status?.color || 'var(--text-tertiary)'
  }
}

// ============================================================================
// TASK ROW — Linear-style flat row
// ============================================================================

export const TaskRow = ({
  task,
  project,
  projects: _projects,
  isCompleted,
  isSelected = false,
  showProjectBadge = false,
  onToggleComplete,
  onUpdateTask,
  onClick,
  className,
  isSelectionMode = false,
  isCheckedForSelection = false,
  onToggleSelect,
  onShiftSelect
}: TaskRowProps): React.JSX.Element => {
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === 'overdue' && !isCompleted
  const { color: statusColor } = resolveStatus(task, project.statuses)

  const handleRowClick = (e: React.MouseEvent): void => {
    if (e.shiftKey && isSelectionMode && onShiftSelect) {
      e.preventDefault()
      onShiftSelect(task.id)
      return
    }
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      e.preventDefault()
      onToggleSelect(task.id)
      return
    }
    if (isSelectionMode && onToggleSelect) {
      onToggleSelect(task.id)
      return
    }
    onClick?.(task.id)
  }

  const handleRowKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && onClick) {
      e.preventDefault()
      onClick(task.id)
    }
  }

  const showSelection = !!onToggleSelect

  const compactDateLabel = (() => {
    if (!task.dueDate) return null
    const date = formatDateShort(task.dueDate)
    return task.dueTime ? `${date}, ${formatTime(task.dueTime)}` : date
  })()

  const dueDateDisplay = (() => {
    if (isCompleted) return { text: 'Done', colorStyle: statusColor }
    if (!compactDateLabel) return null
    if (isOverdue) return { text: compactDateLabel, colorClass: 'text-destructive' }
    return { text: compactDateLabel, colorClass: 'text-text-tertiary' }
  })()

  return (
    <div
      role="button"
      tabIndex={onClick ? 0 : -1}
      onClick={handleRowClick}
      onKeyDown={onClick ? handleRowKeyDown : undefined}
      className={cn(
        'group flex items-center py-[7px] px-6 gap-3 transition-colors',
        'rounded-md hover:bg-accent/60',
        onClick &&
          'cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        isCheckedForSelection && 'bg-primary/10 hover:bg-primary/15',
        isSelected && !isCheckedForSelection && 'bg-primary/10 ring-1 ring-inset ring-primary/30',
        className
      )}
      aria-label={`Task: ${task.title}${isCompleted ? ', completed' : ''}`}
    >
      {isSelectionMode && showSelection && (
        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <SelectionCheckbox
            checked={isCheckedForSelection}
            onChange={() => onToggleSelect?.(task.id)}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            aria-label={`Select ${task.title}`}
          />
        </div>
      )}

      <InlineStatusPopover
        statusId={task.statusId}
        statuses={project.statuses}
        isCompleted={isCompleted}
        onStatusChange={(statusId) => onUpdateTask?.(task.id, { statusId })}
        onToggleComplete={() => onToggleComplete(task.id)}
      />

      <InlinePriorityPopover
        priority={task.priority}
        onPriorityChange={(priority) => onUpdateTask?.(task.id, { priority })}
      />

      <span
        className={cn(
          'text-[13px] leading-4 grow shrink basis-0 truncate',
          isCompleted
            ? 'text-text-tertiary line-through decoration-1 [text-underline-position:from-font]'
            : 'text-text-primary'
        )}
      >
        {task.title}
      </span>

      {task.isRepeating && task.repeatConfig && (
        <RepeatIndicator config={task.repeatConfig} size="sm" />
      )}

      {showProjectBadge && (
        <div className="flex items-center shrink-0 gap-[5px]">
          <div className="rounded-xs shrink-0 size-2" style={{ backgroundColor: project.color }} />
          <div className="text-[11px] text-text-tertiary leading-3.5 truncate max-w-[100px]">
            {project.name}
          </div>
        </div>
      )}

      {dueDateDisplay && (
        <div
          className={cn(
            'text-[11px] shrink-0 text-right leading-3.5 whitespace-nowrap',
            'colorClass' in dueDateDisplay && dueDateDisplay.colorClass
          )}
          style={'colorStyle' in dueDateDisplay ? { color: dueDateDisplay.colorStyle } : undefined}
        >
          {dueDateDisplay.text}
        </div>
      )}
    </div>
  )
}

export default TaskRow
