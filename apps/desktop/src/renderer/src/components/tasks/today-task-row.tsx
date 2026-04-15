import { cn } from '@/lib/utils'
import { formatTime, differenceInDays, startOfDay } from '@/lib/task-utils'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import {
  TaskCheckbox,
  InteractiveProjectBadge,
  InteractivePriorityBadge,
  InteractiveDueDateBadge
} from '@/components/tasks/task-badges'
import { RepeatIndicator } from '@/components/tasks/repeat-indicator'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

type TodayTaskSection = 'overdue' | 'today'

interface TodayTaskRowProps {
  task: Task
  projects: Project[]
  section: TodayTaskSection
  isSelected?: boolean
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onClick?: (taskId: string) => void
  className?: string
}

// ============================================================================
// TODAY TASK ROW COMPONENT
// ============================================================================

export const TodayTaskRow = ({
  task,
  projects,
  section,
  isSelected = false,
  onToggleComplete,
  onUpdateTask,
  onClick,
  className
}: TodayTaskRowProps): React.JSX.Element => {
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const isOverdue = section === 'overdue'

  const getTimeDisplay = (): string | null => {
    if (isOverdue && task.dueDate) {
      // Show original due date for overdue tasks
      return task.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }

    if (task.dueTime) {
      return formatTime(task.dueTime, clockFormat)
    }

    return null
  }

  const timeDisplay = getTimeDisplay()

  // Calculate days overdue
  const daysOverdue =
    isOverdue && task.dueDate
      ? differenceInDays(startOfDay(new Date()), startOfDay(task.dueDate))
      : 0

  const handleRowClick = (): void => {
    onClick?.(task.id)
  }

  const handleRowKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && onClick) {
      e.preventDefault()
      onClick(task.id)
    }
  }

  const handleToggleComplete = (): void => {
    onToggleComplete(task.id)
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

  return (
    <div
      role="button"
      tabIndex={onClick ? 0 : -1}
      onClick={onClick ? handleRowClick : undefined}
      onKeyDown={onClick ? handleRowKeyDown : undefined}
      className={cn(
        'group flex items-center gap-3 rounded-sm px-3 py-2.5 transition-colors duration-150',
        'hover:bg-accent/50',
        onClick && 'cursor-pointer focus-visible:outline-none',
        isOverdue && 'bg-task-due-overdue-bg/50',
        isSelected && 'bg-primary/10 ring-1 ring-inset ring-primary/30',
        className
      )}
      aria-label={`Task: ${task.title}${isOverdue ? ', overdue' : ''}`}
    >
      {/* Checkbox */}
      <TaskCheckbox checked={false} onChange={handleToggleComplete} priority={task.priority} />

      {/* Time/Date column */}
      <span
        className={cn(
          'w-20 text-sm tabular-nums shrink-0',
          isOverdue ? 'text-task-due-overdue font-medium' : 'text-text-tertiary'
        )}
      >
        {timeDisplay || '—'}
      </span>

      {/* Title */}
      <span className="flex-1 truncate text-[13px] font-medium text-foreground/90">
        {task.title}
      </span>

      {/* Repeat indicator */}
      {task.isRepeating && task.repeatConfig && (
        <RepeatIndicator config={task.repeatConfig} size="sm" />
      )}

      {/* Project badge - interactive */}
      <InteractiveProjectBadge
        projectId={task.projectId}
        projects={projects}
        onProjectChange={handleProjectChange}
      />

      {/* Priority - interactive */}
      <InteractivePriorityBadge
        priority={task.priority}
        onPriorityChange={handlePriorityChange}
        variant="full"
        compact
        className="shrink-0"
      />

      {/* Date - interactive */}
      <InteractiveDueDateBadge
        dueDate={task.dueDate}
        dueTime={task.dueTime}
        onDateChange={handleDateChange}
        isRepeating={task.isRepeating}
        variant="compact"
      />

      {/* Overdue label */}
      {isOverdue && daysOverdue > 0 && (
        <span className="text-xs text-task-due-overdue whitespace-nowrap font-medium">
          {daysOverdue === 1 ? '1 day overdue' : `${daysOverdue} days overdue`}
        </span>
      )}
    </div>
  )
}

export default TodayTaskRow
