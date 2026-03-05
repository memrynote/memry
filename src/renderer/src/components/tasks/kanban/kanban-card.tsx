import { useRef, useEffect, useMemo } from 'react'
import {
  useSortable,
  defaultAnimateLayoutChanges,
  type AnimateLayoutChanges
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, Repeat } from 'lucide-react'

import { cn } from '@/lib/utils'
import { PriorityBadge, DueDateBadge } from '@/components/tasks/task-badges'
import { SelectionCheckbox } from '@/components/tasks/bulk-actions'
import { SubtaskBadge } from '@/components/tasks/subtask-badge'
import { KanbanSubtaskPreview } from './kanban-subtask-preview'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { getSubtasks, calculateProgress } from '@/lib/subtask-utils'
import type { Task } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface KanbanCardProps {
  task: Task
  columnId: string
  allTasks?: Task[]
  isSelected?: boolean
  isFocused?: boolean
  isCompleted?: boolean
  isOverdue?: boolean
  onClick?: () => void
  onDoubleClick?: () => void
  // Selection props
  isSelectionMode?: boolean
  isCheckedForSelection?: boolean
  onToggleSelect?: (taskId: string) => void
}

// ============================================================================
// ANIMATION CONFIG
// ============================================================================

// Custom animation config that always animates layout changes
const animateLayoutChanges: AnimateLayoutChanges = (args) => {
  const { isSorting, wasDragging } = args

  if (isSorting || wasDragging) {
    return defaultAnimateLayoutChanges(args)
  }

  return true
}

// ============================================================================
// KANBAN CARD COMPONENT
// ============================================================================

export const KanbanCard = ({
  task,
  columnId,
  allTasks = [],
  isSelected = false,
  isFocused = false,
  isCompleted = false,
  isOverdue = false,
  onClick,
  onDoubleClick,
  // Selection props
  isSelectionMode = false,
  isCheckedForSelection = false,
  onToggleSelect
}: KanbanCardProps): React.JSX.Element => {
  const cardRef = useRef<HTMLDivElement>(null)

  // Calculate subtasks and progress
  const subtasks = useMemo(() => {
    if (allTasks.length === 0) return []
    return getSubtasks(task.id, allTasks)
  }, [task.id, allTasks])

  const subtaskProgress = useMemo(() => {
    return calculateProgress(subtasks)
  }, [subtasks])

  const hasSubtasks = subtasks.length > 0

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: {
      type: 'task',
      task,
      columnId,
      sourceType: 'kanban'
    },
    animateLayoutChanges
  })

  // Scroll into view when focused via keyboard navigation
  useEffect(() => {
    if (isFocused && cardRef.current) {
      cardRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      })
    }
  }, [isFocused])

  // Combine refs (sortable ref + our scroll ref)
  const setRefs = (node: HTMLDivElement | null): void => {
    setNodeRef(node)
    ;(cardRef as React.MutableRefObject<HTMLDivElement | null>).current = node
  }

  // Custom transition for smooth 200ms ease-out animation
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 200ms ease-out',
    // When dragging, make room for the dragged card
    opacity: isDragging ? 0.5 : 1
  }

  const hasPriority = task.priority !== 'none'
  const hasDueDate = !!task.dueDate
  const hasMetadata = hasPriority || hasDueDate || task.isRepeating

  const handleClick = (e: React.MouseEvent): void => {
    // Cmd/Ctrl+click toggles selection
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      e.preventDefault()
      e.stopPropagation()
      onToggleSelect(task.id)
      return
    }

    // In selection mode, clicking toggles selection
    if (isSelectionMode && onToggleSelect) {
      onToggleSelect(task.id)
      return
    }

    onClick?.()
  }

  const handleDoubleClick = (): void => {
    onDoubleClick?.()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // Only handle Space for click - Enter/E are handled at board level for quick edit
    if (e.key === ' ') {
      e.preventDefault()
      onClick?.()
    }
  }

  const handleSelectionCheckboxChange = (): void => {
    onToggleSelect?.(task.id)
  }

  const handleSelectionCheckboxClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
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
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      aria-label={`Task: ${task.title}`}
      aria-selected={isFocused || isSelected || isCheckedForSelection}
      className={cn(
        // Base styles
        'group rounded-lg border-2 bg-card p-3 shadow-sm transition-all duration-150',
        'cursor-grab active:cursor-grabbing',
        'focus-visible:outline-none',
        // Hover state
        'hover:shadow-md hover:border-border/80',
        // Default border
        'border-transparent',
        // Selection mode checked state
        isCheckedForSelection && 'border-primary bg-primary/5',
        // Focused state (keyboard navigation) - use border instead of ring to prevent overflow
        isFocused && !isCheckedForSelection && 'border-primary shadow-md',
        // Selected state (detail panel open)
        isSelected && !isFocused && !isCheckedForSelection && 'border-primary/50',
        // Overdue state
        isOverdue && !isCompleted && !isCheckedForSelection && 'bg-rose-50/60 dark:bg-rose-950/20',
        // Completed state
        isCompleted && 'opacity-70 bg-muted/30',
        // Dragging state - card becomes a placeholder
        isDragging && 'opacity-40 shadow-none border-dashed border-primary/50 bg-primary/5'
      )}
    >
      {/* Selection Checkbox - visible only in selection mode */}
      {onToggleSelect && isSelectionMode && (
        <div className="absolute -left-1 -top-1 z-10">
          <SelectionCheckbox
            checked={isCheckedForSelection}
            onChange={handleSelectionCheckboxChange}
            onClick={handleSelectionCheckboxClick}
            aria-label={`Select ${task.title}`}
            className="bg-background shadow-sm"
          />
        </div>
      )}

      {/* Task Title */}
      <div className="flex items-start gap-2">
        {/* Completed checkmark */}
        {isCompleted && (
          <Check
            className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400"
            aria-label="Completed"
          />
        )}

        <span
          className={cn(
            'text-sm font-medium leading-snug line-clamp-2',
            isCompleted && 'text-muted-foreground line-through'
          )}
        >
          {task.title}
        </span>
      </div>

      {/* Metadata Row */}
      {hasMetadata && !isCompleted && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* Priority */}
          {hasPriority && <PriorityBadge priority={task.priority} variant="full" size="sm" />}

          {/* Due Date */}
          {hasDueDate && (
            <DueDateBadge dueDate={task.dueDate} dueTime={task.dueTime} variant="compact" />
          )}

          {/* Repeat Icon */}
          {task.isRepeating && (
            <Repeat className="size-3 text-muted-foreground" aria-label="Repeating task" />
          )}
        </div>
      )}

      {/* Subtask Count - only if has subtasks and not completed */}
      {hasSubtasks && !isCompleted && (
        <div className="mt-2 pt-2 border-t border-border/50">
          <SubtaskBadge
            completed={subtaskProgress.completed}
            total={subtaskProgress.total}
            size="sm"
          />
        </div>
      )}
    </div>
  )

  // Wrap in HoverCard if has subtasks
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
// KANBAN CARD SKELETON (for drag overlay)
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
  isCompleted = false,
  isOverdue = false
}: KanbanCardSkeletonProps): React.JSX.Element => {
  const hasPriority = task.priority !== 'none'
  const hasDueDate = !!task.dueDate
  const hasMetadata = hasPriority || hasDueDate || task.isRepeating

  // Calculate subtasks and progress
  const subtasks = allTasks.length > 0 ? getSubtasks(task.id, allTasks) : []
  const subtaskProgress = calculateProgress(subtasks)
  const hasSubtasks = subtasks.length > 0

  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-3 shadow-xl transition-all duration-150',
        'rotate-3 scale-105',
        isOverdue && !isCompleted && 'bg-rose-50/60 dark:bg-rose-950/20',
        isCompleted && 'opacity-70 bg-muted/30'
      )}
      style={{ width: '256px' }}
    >
      {/* Task Title */}
      <div className="flex items-start gap-2">
        {isCompleted && (
          <Check
            className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400"
            aria-label="Completed"
          />
        )}

        <span
          className={cn(
            'text-sm font-medium leading-snug line-clamp-2',
            isCompleted && 'text-muted-foreground line-through'
          )}
        >
          {task.title}
        </span>
      </div>

      {/* Metadata Row */}
      {hasMetadata && !isCompleted && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {hasPriority && <PriorityBadge priority={task.priority} variant="full" size="sm" />}

          {hasDueDate && (
            <DueDateBadge dueDate={task.dueDate} dueTime={task.dueTime} variant="compact" />
          )}

          {task.isRepeating && (
            <Repeat className="size-3 text-muted-foreground" aria-label="Repeating task" />
          )}
        </div>
      )}

      {/* Subtask Count - only if has subtasks and not completed */}
      {hasSubtasks && !isCompleted && (
        <div className="mt-2 pt-2 border-t border-border/50">
          <SubtaskBadge
            completed={subtaskProgress.completed}
            total={subtaskProgress.total}
            size="sm"
          />
        </div>
      )}
    </div>
  )
}

export default KanbanCard
