import { useRef, useEffect, useState, memo } from 'react'

import { cn } from '@/lib/utils'
import { formatDueDate, formatDateShort, formatTime } from '@/lib/task-utils'
import { PriorityBars } from '@/components/tasks/task-icons'
import { InteractiveStatusIcon } from '@/components/tasks/status-icon'
import { SelectionCheckbox } from '@/components/tasks/bulk-actions'
import { RepeatIndicator } from '@/components/tasks/repeat-indicator'
import { InsertionIndicator } from './insertion-indicator'

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
  showDragHandle?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dragHandleListeners?: Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dragHandleAttributes?: Record<string, any>
  droppedPriority?: Priority | null
  insertionIndicatorPosition?: 'before' | 'after'
  isCrossSectionTarget?: boolean
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
  if (prevProps.showDragHandle !== nextProps.showDragHandle) return false
  if (prevProps.droppedPriority !== nextProps.droppedPriority) return false
  if (prevProps.insertionIndicatorPosition !== nextProps.insertionIndicatorPosition) return false
  if (prevProps.isCrossSectionTarget !== nextProps.isCrossSectionTarget) return false
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
  onUpdateTask: _onUpdateTask,
  onClick,
  className,
  isSelectionMode = false,
  isCheckedForSelection = false,
  onToggleSelect,
  onShiftSelect,
  accentClass: _accentClass,
  isDragging = false,
  isJustDropped = false,
  showDragHandle = false,
  dragHandleListeners,
  dragHandleAttributes,
  droppedPriority,
  insertionIndicatorPosition,
  isCrossSectionTarget = false
}: TaskRowProps): React.JSX.Element => {
  const rowRef = useRef<HTMLDivElement>(null)
  const [isExiting, setIsExiting] = useState(false)

  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isSelected])

  const style: React.CSSProperties | undefined = isExiting
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

  const handleToggleComplete = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!isCompleted) {
      setIsExiting(true)
      setTimeout(() => onToggleComplete(task.id), EXIT_ANIMATION_DURATION)
    } else {
      onToggleComplete(task.id)
    }
  }

  const showSelection = !!onToggleSelect

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
    <div
      ref={rowRef}
      style={style}
      role="button"
      tabIndex={onClick ? 0 : -1}
      onClick={handleRowClick}
      onKeyDown={onClick ? handleRowKeyDown : undefined}
      className={cn(
        'group relative flex items-center py-[7px] px-6 gap-3 border-b border-border transition-colors',
        'hover:bg-accent/50',
        onClick &&
          'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isCheckedForSelection && 'bg-primary/10 hover:bg-primary/15',
        isSelected && !isCheckedForSelection && 'bg-primary/10 ring-2 ring-primary/30',
        isExiting && 'select-none',
        isDragging && 'opacity-35 border-dashed border-primary/30 bg-primary/[0.03]',
        isJustDropped && 'animate-row-drop-flash',
        isCrossSectionTarget && 'bg-primary/[0.05]',
        className
      )}
      aria-label={`Task: ${task.title}${isCompleted ? ', completed' : ''}`}
    >
      {insertionIndicatorPosition && (
        <InsertionIndicator
          position={insertionIndicatorPosition}
          className="left-6 right-6"
          dataTestId="list-drop-indicator"
        />
      )}

      {isCrossSectionTarget && (
        <div
          data-testid="list-drop-indicator"
          data-drop-indicator="column"
          className="absolute inset-x-6 bottom-0 h-0.5 rounded-full bg-primary/80 pointer-events-none"
          aria-hidden="true"
        />
      )}

      {showDragHandle && (
        <div
          data-testid="drag-handle"
          className={cn(
            'shrink-0 flex items-center justify-center w-5 h-5 cursor-grab',
            'opacity-0 group-hover:opacity-100 transition-opacity duration-150',
            isDragging && 'opacity-100 cursor-grabbing'
          )}
          {...dragHandleAttributes}
          {...dragHandleListeners}
          aria-label="Drag to reorder"
        >
          <svg width="10" height="14" viewBox="0 0 10 14" fill="none" aria-hidden="true">
            <circle cx="3" cy="3" r="1.5" fill="currentColor" className="text-text-tertiary" />
            <circle cx="7" cy="3" r="1.5" fill="currentColor" className="text-text-tertiary" />
            <circle cx="3" cy="7" r="1.5" fill="currentColor" className="text-text-tertiary" />
            <circle cx="7" cy="7" r="1.5" fill="currentColor" className="text-text-tertiary" />
            <circle cx="3" cy="11" r="1.5" fill="currentColor" className="text-text-tertiary" />
            <circle cx="7" cy="11" r="1.5" fill="currentColor" className="text-text-tertiary" />
          </svg>
        </div>
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

      <InteractiveStatusIcon
        type={statusType}
        color={statusColor}
        isCompleted={isCompleted}
        onClick={handleToggleComplete}
      />

      <PriorityBars priority={task.priority} />

      <span
        className={cn(
          'text-[13px] leading-4 grow shrink basis-0 truncate',
          isExiting || isCompleted
            ? 'text-text-tertiary line-through decoration-1 [text-underline-position:from-font]'
            : 'text-text-primary'
        )}
      >
        {task.title}
      </span>

      {task.isRepeating && task.repeatConfig && (
        <RepeatIndicator config={task.repeatConfig} size="sm" />
      )}

      {showProjectBadge && (
        <div className="flex items-center shrink-0 gap-[5px]">
          <div className="rounded-xs shrink-0 size-2" style={{ backgroundColor: project.color }} />
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
          style={'colorStyle' in dueDateDisplay ? { color: dueDateDisplay.colorStyle } : undefined}
        >
          {dueDateDisplay.text}
        </div>
      )}

      {droppedPriority && (
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
