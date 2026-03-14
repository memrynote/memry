import { Archive, Trash2, Check } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatTime } from '@/lib/task-utils'
import { ProjectBadge } from '@/components/tasks/task-badges'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface CompletedTaskRowProps {
  task: Task
  project?: Project
  onUncomplete: (taskId: string) => void
  onArchive: (taskId: string) => void
  onDelete: (taskId: string) => void
  className?: string
}

// ============================================================================
// COMPLETED CHECKBOX (Green filled)
// ============================================================================

interface CompletedCheckboxProps {
  onClick: () => void
  className?: string
}

const CompletedCheckbox = ({ onClick, className }: CompletedCheckboxProps): React.JSX.Element => {
  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onClick()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      onClick()
    }
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            role="checkbox"
            aria-checked="true"
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            tabIndex={0}
            className={cn(
              'size-5 shrink-0 rounded-full transition-all duration-150',
              'bg-emerald-500 dark:bg-emerald-600',
              'hover:bg-emerald-600 dark:hover:bg-emerald-500',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              className
            )}
            aria-label="Mark as incomplete"
          >
            <Check className="size-full text-white p-0.5" strokeWidth={3} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Mark as incomplete
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// ============================================================================
// COMPLETED TASK ROW
// ============================================================================

export const CompletedTaskRow = ({
  task,
  project,
  onUncomplete,
  onArchive,
  onDelete,
  className
}: CompletedTaskRowProps): React.JSX.Element => {
  // Format completion time
  const getCompletionTime = (): string => {
    if (!task.completedAt) return ''

    const completedDate = new Date(task.completedAt)
    const now = new Date()
    const isToday = completedDate.toDateString() === now.toDateString()

    if (isToday) {
      // Show time for today's tasks
      return formatTime(
        `${completedDate.getHours().toString().padStart(2, '0')}:${completedDate.getMinutes().toString().padStart(2, '0')}`
      )
    }

    // Show short date for older tasks
    return completedDate.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    })
  }

  const handleUncomplete = (): void => {
    onUncomplete(task.id)
  }

  const handleArchive = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onArchive(task.id)
  }

  const handleDelete = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onDelete(task.id)
  }

  return (
    <div
      className={cn(
        'group flex items-center gap-3 rounded-sm px-3 py-2.5 transition-colors duration-150',
        'hover:bg-accent/50',
        className
      )}
      role="listitem"
      aria-label={`Completed task: ${task.title}`}
    >
      {/* Green completed checkbox */}
      <CompletedCheckbox onClick={handleUncomplete} />

      {/* Title (muted, with strikethrough) */}
      <span className="flex-1 truncate text-sm text-text-tertiary line-through">{task.title}</span>

      {/* Completion time (shown on hover and always) */}
      <span className="text-xs text-text-tertiary tabular-nums shrink-0 min-w-[60px] text-right">
        {getCompletionTime()}
      </span>

      {/* Project badge (optional) */}
      {project && <ProjectBadge project={project} className="opacity-60" />}

      {/* Hover actions */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={handleArchive}
                aria-label="Archive task"
              >
                <Archive className="size-4 text-text-tertiary" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Archive
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 hover:text-destructive"
                onClick={handleDelete}
                aria-label="Delete task"
              >
                <Trash2 className="size-4 text-text-tertiary" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Delete
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )
}

export default CompletedTaskRow
