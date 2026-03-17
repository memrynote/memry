import { useRef, useEffect, useState, memo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { GripVertical } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { formatDueDate, formatDateShort, formatTime } from '@/lib/task-utils'
import { PriorityBars } from '@/components/tasks/task-icons'
import { InteractiveStatusIcon } from '@/components/tasks/status-icon'
import { SelectionCheckbox } from '@/components/tasks/bulk-actions'

import type { Task } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'

interface SortableTaskRowProps {
  task: Task
  project: Project
  projects: Project[]
  sectionId: string
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
}

const EXIT_ANIMATION_DURATION = 200

const arePropsEqual = (
  prevProps: SortableTaskRowProps,
  nextProps: SortableTaskRowProps
): boolean => {
  if (prevProps.task.id !== nextProps.task.id) return false
  if (prevProps.task.title !== nextProps.task.title) return false
  if (prevProps.task.priority !== nextProps.task.priority) return false
  if (prevProps.task.statusId !== nextProps.task.statusId) return false
  if (prevProps.task.isRepeating !== nextProps.task.isRepeating) return false
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
  if (prevProps.sectionId !== nextProps.sectionId) return false
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

const SortableTaskRowComponent = ({
  task,
  project,
  projects: _projects,
  sectionId,
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
  accentClass: _accentClass
}: SortableTaskRowProps): React.JSX.Element => {
  const rowRef = useRef<HTMLDivElement>(null)
  const [isExiting, setIsExiting] = useState(false)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', task, sectionId, sourceType: 'list' }
  })

  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isSelected])

  const setRefs = (node: HTMLDivElement | null): void => {
    setNodeRef(node)
    ;(rowRef as React.MutableRefObject<HTMLDivElement | null>).current = node
  }

  const style: React.CSSProperties = isExiting
    ? {
        opacity: 0,
        transform: 'scale(0.98)',
        transition: 'opacity 200ms ease-out, transform 200ms ease-out',
        pointerEvents: 'none'
      }
    : {
        transform: CSS.Transform.toString(transform),
        transition: transition || 'transform 200ms ease-out'
      }

  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === 'overdue' && !isCompleted
  const { type: statusType, color: statusColor } = resolveStatus(task, project.statuses)

  const handleRowClick = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('[data-drag-handle]')) return
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
      ref={setRefs}
      style={style}
      role="button"
      tabIndex={onClick ? 0 : -1}
      onClick={handleRowClick}
      onKeyDown={onClick ? handleRowKeyDown : undefined}
      className={cn(
        'group flex items-center py-[7px] px-6 gap-3 border-b border-border transition-colors',
        'hover:bg-accent/50',
        onClick &&
          'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isCheckedForSelection && 'bg-primary/10 hover:bg-primary/15',
        isSelected && !isCheckedForSelection && 'bg-primary/10 ring-2 ring-primary/30',
        isDragging && 'opacity-50 shadow-lg ring-2 ring-primary bg-background z-10',
        isExiting && 'select-none',
        className
      )}
      aria-label={`Task: ${task.title}${isCompleted ? ', completed' : ''}`}
    >
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

      <button
        type="button"
        data-drag-handle
        {...attributes}
        {...listeners}
        className={cn(
          'shrink-0 cursor-grab touch-none text-text-tertiary/50',
          'hover:text-text-tertiary active:cursor-grabbing',
          'focus-visible:outline-none',
          'opacity-0 group-hover:opacity-100 transition-opacity -ml-3 mr-[-6px]',
          'hidden md:block',
          isDragging && 'cursor-grabbing opacity-100'
        )}
        aria-label="Drag to reorder"
      >
        <GripVertical size={14} />
      </button>

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
    </div>
  )
}

export const SortableTaskRow = memo(SortableTaskRowComponent, arePropsEqual)

interface TaskRowPreviewProps {
  task: Task
  project?: Project
  isCompleted?: boolean
}

export const TaskRowPreview = ({
  task,
  project,
  isCompleted = false
}: TaskRowPreviewProps): React.JSX.Element => (
  <div
    className={cn(
      'flex items-center gap-3 rounded-sm border border-border bg-card py-[7px] px-4 shadow-xl',
      'rotate-2 scale-105'
    )}
    style={{ width: '320px' }}
  >
    <PriorityBars priority={task.priority} />
    <span
      className={cn(
        'truncate text-[13px] leading-4 flex-1 min-w-0',
        isCompleted && 'text-text-tertiary line-through'
      )}
    >
      {task.title}
    </span>
    {project && (
      <div className="flex items-center shrink-0 gap-[5px]">
        <div className="rounded-xs shrink-0 size-2" style={{ backgroundColor: project.color }} />
        <div className="text-[11px] text-text-tertiary leading-3.5">{project.name}</div>
      </div>
    )}
  </div>
)

export default SortableTaskRow
export type { SortableTaskRowProps }
