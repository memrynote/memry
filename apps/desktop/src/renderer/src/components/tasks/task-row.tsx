import { cn } from '@/lib/utils'
import { formatDueDate, getDaysOverdue, getOverdueTier } from '@/lib/task-utils'
import {
  TaskCheckbox,
  InteractiveProjectBadge,
  InteractivePriorityBadge,
  InteractiveDueDateBadge
} from '@/components/tasks/task-badges'
import { RepeatIndicator } from '@/components/tasks/repeat-indicator'
import { SelectionCheckbox } from '@/components/tasks/bulk-actions'
import { priorityConfig, type Priority } from '@/data/sample-tasks'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

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

const getLeftBorderColor = (task: Task, isCompleted: boolean): string | undefined => {
  if (isCompleted) return undefined
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === 'overdue'
  if (isOverdue) return priorityConfig[task.priority]?.color ?? '#EF4444'
  if (task.priority === 'urgent') return '#EF4444'
  if (task.priority === 'high') return '#F97316'
  if (task.priority === 'medium') return '#F59E0B'
  return undefined
}

export const TaskRow = ({
  task,
  project,
  projects,
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
  const isOverdue = formattedDate?.status === 'overdue'
  const daysOver = isOverdue && !isCompleted ? getDaysOverdue(task.dueDate) : 0
  const overdueTier = daysOver > 0 ? getOverdueTier(daysOver) : null
  const leftBorderColor = getLeftBorderColor(task, isCompleted)
  const priorityColor = priorityConfig[task.priority]?.color

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

  const handleProjectChange = (projectId: string): void => {
    onUpdateTask?.(task.id, { projectId })
  }

  const handlePriorityChange = (priority: Priority): void => {
    onUpdateTask?.(task.id, { priority })
  }

  const handleDateChange = (date: Date | null): void => {
    onUpdateTask?.(task.id, { dueDate: date })
  }

  const showSelection = !!onToggleSelect

  return (
    <div
      role="button"
      tabIndex={onClick ? 0 : -1}
      onClick={handleRowClick}
      onKeyDown={onClick ? handleRowKeyDown : undefined}
      style={{
        borderLeftWidth: '3px',
        borderLeftStyle: 'solid',
        borderLeftColor: leftBorderColor || 'transparent'
      }}
      className={cn(
        'group flex items-center py-2 px-3 gap-2.5 rounded-r-sm transition-colors duration-150',
        'hover:bg-accent/50',
        onClick &&
          'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isOverdue && !isCompleted && 'bg-[#EF444405]',
        overdueTier === 'severe' && 'overdue-pulse',
        isCheckedForSelection && 'bg-primary/10 hover:bg-primary/15',
        isSelected && !isCheckedForSelection && 'bg-primary/10 ring-2 ring-primary/30',
        'mt-0.5',
        className
      )}
      aria-label={`Task: ${task.title}${isCompleted ? ', completed' : ''}`}
    >
      {/* Selection checkbox */}
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

      {/* Checkbox */}
      <TaskCheckbox
        checked={isCompleted}
        onChange={() => onToggleComplete(task.id)}
        disabled={isSelectionMode}
      />

      {/* Title — flex-1 fills remaining space, min-w-0 enables truncation */}
      <span
        className={cn(
          'text-[13px] font-medium leading-4 truncate flex-1 min-w-0',
          isCompleted
            ? 'text-text-tertiary line-through decoration-text-tertiary'
            : 'text-text-primary'
        )}
      >
        {task.title}
      </span>

      {/* Pills — shrink-0 keeps them pinned right after the flex-1 title */}
      <div className="flex items-center gap-[5px] shrink-0">
        {!isCompleted && task.priority !== 'none' && priorityColor && (
          <InteractivePriorityBadge
            priority={task.priority}
            onPriorityChange={handlePriorityChange}
            compact
            className="!rounded-sm !py-px !px-1.5 !gap-[3px]"
          />
        )}

        {!isCompleted && showProjectBadge && (
          <InteractiveProjectBadge
            project={project}
            projects={projects}
            onProjectChange={handleProjectChange}
            className="!rounded-sm !py-px !px-1.5 !gap-[3px] !text-[10px]"
          />
        )}

        <InteractiveDueDateBadge
          dueDate={task.dueDate}
          dueTime={task.dueTime}
          onDateChange={handleDateChange}
          isRepeating={task.isRepeating}
          className={cn('!text-[10px]', isCompleted && 'opacity-60')}
        />
      </div>
    </div>
  )
}

export default TaskRow
