import { useRef, useEffect, useMemo } from 'react'
import {
  useSortable,
  defaultAnimateLayoutChanges,
  type AnimateLayoutChanges
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { cn } from '@/lib/utils'
import { SelectionCheckbox } from '@/components/tasks/bulk-actions'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { KanbanSubtaskPreview } from './kanban-subtask-preview'
import { getSubtasks, calculateProgress } from '@/lib/subtask-utils'
import { getDaysOverdue, formatDueDate } from '@/lib/task-utils'
import { priorityConfig, type Task, type Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface KanbanCardProps {
  task: Task
  columnId: string
  allTasks?: Task[]
  project?: Project | null
  showProject?: boolean
  isSelected?: boolean
  isFocused?: boolean
  isCompleted?: boolean
  isOverdue?: boolean
  onClick?: () => void
  onDoubleClick?: () => void
  isSelectionMode?: boolean
  isCheckedForSelection?: boolean
  onToggleSelect?: (taskId: string) => void
}

// ============================================================================
// ANIMATION CONFIG
// ============================================================================

const animateLayoutChanges: AnimateLayoutChanges = (args) => {
  const { isSorting, wasDragging } = args
  if (isSorting || wasDragging) {
    return defaultAnimateLayoutChanges(args)
  }
  return true
}

// ============================================================================
// HELPERS
// ============================================================================

const getStripColor = (priority: Priority, isCompleted: boolean): string => {
  if (isCompleted) return 'var(--task-complete)'
  return priorityConfig[priority]?.color || '#6B7280'
}

const formatCompletedAgo = (date: Date): string => {
  const days = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 14) return '1w ago'
  return `${Math.floor(days / 7)}w ago`
}

// ============================================================================
// KANBAN CARD
// ============================================================================

export const KanbanCard = ({
  task,
  columnId,
  allTasks = [],
  project,
  showProject = false,
  isSelected = false,
  isFocused = false,
  isCompleted = false,
  isOverdue = false,
  onClick,
  onDoubleClick,
  isSelectionMode = false,
  isCheckedForSelection = false,
  onToggleSelect
}: KanbanCardProps): React.JSX.Element => {
  const cardRef = useRef<HTMLDivElement>(null)

  const subtasks = useMemo(() => {
    if (allTasks.length === 0) return []
    return getSubtasks(task.id, allTasks)
  }, [task.id, allTasks])

  const subtaskProgress = useMemo(() => calculateProgress(subtasks), [subtasks])
  const hasSubtasks = subtasks.length > 0

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', task, columnId, sourceType: 'kanban' },
    animateLayoutChanges
  })

  useEffect(() => {
    if (isFocused && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    }
  }, [isFocused])

  const setRefs = (node: HTMLDivElement | null): void => {
    setNodeRef(node)
    ;(cardRef as React.MutableRefObject<HTMLDivElement | null>).current = node
  }

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 200ms ease-out',
    opacity: isDragging ? 0.5 : 1
  }

  const hasPriority = task.priority !== 'none'
  const stripColor = getStripColor(task.priority, isCompleted)
  const config = hasPriority ? priorityConfig[task.priority] : null
  const daysOverdue = isOverdue && task.dueDate ? getDaysOverdue(task.dueDate) : 0
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const hasLinkedNotes = task.linkedNoteIds.length > 0
  const hasMetadata =
    hasPriority || isOverdue || !!formattedDate || (showProject && !!project) || hasLinkedNotes

  const handleClick = (e: React.MouseEvent): void => {
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      e.preventDefault()
      e.stopPropagation()
      onToggleSelect(task.id)
      return
    }
    if (isSelectionMode && onToggleSelect) {
      onToggleSelect(task.id)
      return
    }
    onClick?.()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === ' ') {
      e.preventDefault()
      onClick?.()
    }
  }

  const cardContent = (
    <div
      ref={setRefs}
      style={style}
      {...attributes}
      {...listeners}
      role="option"
      tabIndex={isFocused ? 0 : -1}
      onClick={handleClick}
      onDoubleClick={() => onDoubleClick?.()}
      onKeyDown={handleKeyDown}
      aria-label={`Task: ${task.title}`}
      aria-selected={isFocused || isSelected || isCheckedForSelection}
      className={cn(
        'group relative flex overflow-clip rounded-lg transition-all duration-150',
        'cursor-grab active:cursor-grabbing focus-visible:outline-none',
        !isCompleted && 'bg-card border border-border',
        isCompleted && 'bg-muted/40 border border-border/50',
        'hover:border-border hover:shadow-[var(--shadow-card)]',
        isFocused && !isCheckedForSelection && 'ring-2 ring-primary/40 border-primary/40',
        isSelected && !isFocused && !isCheckedForSelection && 'border-primary/30',
        isCheckedForSelection && 'ring-2 ring-primary border-primary bg-primary/5',
        isDragging && 'opacity-40 shadow-none border-dashed border-primary/50 bg-primary/5'
      )}
    >
      {/* Selection Checkbox */}
      {onToggleSelect && isSelectionMode && (
        <div className="absolute -left-1 -top-1 z-10">
          <SelectionCheckbox
            checked={isCheckedForSelection}
            onChange={() => onToggleSelect(task.id)}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            aria-label={`Select ${task.title}`}
            className="bg-background shadow-sm"
          />
        </div>
      )}

      {/* Priority strip */}
      <div
        className={cn('w-[3px] shrink-0', isCompleted && 'opacity-40')}
        style={{ backgroundColor: stripColor }}
      />

      {/* Card body */}
      <div className="flex flex-1 flex-col gap-2.5 py-3 px-3.5 min-w-0">
        {isCompleted ? (
          <div className="flex items-center gap-2">
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              className="shrink-0"
              aria-label="Completed"
            >
              <circle
                cx="7"
                cy="7"
                r="5.5"
                fill="var(--task-complete-bg)"
                stroke="var(--task-complete)"
                strokeWidth="1.2"
              />
              <path
                d="M4.5 7l2 2 3.5-3.5"
                stroke="var(--task-complete)"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[13px] leading-[18px] text-muted-foreground line-clamp-2">
              {task.title}
            </span>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2">
            <span className="text-[13px] leading-[18px] font-medium text-foreground line-clamp-2 flex-1 min-w-0">
              {task.title}
            </span>
            {hasSubtasks && (
              <div className="flex items-center shrink-0 gap-[3px]">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  className="text-muted-foreground"
                >
                  <rect
                    x="1.5"
                    y="1.5"
                    width="9"
                    height="9"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                  <path
                    d="M4 6l1.5 1.5L8 5"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="text-[11px] text-muted-foreground leading-3.5">
                  {subtaskProgress.completed}/{subtaskProgress.total}
                </span>
              </div>
            )}
            {task.isRepeating && !hasSubtasks && (
              <svg
                width="13"
                height="13"
                viewBox="0 0 13 13"
                fill="none"
                className="shrink-0 mt-0.5 text-muted-foreground"
                aria-label="Repeating task"
              >
                <path
                  d="M1.5 6.5a5 5 0 0 1 8.5-3.5M11.5 6.5a5 5 0 0 1-8.5 3.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
                <path
                  d="M10 1v2.5h-2.5M3 12v-2.5h2.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        )}

        {/* Active card metadata */}
        {!isCompleted && hasMetadata && (
          <div className="flex items-center flex-wrap gap-1.5">
            {hasPriority && config?.color && (
              <div
                className="flex items-center rounded-sm py-0.5 px-[7px] gap-[3px]"
                style={{ backgroundColor: `${config.color}1F` }}
              >
                <div
                  className="w-[5px] h-[5px] rounded-full shrink-0"
                  style={{ backgroundColor: config.color }}
                />
                <span
                  className="text-[11px] font-medium leading-3.5"
                  style={{ color: config.color }}
                >
                  {config.label}
                </span>
              </div>
            )}

            {isOverdue && daysOverdue > 0 && (
              <div className="flex items-center rounded-sm py-0.5 px-[7px] gap-[3px] bg-task-due-overdue/[0.08]">
                <span className="text-[11px] text-task-due-overdue leading-3.5">
                  Overdue {daysOverdue}d
                </span>
              </div>
            )}

            {!isOverdue && formattedDate && (
              <span className="text-[11px] text-text-tertiary leading-3.5">
                {formattedDate.label}
              </span>
            )}

            {showProject && project && (
              <div className="flex items-center gap-1">
                <div
                  className="w-[5px] h-[5px] rounded-full shrink-0"
                  style={{ backgroundColor: project.color }}
                />
                <span className="text-[11px] text-text-tertiary leading-3.5">{project.name}</span>
              </div>
            )}

            {hasLinkedNotes && (
              <>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  className="text-text-tertiary/50"
                >
                  <path
                    d="M4 2v2.5a1.5 1.5 0 0 0 1.5 1.5h1a1.5 1.5 0 0 1 1.5 1.5V10"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                  <circle cx="4" cy="2" r="1" fill="currentColor" />
                  <circle cx="8" cy="10" r="1" fill="currentColor" />
                </svg>
                <span className="text-[11px] text-text-tertiary/50 leading-3.5">
                  {task.linkedNoteIds.length} note{task.linkedNoteIds.length !== 1 ? 's' : ''}
                </span>
              </>
            )}
          </div>
        )}

        {/* Done card metadata */}
        {isCompleted && (
          <div className="flex items-center gap-1.5">
            {showProject && project && (
              <div className="flex items-center gap-1">
                <div
                  className="w-[5px] h-[5px] rounded-full shrink-0 opacity-50"
                  style={{ backgroundColor: project.color }}
                />
                <span className="text-[11px] text-muted-foreground/60 leading-3.5">
                  {project.name}
                </span>
              </div>
            )}
            {task.completedAt && (
              <span className="text-[11px] text-muted-foreground/60 leading-3.5">
                {formatCompletedAgo(task.completedAt)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )

  if (hasSubtasks) {
    return (
      <HoverCard openDelay={300}>
        <HoverCardTrigger asChild>{cardContent}</HoverCardTrigger>
        <HoverCardContent side="right" className="w-72">
          <KanbanSubtaskPreview parentTitle={task.title} subtasks={subtasks} />
        </HoverCardContent>
      </HoverCard>
    )
  }

  return cardContent
}

// ============================================================================
// SKELETON (drag overlay)
// ============================================================================

interface KanbanCardSkeletonProps {
  task: Task
  allTasks?: Task[]
  isCompleted?: boolean
  isOverdue?: boolean
}

export const KanbanCardSkeleton = ({
  task,
  allTasks = [],
  isCompleted = false
}: KanbanCardSkeletonProps): React.JSX.Element => {
  const hasPriority = task.priority !== 'none'
  const stripColor = getStripColor(task.priority, isCompleted)
  const config = hasPriority ? priorityConfig[task.priority] : null
  const subtasks = allTasks.length > 0 ? getSubtasks(task.id, allTasks) : []
  const subtaskProgress = calculateProgress(subtasks)
  const hasSubtasks = subtasks.length > 0

  return (
    <div
      className={cn(
        'flex overflow-clip rounded-lg shadow-xl rotate-3 scale-105',
        !isCompleted ? 'bg-card border border-border' : 'bg-muted/40 border border-border/50'
      )}
      style={{ width: '256px' }}
    >
      <div
        className={cn('w-[3px] shrink-0', isCompleted && 'opacity-40')}
        style={{ backgroundColor: stripColor }}
      />
      <div className="flex flex-1 flex-col gap-2.5 py-3 px-3.5 min-w-0">
        {isCompleted ? (
          <div className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
              <circle
                cx="7"
                cy="7"
                r="5.5"
                fill="var(--task-complete-bg)"
                stroke="var(--task-complete)"
                strokeWidth="1.2"
              />
              <path
                d="M4.5 7l2 2 3.5-3.5"
                stroke="var(--task-complete)"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[13px] leading-[18px] text-muted-foreground line-clamp-2">
              {task.title}
            </span>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2">
            <span className="text-[13px] leading-[18px] font-medium text-foreground line-clamp-2 flex-1">
              {task.title}
            </span>
            {hasSubtasks && (
              <div className="flex items-center shrink-0 gap-[3px]">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  className="text-muted-foreground"
                >
                  <rect
                    x="1.5"
                    y="1.5"
                    width="9"
                    height="9"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                  <path
                    d="M4 6l1.5 1.5L8 5"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="text-[11px] text-muted-foreground leading-3.5">
                  {subtaskProgress.completed}/{subtaskProgress.total}
                </span>
              </div>
            )}
          </div>
        )}
        {hasPriority && !isCompleted && config?.color && (
          <div className="flex items-center gap-1.5">
            <div
              className="flex items-center rounded-sm py-0.5 px-[7px] gap-[3px]"
              style={{ backgroundColor: `${config.color}1F` }}
            >
              <div
                className="w-[5px] h-[5px] rounded-full shrink-0"
                style={{ backgroundColor: config.color }}
              />
              <span className="text-[11px] font-medium leading-3.5" style={{ color: config.color }}>
                {config.label}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default KanbanCard
