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
import { ProjectIcon } from '@/components/tasks/project-icon'
import { addDays, startOfDay } from '@/lib/task-utils'
import type { Project, Status } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'
import { useT } from '@memry/i18n/renderer'

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
  const { t: tPhaseF } = useT('tasks')
  const [open, setOpen] = useState(false)

  // Get current project
  const _currentProject = projects.find((p) => p.id === task.projectId)

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
          aria-label={tPhaseF('phaseF.componentsTasksDragDropMoveMenu.moveTask')}
        >
          <MoveVertical className="size-4" />
          {!iconOnly && <span>{tPhaseF('phaseF.componentsTasksDragDropMoveMenu.move')}</span>}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        {/* Reschedule Section */}
        {onChangeDueDate && (
          <>
            <DropdownMenuLabel className="flex items-center gap-2 text-muted-foreground">
              <Calendar className="size-4" />

              {tPhaseF('phaseF.componentsTasksDragDropMoveMenu.reschedule')}
            </DropdownMenuLabel>

            <DropdownMenuItem onClick={() => handleDateChange(today)}>
              {tPhaseF('phaseF.componentsTasksDragDropMoveMenu.today')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleDateChange(tomorrow)}>
              {tPhaseF('phaseF.componentsTasksDragDropMoveMenu.tomorrow')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleDateChange(nextWeek)}>
              {tPhaseF('phaseF.componentsTasksDragDropMoveMenu.nextWeek')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleDateChange(null)}>
              {tPhaseF('phaseF.componentsTasksDragDropMoveMenu.removeDate')}
            </DropdownMenuItem>

            <DropdownMenuSeparator />
          </>
        )}

        {/* Change Project Section */}
        {onChangeProject && projects.length > 0 && (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderOpen className="size-4 me-2" />

                {tPhaseF('phaseF.componentsTasksDragDropMoveMenu.moveToProject')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {projects
                  .filter((p) => !p.isArchived)
                  .map((project) => {
                    const isCurrent = project.id === task.projectId

                    return (
                      <DropdownMenuItem
                        key={project.id}
                        onClick={() => handleProjectChange(project.id)}
                        disabled={isCurrent}
                      >
                        <ProjectIcon
                          icon={project.icon}
                          className="size-4 me-2"
                          color={project.color}
                          fallback={
                            <span
                              className="size-3 rounded-full me-2"
                              style={{ backgroundColor: project.color }}
                            />
                          }
                        />
                        {project.name}
                        {isCurrent && (
                          <span className="ms-auto text-muted-foreground text-xs">
                            {tPhaseF('phaseF.componentsTasksDragDropMoveMenu.current')}
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
                  className="size-3 rounded-full me-2"
                  style={{
                    backgroundColor: statuses.find((s) => s.id === task.statusId)?.color || '#888'
                  }}
                />

                {tPhaseF('phaseF.componentsTasksDragDropMoveMenu.changeStatus')}
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
                        className="size-3 rounded-full me-2"
                        style={{ backgroundColor: status.color }}
                      />
                      {status.name}
                      {isCurrent && (
                        <span className="ms-auto text-muted-foreground text-xs">
                          {tPhaseF('phaseF.componentsTasksDragDropMoveMenu.current2')}
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

              {tPhaseF('phaseF.componentsTasksDragDropMoveMenu.reorder')}
            </DropdownMenuLabel>

            {onMoveUp && (
              <DropdownMenuItem onClick={() => handleReorder('up')}>
                <ArrowUp className="size-4 me-2" />
                Move up
                <span className="ms-auto text-xs text-muted-foreground">Alt+↑</span>
              </DropdownMenuItem>
            )}

            {onMoveDown && (
              <DropdownMenuItem onClick={() => handleReorder('down')}>
                <ArrowDown className="size-4 me-2" />
                Move down
                <span className="ms-auto text-xs text-muted-foreground">Alt+↓</span>
              </DropdownMenuItem>
            )}

            {onMoveToTop && (
              <DropdownMenuItem onClick={() => handleReorder('top')}>
                <ChevronsUp className="size-4 me-2" />
                Move to top
                <span className="ms-auto text-xs text-muted-foreground">Alt+Shift+↑</span>
              </DropdownMenuItem>
            )}

            {onMoveToBottom && (
              <DropdownMenuItem onClick={() => handleReorder('bottom')}>
                <ChevronsDown className="size-4 me-2" />
                Move to bottom
                <span className="ms-auto text-xs text-muted-foreground">Alt+Shift+↓</span>
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default MoveMenu
