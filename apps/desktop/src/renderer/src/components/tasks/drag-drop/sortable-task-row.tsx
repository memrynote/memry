import { useRef, useEffect, useState, memo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { cn } from '@/lib/utils'
import { formatDueDate, getDaysOverdue, getOverdueTier } from '@/lib/task-utils'
import { TaskCheckbox, ProjectBadge, PriorityBadge } from '@/components/tasks/task-badges'
import { RepeatIndicator } from '@/components/tasks/repeat-indicator'
import { SelectionCheckbox } from '@/components/tasks/bulk-actions'
import { priorityConfig, type Priority } from '@/data/sample-tasks'

import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

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

const getLeftBorderColor = (task: Task, isCompleted: boolean): string | undefined => {
  if (isCompleted) return undefined
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === 'overdue'
  if (isOverdue) return priorityConfig[task.priority]?.color ?? '#EF4444'
  if (task.priority === 'urgent') return '#EF4444'
  if (task.priority === 'high') return '#F97316'
  if (task.priority === 'medium') return '#F59E0B'
  return undefined
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
  onUpdateTask,
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
  const isOverdue = formattedDate?.status === 'overdue'
  const daysOver = isOverdue && !isCompleted ? getDaysOverdue(task.dueDate) : 0
  const overdueTier = daysOver > 0 ? getOverdueTier(daysOver) : null
  const leftBorderColor = getLeftBorderColor(task, isCompleted)

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

  const handleToggleComplete = (): void => {
    if (!isCompleted) {
      setIsExiting(true)
      setTimeout(() => onToggleComplete(task.id), EXIT_ANIMATION_DURATION)
    } else {
      onToggleComplete(task.id)
    }
  }

  const handlePriorityChange = (priority: Priority): void => {
    onUpdateTask?.(task.id, { priority })
  }

  const showSelection = !!onToggleSelect
  const priorityColor = priorityConfig[task.priority]?.color

  return (
    <div
      ref={setRefs}
      style={{
        ...style,
        borderLeftWidth: '3px',
        borderLeftStyle: 'solid',
        borderLeftColor: leftBorderColor || 'transparent'
      }}
      role="button"
      tabIndex={onClick ? 0 : -1}
      onClick={handleRowClick}
      onKeyDown={onClick ? handleRowKeyDown : undefined}
      className={cn(
        'group flex items-center py-2 px-3 gap-2.5 rounded-r-sm transition-colors duration-150',
        'hover:bg-accent/50',
        onClick &&
          'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isOverdue && !isCompleted && 'bg-[#EF444405]',
        overdueTier === 'severe' && 'overdue-pulse',
        isCheckedForSelection && 'bg-primary/10 hover:bg-primary/15',
        isSelected && !isCheckedForSelection && 'bg-primary/10 ring-2 ring-primary/30',
        isDragging && 'opacity-50 shadow-lg ring-2 ring-primary bg-background z-10',
        isExiting && 'select-none',
        'mt-0.5',
        className
      )}
      aria-label={`Task: ${task.title}${isCompleted ? ', completed' : ''}`}
    >
      {/* Selection checkbox (selection mode only) */}
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

      {/* Drag handle — hidden, appears on hover */}
      <button
        type="button"
        data-drag-handle
        {...attributes}
        {...listeners}
        className={cn(
          'shrink-0 cursor-grab touch-none text-text-tertiary/50',
          'hover:text-text-tertiary active:cursor-grabbing',
          'focus-visible:outline-none',
          'opacity-0 group-hover:opacity-100 transition-opacity -ml-1 mr-[-6px]',
          'hidden md:block',
          isDragging && 'cursor-grabbing opacity-100'
        )}
        aria-label="Drag to reorder"
      >
        <svg width="6" height="14" viewBox="0 0 6 14" fill="currentColor">
          <circle cx="1.5" cy="2" r="1" />
          <circle cx="4.5" cy="2" r="1" />
          <circle cx="1.5" cy="7" r="1" />
          <circle cx="4.5" cy="7" r="1" />
          <circle cx="1.5" cy="12" r="1" />
          <circle cx="4.5" cy="12" r="1" />
        </svg>
      </button>

      {/* Checkbox */}
      <div className="shrink-0">
        <TaskCheckbox
          checked={isCompleted}
          onChange={handleToggleComplete}
          disabled={isSelectionMode}
        />
      </div>

      {/* Title */}
      <span
        className={cn(
          'text-[13px] font-medium leading-4 truncate shrink-0 max-w-[50%]',
          isExiting || isCompleted
            ? 'text-text-tertiary line-through decoration-text-tertiary'
            : 'text-text-primary'
        )}
      >
        {task.title}
      </span>

      {/* Repeat indicator */}
      {task.isRepeating && task.repeatConfig && !isCompleted && (
        <RepeatIndicator config={task.repeatConfig} size="sm" />
      )}

      {/* Inline badges */}
      {!isCompleted && (
        <div className="flex items-center gap-[5px] shrink-0">
          {task.priority !== 'none' && priorityColor && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                handlePriorityChange(
                  task.priority === 'urgent'
                    ? 'none'
                    : task.priority === 'high'
                      ? 'urgent'
                      : task.priority === 'medium'
                        ? 'high'
                        : task.priority === 'low'
                          ? 'medium'
                          : 'low'
                )
              }}
              className="flex items-center rounded-sm py-px px-1.5 gap-[3px] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              style={{ backgroundColor: `${priorityColor}14` }}
              aria-label={`Priority: ${priorityConfig[task.priority]?.label}`}
            >
              <span
                className="rounded-full shrink-0 size-1"
                style={{ backgroundColor: priorityColor }}
              />
              <span className="text-[10px] font-medium leading-3" style={{ color: priorityColor }}>
                {task.priority === 'urgent'
                  ? 'Urgent'
                  : task.priority === 'high'
                    ? 'High'
                    : task.priority === 'medium'
                      ? 'Med'
                      : 'Low'}
              </span>
            </button>
          )}

          {showProjectBadge && (
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center rounded-sm py-px px-1.5 gap-[3px] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              style={{ backgroundColor: `${project.color}0F` }}
              aria-label={`Project: ${project.name}`}
            >
              <span
                className="rounded-full shrink-0 size-1"
                style={{ backgroundColor: project.color }}
              />
              <span className="text-[10px] font-medium leading-3" style={{ color: project.color }}>
                {project.name}
              </span>
            </button>
          )}
        </div>
      )}

      {/* Due date (pushed right) */}
      {formattedDate && (
        <span
          className={cn(
            'text-[10px] ml-auto shrink-0 leading-3',
            isOverdue && !isCompleted ? 'text-[#C4654A]' : 'text-text-tertiary',
            isCompleted && 'opacity-60'
          )}
        >
          {formattedDate.label}
        </span>
      )}

      {/* Subtask progress (if has subtasks) */}
      {task.subtaskIds.length > 0 && (
        <div className="flex items-center shrink-0 gap-[3px]">
          <div className="w-5 h-[3px] flex rounded-xs overflow-hidden bg-border shrink-0">
            <div
              className="h-full rounded-xs bg-[#7B9E87]"
              style={{
                width: `${Math.round((task.subtaskIds.filter(() => false).length / task.subtaskIds.length) * 100)}%`
              }}
            />
          </div>
          <span className="text-[9px] text-text-tertiary font-[family-name:var(--font-mono)] leading-3">
            0/{task.subtaskIds.length}
          </span>
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
}: TaskRowPreviewProps): React.JSX.Element => {
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === 'overdue' && !isCompleted

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-sm border bg-card p-3 shadow-xl',
        'rotate-2 scale-105',
        isOverdue && 'bg-rose-50/60 dark:bg-rose-950/20'
      )}
      style={{ width: '320px' }}
    >
      <TaskCheckbox checked={isCompleted} onChange={() => {}} />
      <div className="flex flex-1 items-center gap-2 min-w-0">
        <span
          className={cn(
            'truncate text-sm font-medium',
            isCompleted && 'text-muted-foreground line-through'
          )}
        >
          {task.title}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {project && <ProjectBadge project={project} />}
        {!isCompleted && <PriorityBadge priority={task.priority} />}
      </div>
    </div>
  )
}

export default SortableTaskRow
export type { SortableTaskRowProps }
