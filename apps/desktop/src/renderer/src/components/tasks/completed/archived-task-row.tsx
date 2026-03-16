import { Archive, RotateCcw, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { ProjectBadge } from '@/components/tasks/task-badges'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface ArchivedTaskRowProps {
  task: Task
  project?: Project
  onRestore: (taskId: string) => void
  onDelete: (taskId: string) => void
  className?: string
}

// ============================================================================
// ARCHIVED TASK ROW
// ============================================================================

export const ArchivedTaskRow = ({
  task,
  project,
  onRestore,
  onDelete,
  className
}: ArchivedTaskRowProps): React.JSX.Element => {
  // Format completed date
  const getCompletedDate = (): string => {
    if (!task.completedAt) return ''

    return new Date(task.completedAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
  }

  const handleRestore = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onRestore(task.id)
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
      aria-label={`Archived task: ${task.title}`}
    >
      {/* Archive icon */}
      <div className="size-5 shrink-0 flex items-center justify-center">
        <Archive className="size-4 text-text-tertiary" aria-hidden="true" />
      </div>

      {/* Title (muted) */}
      <span className="flex-1 truncate text-sm text-text-tertiary">{task.title}</span>

      {/* Completed date */}
      <span className="text-xs text-text-tertiary tabular-nums shrink-0 min-w-[80px] text-right">
        Completed {getCompletedDate()}
      </span>

      {/* Project badge (optional) */}
      {project && <ProjectBadge project={project} className="opacity-50" />}

      {/* Hover actions */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={handleRestore}
                aria-label="Restore task"
              >
                <RotateCcw className="size-4 text-text-tertiary" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Restore to completed
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
                aria-label="Delete permanently"
              >
                <Trash2 className="size-4 text-text-tertiary" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Delete permanently
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )
}

export default ArchivedTaskRow
