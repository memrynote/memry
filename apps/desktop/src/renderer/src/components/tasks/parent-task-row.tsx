import { cn } from '@/lib/utils'
import { formatDueDate } from '@/lib/task-utils'
import { hasSubtasks, type SubtaskProgress } from '@/lib/subtask-utils'
import { priorityConfig } from '@/data/sample-tasks'
import { TaskCheckbox } from '@/components/tasks/task-badges'
import { RepeatIndicator } from '@/components/tasks/repeat-indicator'
import { ExpandChevron } from '@/components/tasks/expand-chevron'
import { SubtaskRow } from '@/components/tasks/subtask-row'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

interface ParentTaskRowProps {
  task: Task
  subtasks: Task[]
  progress: SubtaskProgress
  project: Project
  isExpanded: boolean
  isCompleted: boolean
  isSelected?: boolean
  showProjectBadge?: boolean
  onToggleExpand: (taskId: string) => void
  onToggleComplete: (taskId: string) => void
  onToggleSubtaskComplete?: (subtaskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
}

export const ParentTaskRow = ({
  task,
  subtasks,
  progress,
  project,
  isExpanded,
  isCompleted,
  isSelected = false,
  showProjectBadge = false,
  onToggleExpand,
  onToggleComplete,
  onToggleSubtaskComplete,
  onClick,
  className
}: ParentTaskRowProps): React.JSX.Element => {
  const taskHasSubtasks = hasSubtasks(task)
  const priorityColor = priorityConfig[task.priority]?.color

  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === 'overdue' && !isCompleted

  const handleExpandToggle = (): void => {
    if (taskHasSubtasks) onToggleExpand(task.id)
  }

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
        style={{
          borderLeftColor: priorityColor && !isCompleted ? priorityColor : 'transparent',
          backgroundColor: priorityColor && !isCompleted ? `${priorityColor}05` : undefined
        }}
        className={cn(
          'flex items-center gap-2.5 border-l-[3px] rounded-r-md',
          'py-2 px-3 transition-all duration-150',
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

        <TaskCheckbox checked={isCompleted} onChange={() => onToggleComplete(task.id)} />

        <span
          className={cn(
            'text-[13px] font-medium leading-4 whitespace-nowrap shrink-0',
            isCompleted ? 'line-through text-muted-foreground' : 'text-foreground'
          )}
        >
          {task.title}
        </span>

        {!isCompleted && (
          <div className="flex items-center gap-[5px] ml-1">
            {task.priority !== 'none' && priorityColor && (
              <span
                className="inline-flex items-center gap-[3px] rounded-[3px] px-1.5 py-px"
                style={{ backgroundColor: `${priorityColor}14`, color: priorityColor }}
              >
                <span
                  className="size-1 rounded-full shrink-0"
                  style={{ backgroundColor: priorityColor }}
                />
                <span className="text-[10px] font-medium leading-3">
                  {priorityConfig[task.priority].label}
                </span>
              </span>
            )}

            {showProjectBadge && (
              <span
                className="inline-flex items-center gap-[3px] rounded-[3px] px-1.5 py-px"
                style={{ backgroundColor: `${project.color}0F`, color: project.color }}
              >
                <span
                  className="size-1 rounded-full shrink-0"
                  style={{ backgroundColor: project.color }}
                />
                <span className="text-[10px] font-medium leading-3">{project.name}</span>
              </span>
            )}
          </div>
        )}

        {task.isRepeating && task.repeatConfig && !isCompleted && (
          <RepeatIndicator config={task.repeatConfig} size="sm" />
        )}

        {formattedDate && (
          <span
            className={cn(
              'text-[10px] leading-3 shrink-0 ml-auto',
              isOverdue ? 'text-[#C4654A]' : 'text-muted-foreground'
            )}
          >
            {formattedDate.label}
          </span>
        )}

        {taskHasSubtasks && (
          <div className={cn('flex items-center gap-[3px] shrink-0', !formattedDate && 'ml-auto')}>
            <div className="w-5 h-[3px] rounded-sm overflow-clip bg-[#EDECE8]">
              <div
                className="h-full rounded-sm bg-[#7B9E87]"
                style={{ width: `${progress.percentage}%` }}
              />
            </div>
            <span className="text-[9px] text-muted-foreground font-mono leading-3">
              {progress.completed}/{progress.total}
            </span>
          </div>
        )}
      </div>

      {isExpanded && taskHasSubtasks && (
        <div id={`subtasks-${task.id}`} role="group" aria-label={`Subtasks of ${task.title}`}>
          {subtasks.map((subtask, index) => (
            <SubtaskRow
              key={subtask.id}
              subtask={subtask}
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
