import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Check, GripVertical } from "lucide-react"

import { cn } from "@/lib/utils"
import { TaskCheckbox, PriorityBadge, DueDateBadge } from "@/components/tasks/task-badges"
import type { Task } from "@/data/sample-tasks"

// ============================================================================
// TYPES
// ============================================================================

interface SortableSubtaskRowProps {
  subtask: Task
  parentId: string
  isLast: boolean
  onToggleComplete: (taskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
}

// ============================================================================
// SORTABLE SUBTASK ROW COMPONENT
// ============================================================================

export const SortableSubtaskRow = ({
  subtask,
  parentId,
  isLast,
  onToggleComplete,
  onClick,
  className,
}: SortableSubtaskRowProps): React.JSX.Element => {
  const isCompleted = !!subtask.completedAt

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: subtask.id,
    data: {
      type: "subtask",
      subtask,
      parentId,
      sourceType: "subtask-list",
    },
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || "transform 200ms ease-out",
  }

  const handleClick = (): void => {
    onClick?.(subtask.id)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" && onClick) {
      e.preventDefault()
      onClick(subtask.id)
    }
  }

  const handleToggleComplete = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onToggleComplete(subtask.id)
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="button"
      tabIndex={onClick ? 0 : -1}
      onClick={handleClick}
      onKeyDown={onClick ? handleKeyDown : undefined}
      className={cn(
        "group/subtask flex items-center gap-2 px-2 py-1.5 ml-2",
        "hover:bg-accent/50 cursor-pointer rounded-r-lg",
        "transition-all duration-150",
        onClick && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "opacity-50 shadow-lg ring-2 ring-primary bg-background z-10",
        className
      )}
      aria-label={`Subtask: ${subtask.title}${isCompleted ? ", completed" : ""}`}
    >
      {/* Drag Handle */}
      <button
        type="button"
        data-drag-handle
        {...attributes}
        {...listeners}
        className={cn(
          "shrink-0 cursor-grab touch-none p-0.5 text-muted-foreground/50",
          "hover:text-muted-foreground active:cursor-grabbing",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded",
          "opacity-0 group-hover/subtask:opacity-100 transition-opacity",
          isDragging && "cursor-grabbing opacity-100"
        )}
        aria-label="Drag to reorder subtask"
      >
        <GripVertical className="size-3.5" />
      </button>

      {/* Tree connector */}
      <span
        className="text-muted-foreground/50 text-sm font-mono w-4 select-none"
        aria-hidden="true"
      >
        {isLast ? "└─" : "├─"}
      </span>

      {/* Subtask checkbox */}
      <div onClick={handleToggleComplete}>
        <TaskCheckbox
          checked={isCompleted}
          onChange={() => onToggleComplete(subtask.id)}
        />
      </div>

      {/* Subtask title */}
      <span
        className={cn(
          "flex-1 text-sm truncate",
          isCompleted && "line-through text-muted-foreground"
        )}
      >
        {subtask.title}
      </span>

      {/* Metadata badges - aligned with parent task columns */}
      {isCompleted ? (
        <span className="text-xs text-green-600 dark:text-green-500 flex items-center gap-1 w-[180px] justify-end">
          <Check className="w-3 h-3" aria-hidden="true" />
          <span>Done</span>
        </span>
      ) : (
        <>
          {/* Desktop: badges with gap to match parent task grid */}
          <div className="hidden md:flex items-center gap-1">
            {/* Priority Badge - 70px fixed width to align with parent */}
            <PriorityBadge
              priority={subtask.priority}
              compact
              fixedWidth
              size="sm"
            />

            {/* Due Date Badge - 110px fixed width to align with parent */}
            <DueDateBadge
              dueDate={subtask.dueDate}
              dueTime={subtask.dueTime}
              isRepeating={subtask.isRepeating}
              fixedWidth
            />
          </div>

          {/* Mobile: compact inline badges */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground md:hidden">
            {subtask.priority !== "none" && (
              <PriorityBadge priority={subtask.priority} size="sm" compact />
            )}
            <DueDateBadge
              dueDate={subtask.dueDate}
              dueTime={subtask.dueTime}
              isRepeating={subtask.isRepeating}
            />
          </div>
        </>
      )}
    </div>
  )
}

export default SortableSubtaskRow
