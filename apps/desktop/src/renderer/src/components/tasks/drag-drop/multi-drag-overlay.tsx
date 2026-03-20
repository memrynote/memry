import { cn } from '@/lib/utils'
import { DueDateBadge, PriorityBadge } from '@/components/tasks/task-badges'
import { TaskRow } from './task-row'
import { ParentTaskRow } from '@/components/tasks/parent-task-row'
import type { SubtaskProgress } from '@/lib/subtask-utils'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

export type OverlayRowVariant = 'task' | 'parent'

interface OverlayPresentationProps {
  overlayWidth?: number | null
  overlayRowVariant?: OverlayRowVariant | null
  overlayShowProjectBadge?: boolean
  overlayParentProgress?: SubtaskProgress | null
  overlayParentExpanded?: boolean
}

interface MultiDragOverlayProps extends OverlayPresentationProps {
  tasks: Task[]
  projects: Project[]
  maxPreview?: number
  variant?: 'list' | 'kanban'
}

interface SingleTaskPreviewProps extends OverlayPresentationProps {
  task: Task
  projects: Project[]
  isCompleted?: boolean
  isOverdue?: boolean
  variant?: 'list' | 'kanban'
}

interface MultiTaskBadgeProps {
  count: number
  className?: string
}

const noop = (): void => undefined

const getProjectForTask = (task: Task, projects: Project[]): Project | undefined =>
  projects.find((project) => project.id === task.projectId)

const isCompletedTask = (task: Task, projects: Project[]): boolean => {
  const project = getProjectForTask(task, projects)
  const status = project?.statuses.find((item) => item.id === task.statusId)
  return status?.type === 'done'
}

const resolveRowVariant = (task: Task, preferred?: OverlayRowVariant | null): OverlayRowVariant =>
  preferred ?? (task.subtaskIds.length > 0 ? 'parent' : 'task')

const resolveParentProgress = (task: Task, progress?: SubtaskProgress | null): SubtaskProgress =>
  progress ?? {
    completed: 0,
    total: task.subtaskIds.length,
    percentage: task.subtaskIds.length > 0 ? 0 : 100
  }

const ListGhostRow = ({
  task,
  projects,
  width,
  rowVariant,
  showProjectBadge,
  parentProgress,
  parentExpanded,
  testId
}: {
  task: Task
  projects: Project[]
  width?: number | null
  rowVariant?: OverlayRowVariant | null
  showProjectBadge?: boolean
  parentProgress?: SubtaskProgress | null
  parentExpanded?: boolean
  testId?: string
}): React.JSX.Element | null => {
  const project = getProjectForTask(task, projects)

  if (!project) return null

  const variant = resolveRowVariant(task, rowVariant)
  const content =
    variant === 'parent' ? (
      <ParentTaskRow
        task={task}
        project={project}
        projects={projects}
        subtasks={[]}
        progress={resolveParentProgress(task, parentProgress)}
        isExpanded={Boolean(parentExpanded)}
        isCompleted={isCompletedTask(task, projects)}
        showProjectBadge={Boolean(showProjectBadge)}
        onToggleExpand={noop}
        onToggleComplete={noop}
        renderMode="overlay"
        dataTestId={testId}
        overlayWidth={width}
      />
    ) : (
      <TaskRow
        task={task}
        project={project}
        projects={projects}
        isCompleted={isCompletedTask(task, projects)}
        showProjectBadge={Boolean(showProjectBadge)}
        onToggleComplete={noop}
        renderMode="overlay"
        dataTestId={testId}
        overlayWidth={width}
      />
    )

  return <div className="pointer-events-none">{content}</div>
}

export const MultiDragOverlay = ({
  tasks,
  projects,
  maxPreview = 3,
  variant = 'kanban',
  overlayWidth,
  overlayRowVariant,
  overlayShowProjectBadge = false,
  overlayParentProgress,
  overlayParentExpanded = false
}: MultiDragOverlayProps): React.JSX.Element => {
  const visibleTasks = tasks.slice(0, maxPreview)
  const totalCount = tasks.length

  if (variant === 'list') {
    const maxOffset = Math.max(visibleTasks.length - 1, 0) * 6
    const overlayContainerStyle: React.CSSProperties = {
      minHeight: `${44 + maxOffset}px`
    }

    if (overlayWidth) {
      overlayContainerStyle.width = `${overlayWidth + maxOffset}px`
    }

    return (
      <div
        className="relative pointer-events-none"
        data-testid="drag-overlay"
        data-overlay-variant="list-multi"
        style={overlayContainerStyle}
      >
        {visibleTasks.map((task, index) => {
          const offset = index * 6
          const zIndex = 40 - index * 10
          const isLeadRow = index === 0

          return (
            <div
              key={task.id}
              data-testid="overlay-ghost-row"
              className="absolute left-0 top-0 transition-transform duration-150"
              style={{
                transform: `translate(${offset}px, ${offset}px)`,
                zIndex
              }}
            >
              <ListGhostRow
                task={task}
                projects={projects}
                width={overlayWidth}
                rowVariant={isLeadRow ? overlayRowVariant : undefined}
                showProjectBadge={overlayShowProjectBadge}
                parentProgress={isLeadRow ? overlayParentProgress : undefined}
                parentExpanded={isLeadRow ? overlayParentExpanded : false}
              />
            </div>
          )
        })}

        <div
          className={cn(
            'absolute -top-2 -right-2 z-50',
            'flex items-center justify-center min-w-6 h-6 px-1.5',
            'rounded-full bg-[#4C9EFF] text-white text-xs font-semibold shadow-md'
          )}
        >
          {totalCount}
        </div>
      </div>
    )
  }

  const previewClassName = 'absolute bg-card rounded-sm shadow-lg border p-3 w-64'

  return (
    <div className="relative" data-testid="drag-overlay">
      {visibleTasks.map((task, index) => {
        const offset = index * 4
        const zIndex = 30 - index * 10

        return (
          <div
            key={task.id}
            className={cn(previewClassName, 'transition-transform duration-150')}
            style={{
              transform: `translate(${offset}px, ${offset}px)`,
              zIndex
            }}
          >
            {index === 0 ? (
              <>
                <div className="font-medium truncate text-[13px] text-foreground/90">
                  {task.title}
                </div>
                {totalCount > 1 && (
                  <div className="text-sm text-primary mt-1">
                    +{totalCount - 1} more task{totalCount > 2 ? 's' : ''}
                  </div>
                )}
              </>
            ) : (
              <div className="h-10" />
            )}
          </div>
        )
      })}

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

export const SingleTaskPreview = ({
  task,
  projects,
  isCompleted = false,
  isOverdue = false,
  variant = 'kanban',
  overlayWidth,
  overlayRowVariant,
  overlayShowProjectBadge = false,
  overlayParentProgress,
  overlayParentExpanded = false
}: SingleTaskPreviewProps): React.JSX.Element => {
  if (variant === 'list') {
    return (
      <ListGhostRow
        task={task}
        projects={projects}
        width={overlayWidth}
        rowVariant={overlayRowVariant}
        showProjectBadge={overlayShowProjectBadge}
        parentProgress={overlayParentProgress}
        parentExpanded={overlayParentExpanded}
        testId="drag-overlay"
      />
    )
  }

  return (
    <div
      data-testid="drag-overlay"
      className={cn(
        'bg-card rounded-sm border p-3 w-64 shadow-xl',
        'rotate-2 scale-105',
        isOverdue && !isCompleted && 'bg-rose-50/60 dark:bg-rose-950/20',
        isCompleted && 'opacity-70 bg-muted/30'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium truncate text-[13px] text-foreground/90">{task.title}</span>
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
