import { useRef, useEffect, useState, memo } from 'react'

import { cn } from '@/lib/utils'
import { formatDueDate, formatDateShort, formatTime } from '@/lib/task-utils'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { PriorityBars } from '@/components/tasks/task-icons'
import { StatusIcon } from '@/components/tasks/status-icon'
import { InlineStatusPopover } from '@/components/tasks/inline-status-popover'
import { InlinePriorityPopover } from '@/components/tasks/inline-priority-popover'
import { SelectionCheckbox } from '@/components/tasks/bulk-actions'
import { RepeatIndicator } from '@/components/tasks/repeat-indicator'
import { InsertionIndicator } from './insertion-indicator'
import type { SectionDragState } from './list-section-drag-state'

import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'

interface TaskRowProps {
  task: Task
  project: Project
  projects: Project[]
  allTasks?: Task[]
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
  accentClass?: string
  isDragging?: boolean
  isJustDropped?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dragHandleListeners?: Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dragHandleAttributes?: Record<string, any>
  droppedPriority?: Priority | null
  insertionIndicatorPosition?: 'before' | 'after'
  sectionDragState?: SectionDragState
  renderMode?: 'live' | 'overlay'
  dataTestId?: string
  overlayWidth?: number | null
}

const EXIT_ANIMATION_DURATION = 200

const arePropsEqual = (prevProps: TaskRowProps, nextProps: TaskRowProps): boolean => {
  if (prevProps.task.id !== nextProps.task.id) return false
  if (prevProps.task.title !== nextProps.task.title) return false
  if (prevProps.task.priority !== nextProps.task.priority) return false
  if (prevProps.task.statusId !== nextProps.task.statusId) return false
  if (prevProps.task.isRepeating !== nextProps.task.isRepeating) return false
  if (prevProps.task.repeatConfig !== nextProps.task.repeatConfig) return false
  if (prevProps.task.projectId !== nextProps.task.projectId) return false
  const prevDate = prevProps.task.dueDate?.getTime() ?? null
  const nextDate = nextProps.task.dueDate?.getTime() ?? null
  if (prevDate !== nextDate) return false
  if (prevProps.task.dueTime !== nextProps.task.dueTime) return false
  if (prevProps.isCompleted !== nextProps.isCompleted) return false
  if (prevProps.isSelected !== nextProps.isSelected) return false
  if (prevProps.isSelectionMode !== nextProps.isSelectionMode) return false
  if (prevProps.isCheckedForSelection !== nextProps.isCheckedForSelection) return false
  if (prevProps.showProjectBadge !== nextProps.showProjectBadge) return false
  if (prevProps.accentClass !== nextProps.accentClass) return false
  if (prevProps.project.id !== nextProps.project.id) return false
  if (prevProps.isDragging !== nextProps.isDragging) return false
  if (prevProps.isJustDropped !== nextProps.isJustDropped) return false
  if (prevProps.droppedPriority !== nextProps.droppedPriority) return false
  if (prevProps.insertionIndicatorPosition !== nextProps.insertionIndicatorPosition) return false
  if (prevProps.sectionDragState !== nextProps.sectionDragState) return false
  if (prevProps.renderMode !== nextProps.renderMode) return false
  return true
}

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

const PRIORITY_LABELS: Record<string, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None'
}

const TaskRowComponent = ({
  task,
  project,
  projects: _projects,
  allTasks: _allTasks,
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
  onShiftSelect,
  accentClass: _accentClass,
  isDragging = false,
  isJustDropped = false,
  dragHandleListeners,
  dragHandleAttributes,
  droppedPriority,
  insertionIndicatorPosition,
  sectionDragState = 'none',
  renderMode = 'live',
  dataTestId,
  overlayWidth
}: TaskRowProps): React.JSX.Element => {
  const isOverlay = renderMode === 'overlay'
  const rowRef = useRef<HTMLDivElement>(null)
  const [isExiting, setIsExiting] = useState(false)
  const {
    settings: { clockFormat }
  } = useGeneralSettings()

  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isSelected])

  const style: React.CSSProperties | undefined = isOverlay
    ? overlayWidth
      ? { width: `${overlayWidth}px` }
      : undefined
    : isExiting
      ? {
          opacity: 0,
          transform: 'scale(0.98)',
          transition: 'opacity 200ms ease-out, transform 200ms ease-out',
          pointerEvents: 'none'
        }
      : undefined

  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === 'overdue' && !isCompleted
  const { type: statusType, color: statusColor } = resolveStatus(task, project.statuses)

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
    return task.dueTime ? `${date}, ${formatTime(task.dueTime, clockFormat)}` : date
  })()

  const dueDateDisplay = (() => {
    if (isCompleted) return { text: 'Done', colorStyle: statusColor }
    if (!compactDateLabel) return null
    if (isOverdue) return { text: compactDateLabel, colorClass: 'text-destructive' }
    return { text: compactDateLabel, colorClass: 'text-text-tertiary' }
  })()

  return (
    <div
      ref={rowRef}
      style={style}
      role={isOverlay ? undefined : 'button'}
      tabIndex={isOverlay ? undefined : onClick ? 0 : -1}
      onClick={isOverlay ? undefined : handleRowClick}
      onKeyDown={isOverlay ? undefined : onClick ? handleRowKeyDown : undefined}
      {...(isOverlay ? {} : dragHandleAttributes)}
      {...(isOverlay ? {} : dragHandleListeners)}
      className={cn(
        isOverlay
          ? [
              'flex w-full items-center gap-2 rounded-md bg-card px-3 py-[7px]',
              'border-[1.5px] border-[#4C9EFF] cursor-grabbing select-none',
              '[box-shadow:rgba(0,0,0,0.5)_0px_8px_24px,rgba(76,158,255,0.15)_0px_2px_8px]'
            ]
          : [
              'group relative flex items-center py-[7px] px-3 gap-3 transition-colors',
              'rounded-md hover:bg-accent/60',
              onClick && 'focus-visible:outline-none',
              dragHandleListeners && !isDragging && 'cursor-grab',
              isDragging &&
                'cursor-grabbing opacity-[0.35] border-dashed border-primary/30 bg-primary/[0.03]',
              !isDragging && !dragHandleListeners && onClick && 'cursor-pointer',
              isCheckedForSelection && 'bg-primary/10 hover:bg-primary/15',
              isSelected &&
                !isCheckedForSelection &&
                'bg-primary/[0.08] ring-inset ring-primary/30',
              isExiting && 'select-none',
              sectionDragState === 'source-dimmed' && 'opacity-50',
              sectionDragState === 'target-highlighted' && 'bg-primary/[0.04]',
              insertionIndicatorPosition === 'before' && 'pt-1',
              insertionIndicatorPosition === 'after' && 'pb-1',
              !isDragging && isJustDropped && 'animate-row-drop-flash'
            ],
        className
      )}
      data-section-drag-state={sectionDragState}
      data-overlay-row-variant={isOverlay ? 'task' : undefined}
      data-testid={dataTestId}
      aria-hidden={isOverlay ? true : undefined}
      aria-label={isOverlay ? undefined : `Task: ${task.title}${isCompleted ? ', completed' : ''}`}
    >
      {!isOverlay && insertionIndicatorPosition && (
        <InsertionIndicator
          position={insertionIndicatorPosition}
          className="left-3 right-3"
          dataTestId="list-drop-indicator"
        />
      )}

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

      {isOverlay ? (
        <StatusIcon type={isCompleted ? 'done' : statusType} color={statusColor} size="lg" />
      ) : (
        <InlineStatusPopover
          statusId={task.statusId}
          statuses={project.statuses}
          isCompleted={isCompleted}
          onStatusChange={(statusId) => onUpdateTask?.(task.id, { statusId })}
          onToggleComplete={() => {
            setIsExiting(true)
            setTimeout(() => onToggleComplete(task.id), EXIT_ANIMATION_DURATION)
          }}
          disabled={isDragging}
        />
      )}

      {isOverlay ? (
        <PriorityBars priority={task.priority} />
      ) : (
        <InlinePriorityPopover
          priority={task.priority}
          onPriorityChange={(priority) => onUpdateTask?.(task.id, { priority })}
          disabled={isDragging}
        />
      )}

      <span
        className={cn(
          'text-[13px] font-medium grow shrink min-w-0 truncate',
          isExiting || isCompleted
            ? isOverlay
              ? 'text-muted-foreground/60 line-through decoration-1 [text-underline-position:from-font]'
              : 'text-muted-foreground/60 line-through decoration-1 [text-underline-position:from-font]'
            : isOverlay
              ? 'text-foreground/90'
              : 'text-foreground/90'
        )}
      >
        {task.title}
      </span>

      {task.isRepeating && task.repeatConfig && (
        <RepeatIndicator config={task.repeatConfig} size="sm" showTooltip={!isOverlay} />
      )}

      {showProjectBadge && (
        <div className="flex items-center shrink-0 gap-[5px]">
          <div className="rounded-xs shrink-0 size-2" style={{ backgroundColor: project.color }} />
          <div
            className={cn('text-[11px] leading-3.5 truncate max-w-[100px]', 'text-text-tertiary')}
          >
            {project.name}
          </div>
        </div>
      )}

      {dueDateDisplay && (
        <div
          className={cn(
            'text-[11px] shrink-0 text-right leading-3.5 whitespace-nowrap',
            'colorClass' in dueDateDisplay
              ? dueDateDisplay.colorClass
              : isOverlay
                ? 'text-text-tertiary'
                : null
          )}
          style={'colorStyle' in dueDateDisplay ? { color: dueDateDisplay.colorStyle } : undefined}
        >
          {dueDateDisplay.text}
        </div>
      )}

      {!isOverlay && droppedPriority && (
        <div className="flex items-center shrink-0 gap-1 px-2 py-0.5 bg-primary/10 rounded text-[10px] font-medium text-primary animate-fade-out">
          priority: {PRIORITY_LABELS[droppedPriority] ?? droppedPriority}
        </div>
      )}
    </div>
  )
}

export const TaskRow = memo(TaskRowComponent, arePropsEqual)

export default TaskRow
export type { TaskRowProps }
