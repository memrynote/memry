import { useState } from 'react'
import {
  Calendar,
  FolderOpen,
  ArrowUp,
  ArrowDown,
  ChevronsUp,
  ChevronsDown,
  MoveVertical
} from '@/lib/icons'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { getIconByName } from '@/components/icon-picker'
import { addDays, startOfDay } from '@/lib/task-utils'
import type { Project, Status } from '@/data/tasks-data'
import type { Task } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface MoveMenuProps {
  /** The task to move */
  task: Task
  /** Available projects */
  projects: Project[]
  /** Available statuses (for current project) */
  statuses?: Status[]
  /** Callback when due date changes */
  onChangeDueDate?: (date: Date | null) => void
  /** Callback when project changes */
  onChangeProject?: (projectId: string) => void
  /** Callback when status changes */
  onChangeStatus?: (statusId: string) => void
  /** Callback to move task up in list */
  onMoveUp?: () => void
  /** Callback to move task down in list */
  onMoveDown?: () => void
  /** Callback to move task to top of list */
  onMoveToTop?: () => void
  /** Callback to move task to bottom of list */
  onMoveToBottom?: () => void
  /** Additional class names */
  className?: string
  /** Whether to show as icon only */
  iconOnly?: boolean
}

// ============================================================================
// MOVE MENU COMPONENT
// ============================================================================

/**
 * A dropdown menu providing keyboard-accessible alternatives to drag operations
 * Allows users to reschedule, move to project, change status, and reorder tasks
 */
export const MoveMenu = ({
  task,
  projects,
  statuses,
  onChangeDueDate,
  onChangeProject,
  onChangeStatus,
  onMoveUp,
  onMoveDown,
  onMoveToTop,
  onMoveToBottom,
  className,
  iconOnly = false
}: MoveMenuProps): React.JSX.Element => {
  const [open, setOpen] = useState(false)

  // Get current project
  const currentProject = projects.find((p) => p.id === task.projectId)

  // Quick date options
  const today = startOfDay(new Date())
  const tomorrow = addDays(today, 1)
  const nextWeek = addDays(today, 7)

  const handleDateChange = (date: Date | null): void => {
    onChangeDueDate?.(date)
    setOpen(false)
  }

  const handleProjectChange = (projectId: string): void => {
    onChangeProject?.(projectId)
    setOpen(false)
  }

  const handleStatusChange = (statusId: string): void => {
    onChangeStatus?.(statusId)
    setOpen(false)
  }

  const handleReorder = (action: 'up' | 'down' | 'top' | 'bottom'): void => {
    switch (action) {
      case 'up':
        onMoveUp?.()
        break
      case 'down':
        onMoveDown?.()
        break
      case 'top':
        onMoveToTop?.()
        break
      case 'bottom':
        onMoveToBottom?.()
        break
    }
    setOpen(false)
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-8 gap-1.5', iconOnly && 'w-8 p-0', className)}
          aria-label={'Move task' /* TODO(i18n): wrap aria-label in t() */}
        >
          <MoveVertical className="size-4" />
          {!iconOnly && <span>{/* TODO(i18n): wrap in t() */}Move</span>}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        {/* Reschedule Section */}
        {onChangeDueDate && (
          <>
            <DropdownMenuLabel className="flex items-center gap-2 text-muted-foreground">
              <Calendar className="size-4" />
              {/* TODO(i18n): wrap in t() */}
              Reschedule
            </DropdownMenuLabel>

            <DropdownMenuItem onClick={() => handleDateChange(today)}>
              {/* TODO(i18n): wrap in t() */}Today
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleDateChange(tomorrow)}>
              {/* TODO(i18n): wrap in t() */}Tomorrow
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleDateChange(nextWeek)}>
              {/* TODO(i18n): wrap in t() */}
              Next week
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleDateChange(null)}>
              {/* TODO(i18n): wrap in t() */}Remove date
            </DropdownMenuItem>

            <DropdownMenuSeparator />
          </>
        )}

        {/* Change Project Section */}
        {onChangeProject && projects.length > 0 && (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderOpen className="size-4 mr-2" />
                {/* TODO(i18n): wrap in t() */}
                Move to project
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {projects
                  .filter((p) => !p.isArchived)
                  .map((project) => {
                    const IconComponent = getIconByName(project.icon)
                    const isCurrent = project.id === task.projectId

                    return (
                      <DropdownMenuItem
                        key={project.id}
                        onClick={() => handleProjectChange(project.id)}
                        disabled={isCurrent}
                      >
                        {IconComponent ? (
                          <IconComponent className="size-4 mr-2" style={{ color: project.color }} />
                        ) : (
                          <span
                            className="size-3 rounded-full mr-2"
                            style={{ backgroundColor: project.color }}
                          />
                        )}
                        {project.name}
                        {isCurrent && (
                          <span className="ml-auto text-muted-foreground text-xs">
                            {/* TODO(i18n): wrap in t() */}Current
                          </span>
                        )}
                      </DropdownMenuItem>
                    )
                  })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />
          </>
        )}

        {/* Change Status Section */}
        {onChangeStatus && statuses && statuses.length > 0 && (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span
                  className="size-3 rounded-full mr-2"
                  style={{
                    backgroundColor: statuses.find((s) => s.id === task.statusId)?.color || '#888'
                  }}
                />
                {/* TODO(i18n): wrap in t() */}
                Change status
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {statuses.map((status) => {
                  const isCurrent = status.id === task.statusId

                  return (
                    <DropdownMenuItem
                      key={status.id}
                      onClick={() => handleStatusChange(status.id)}
                      disabled={isCurrent}
                    >
                      <span
                        className="size-3 rounded-full mr-2"
                        style={{ backgroundColor: status.color }}
                      />
                      {status.name}
                      {isCurrent && (
                        <span className="ml-auto text-muted-foreground text-xs">
                          {/* TODO(i18n): wrap in t() */}Current
                        </span>
                      )}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />
          </>
        )}

        {/* Reorder Section */}
        {(onMoveUp || onMoveDown || onMoveToTop || onMoveToBottom) && (
          <>
            <DropdownMenuLabel className="flex items-center gap-2 text-muted-foreground">
              <MoveVertical className="size-4" />
              {/* TODO(i18n): wrap in t() */}
              Reorder
            </DropdownMenuLabel>

            {onMoveUp && (
              <DropdownMenuItem onClick={() => handleReorder('up')}>
                <ArrowUp className="size-4 mr-2" />
                {/* TODO(i18n): wrap in t() */}
                Move up
                <span className="ml-auto text-xs text-muted-foreground">
                  {/* TODO(i18n): wrap in t() */}Alt+↑
                </span>
              </DropdownMenuItem>
            )}

            {onMoveDown && (
              <DropdownMenuItem onClick={() => handleReorder('down')}>
                <ArrowDown className="size-4 mr-2" />
                {/* TODO(i18n): wrap in t() */}
                Move down
                <span className="ml-auto text-xs text-muted-foreground">
                  {/* TODO(i18n): wrap in t() */}Alt+↓
                </span>
              </DropdownMenuItem>
            )}

            {onMoveToTop && (
              <DropdownMenuItem onClick={() => handleReorder('top')}>
                <ChevronsUp className="size-4 mr-2" />
                {/* TODO(i18n): wrap in t() */}
                Move to top
                <span className="ml-auto text-xs text-muted-foreground">
                  {/* TODO(i18n): wrap in t() */}Alt+Shift+↑
                </span>
              </DropdownMenuItem>
            )}

            {onMoveToBottom && (
              <DropdownMenuItem onClick={() => handleReorder('bottom')}>
                <ChevronsDown className="size-4 mr-2" />
                {/* TODO(i18n): wrap in t() */}
                Move to bottom
                <span className="ml-auto text-xs text-muted-foreground">
                  {/* TODO(i18n): wrap in t() */}Alt+Shift+↓
                </span>
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default MoveMenu
