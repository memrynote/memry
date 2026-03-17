import { cn } from '@/lib/utils'
import { hasSubtasks, type SubtaskProgress } from '@/lib/subtask-utils'
import { formatDueDate, formatDateShort, formatTime } from '@/lib/task-utils'
import { PriorityBars } from '@/components/tasks/task-icons'
import { InteractiveStatusIcon } from '@/components/tasks/status-icon'
import { ExpandChevron } from '@/components/tasks/expand-chevron'
import { SubtaskRow } from '@/components/tasks/subtask-row'
import type { Task } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface ParentTaskRowProps {
  task: Task
  subtasks: Task[]
  progress: SubtaskProgress
  project: Project
  projects?: Project[]
  isExpanded: boolean
  isCompleted: boolean
  isSelected?: boolean
  showProjectBadge?: boolean
  onToggleExpand: (taskId: string) => void
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onToggleSubtaskComplete?: (subtaskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
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
// PARENT TASK ROW — Linear-style with expand/collapse
// ============================================================================

export const ParentTaskRow = ({
  task,
  subtasks,
  progress,
  project,
  projects: _projects = [],
  isExpanded,
  isCompleted,
  isSelected = false,
  showProjectBadge = false,
  onToggleExpand,
  onToggleComplete,
  onUpdateTask: _onUpdateTask,
  onToggleSubtaskComplete,
  onClick,
  className
}: ParentTaskRowProps): React.JSX.Element => {
  const taskHasSubtasks = hasSubtasks(task)
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === 'overdue' && !isCompleted
  const { type: statusType, color: statusColor } = resolveStatus(task, project.statuses)

  const handleExpandToggle = (): void => {
    if (taskHasSubtasks) onToggleExpand(task.id)
  }

  const handleToggleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onToggleComplete(task.id)
  }

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
    <div className={cn('group', className)}>
      <div
        role="button"
        tabIndex={onClick ? 0 : -1}
        onClick={() => onClick?.(task.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onClick) {
            e.preventDefault()
            onClick(task.id)
          }
          if (taskHasSubtasks) {
            if (e.key === 'ArrowRight' && !isExpanded) {
              e.preventDefault()
              onToggleExpand(task.id)
            }
            if (e.key === 'ArrowLeft' && isExpanded) {
              e.preventDefault()
              onToggleExpand(task.id)
            }
          }
        }}
        className={cn(
          'flex items-center py-[7px] px-6 gap-3 border-b border-border transition-colors',
          'hover:bg-accent/50',
          onClick &&
            'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isSelected && 'bg-primary/10 ring-2 ring-primary/30'
        )}
        aria-label={`Task: ${task.title}${isCompleted ? ', completed' : ''}${taskHasSubtasks ? `, ${subtasks.length} subtasks` : ''}`}
      >
        <ExpandChevron
          isExpanded={isExpanded}
          hasSubtasks={taskHasSubtasks}
          onClick={handleExpandToggle}
          size="sm"
        />

        <InteractiveStatusIcon
          type={statusType}
          color={statusColor}
          isCompleted={isCompleted}
          onClick={handleToggleClick}
        />

        <PriorityBars priority={task.priority} />

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

        {taskHasSubtasks && (
          <div className="flex items-center gap-[3px] shrink-0">
            <div className="w-5 h-[3px] rounded-sm overflow-clip bg-border">
              <div
                className="h-full rounded-sm"
                style={{ width: `${progress.percentage}%`, backgroundColor: statusColor }}
              />
            </div>
            <span className="text-[9px] text-text-tertiary font-[family-name:var(--font-mono)] leading-3">
              {progress.completed}/{progress.total}
            </span>
          </div>
        )}

        {showProjectBadge && (
          <div className="flex items-center shrink-0 gap-[5px]">
            <div
              className="rounded-xs shrink-0 size-2"
              style={{ backgroundColor: project.color }}
            />
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
            style={
              'colorStyle' in dueDateDisplay ? { color: dueDateDisplay.colorStyle } : undefined
            }
          >
            {dueDateDisplay.text}
          </div>
        )}
      </div>

      {isExpanded && taskHasSubtasks && (
        <div id={`subtasks-${task.id}`} role="group" aria-label={`Subtasks of ${task.title}`}>
          {subtasks.map((subtask, index) => (
            <SubtaskRow
              key={subtask.id}
              subtask={subtask}
              statuses={project.statuses}
              isLast={index === subtasks.length - 1}
              onToggleComplete={onToggleSubtaskComplete || onToggleComplete}
              onClick={onClick}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default ParentTaskRow
