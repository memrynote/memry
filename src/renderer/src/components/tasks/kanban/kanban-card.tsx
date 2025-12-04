import { useRef, useEffect } from "react"
import { useSortable, defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Check, Repeat } from "lucide-react"

import { cn } from "@/lib/utils"
import { PriorityBadge, DueDateBadge } from "@/components/tasks/task-badges"
import type { Task } from "@/data/sample-tasks"

// ============================================================================
// TYPES
// ============================================================================

interface KanbanCardProps {
  task: Task
  isSelected?: boolean
  isFocused?: boolean
  isCompleted?: boolean
  isOverdue?: boolean
  onClick?: () => void
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
  isSelected = false,
  isFocused = false,
  isCompleted = false,
  isOverdue = false,
  onClick,
}: KanbanCardProps): React.JSX.Element => {
  const cardRef = useRef<HTMLDivElement>(null)

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: {
      type: "task",
      task,
    },
    animateLayoutChanges,
  })

  // Scroll into view when focused via keyboard navigation
  useEffect(() => {
    if (isFocused && cardRef.current) {
      cardRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
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
    transition: transition || "transform 200ms ease-out",
    // When dragging, make room for the dragged card
    opacity: isDragging ? 0.5 : 1,
  }

  const hasPriority = task.priority !== "none"
  const hasDueDate = !!task.dueDate
  const hasMetadata = hasPriority || hasDueDate || task.isRepeating

  const handleClick = (): void => {
    onClick?.()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      onClick?.()
    }
  }

  return (
    <div
      ref={setRefs}
      style={style}
      {...attributes}
      {...listeners}
      role="option"
      tabIndex={isFocused ? 0 : -1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={`Task: ${task.title}`}
      aria-selected={isFocused || isSelected}
      className={cn(
        // Base styles
        "group rounded-lg border-2 bg-card p-3 shadow-sm transition-all duration-150",
        "cursor-grab active:cursor-grabbing",
        "focus-visible:outline-none",
        // Hover state
        "hover:shadow-md hover:border-border/80",
        // Default border
        "border-transparent",
        // Focused state (keyboard navigation) - use border instead of ring to prevent overflow
        isFocused && "border-primary shadow-md",
        // Selected state (detail panel open)
        isSelected && !isFocused && "border-primary/50",
        // Overdue state
        isOverdue && !isCompleted && "border-l-red-500",
        // Completed state
        isCompleted && "opacity-70 bg-muted/30",
        // Dragging state - card becomes a placeholder
        isDragging && "opacity-40 shadow-none border-dashed border-primary/50 bg-primary/5"
      )}
    >
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
            "text-sm font-medium leading-snug line-clamp-2",
            isCompleted && "text-muted-foreground line-through"
          )}
        >
          {task.title}
        </span>
      </div>

      {/* Metadata Row */}
      {hasMetadata && !isCompleted && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* Priority */}
          {hasPriority && (
            <PriorityBadge
              priority={task.priority}
              variant="full"
              size="sm"
            />
          )}

          {/* Due Date */}
          {hasDueDate && (
            <DueDateBadge
              dueDate={task.dueDate}
              dueTime={task.dueTime}
              variant="compact"
            />
          )}

          {/* Repeat Icon */}
          {task.isRepeating && (
            <Repeat
              className="size-3 text-muted-foreground"
              aria-label="Repeating task"
            />
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// KANBAN CARD SKELETON (for drag overlay)
// ============================================================================

interface KanbanCardSkeletonProps {
  task: Task
  isCompleted?: boolean
  isOverdue?: boolean
}

export const KanbanCardSkeleton = ({
  task,
  isCompleted = false,
  isOverdue = false,
}: KanbanCardSkeletonProps): React.JSX.Element => {
  const hasPriority = task.priority !== "none"
  const hasDueDate = !!task.dueDate
  const hasMetadata = hasPriority || hasDueDate || task.isRepeating

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 shadow-xl transition-all duration-150",
        "rotate-3 scale-105",
        isOverdue && !isCompleted && "border-l-2 border-l-red-500",
        isCompleted && "opacity-70 bg-muted/30"
      )}
      style={{ width: "256px" }}
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
            "text-sm font-medium leading-snug line-clamp-2",
            isCompleted && "text-muted-foreground line-through"
          )}
        >
          {task.title}
        </span>
      </div>

      {/* Metadata Row */}
      {hasMetadata && !isCompleted && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {hasPriority && (
            <PriorityBadge
              priority={task.priority}
              variant="full"
              size="sm"
            />
          )}

          {hasDueDate && (
            <DueDateBadge
              dueDate={task.dueDate}
              dueTime={task.dueTime}
              variant="compact"
            />
          )}

          {task.isRepeating && (
            <Repeat
              className="size-3 text-muted-foreground"
              aria-label="Repeating task"
            />
          )}
        </div>
      )}
    </div>
  )
}

export default KanbanCard

