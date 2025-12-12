import { useState, useRef, useEffect } from "react"
import { AnimatePresence } from "framer-motion"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatDateShort, startOfDay, isBefore, isSameDay, addDays } from "@/lib/task-utils"
import { TaskCheckbox, PriorityBadge } from "@/components/tasks/task-badges"
import { SubtaskExpandedDetails } from "./subtask-expanded-details"
import { SubtaskActionsMenu } from "./subtask-actions-menu"
import type { Task, Priority } from "@/data/sample-tasks"

// ============================================================================
// TYPES
// ============================================================================

interface SubtaskDetailItemProps {
  subtask: Task
  parentId: string
  onUpdate: (subtaskId: string, updates: Partial<Task>) => void
  onToggleComplete: (subtaskId: string) => void
  onDelete: (subtaskId: string) => void
  onPromote: (subtaskId: string) => void
}

// ============================================================================
// HELPER: Format completion date
// ============================================================================

const formatCompletionDate = (date: Date): string => {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

// ============================================================================
// HELPER: Format due date with status
// ============================================================================

const formatDueDateWithStatus = (date: Date): { text: string; isOverdue: boolean } => {
  const today = startOfDay(new Date())
  const dueDate = startOfDay(date)

  if (isBefore(dueDate, today)) {
    return { text: `Due ${formatDateShort(date)}`, isOverdue: true }
  }
  if (isSameDay(dueDate, today)) {
    return { text: "Due Today", isOverdue: false }
  }
  if (isSameDay(dueDate, addDays(today, 1))) {
    return { text: "Due Tomorrow", isOverdue: false }
  }
  return { text: `Due ${formatDateShort(date)}`, isOverdue: false }
}

// ============================================================================
// SUBTASK DETAIL ITEM COMPONENT
// ============================================================================

export const SubtaskDetailItem = ({
  subtask,
  parentId,
  onUpdate,
  onToggleComplete,
  onDelete,
  onPromote,
}: SubtaskDetailItemProps): React.JSX.Element => {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(subtask.title)
  const inputRef = useRef<HTMLInputElement>(null)

  const isCompleted = !!subtask.completedAt

  // Sortable setup
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
      type: "subtask-detail",
      subtask,
      parentId,
    },
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || "transform 200ms ease-out",
  }

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  // Update edit title when subtask changes
  useEffect(() => {
    setEditTitle(subtask.title)
  }, [subtask.title])

  const handleToggleComplete = (): void => {
    onToggleComplete(subtask.id)
  }

  const handleToggleExpand = (): void => {
    if (!isCompleted) {
      setIsExpanded(!isExpanded)
    }
  }

  const handleStartEditing = (): void => {
    setIsEditing(true)
  }

  const handleFinishEditing = (): void => {
    const trimmedTitle = editTitle.trim()
    if (trimmedTitle && trimmedTitle !== subtask.title) {
      onUpdate(subtask.id, { title: trimmedTitle })
    } else {
      setEditTitle(subtask.title)
    }
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleFinishEditing()
    }
    if (e.key === "Escape") {
      e.preventDefault()
      setEditTitle(subtask.title)
      setIsEditing(false)
    }
  }

  const handleUpdateFromExpanded = (updates: Partial<Task>): void => {
    onUpdate(subtask.id, updates)
  }

  const handleDelete = (): void => {
    onDelete(subtask.id)
  }

  const handlePromote = (): void => {
    onPromote(subtask.id)
  }

  const handleSetPriority = (priority: Priority): void => {
    onUpdate(subtask.id, { priority })
  }

  const handleSetDueDate = (dueDate: Date | null): void => {
    onUpdate(subtask.id, { dueDate })
  }

  // Build metadata display
  const renderMetadata = (): React.JSX.Element | null => {
    if (isCompleted && subtask.completedAt) {
      return (
        <span className="text-green-600 dark:text-green-500">
          ✓ Completed {formatCompletionDate(subtask.completedAt)}
        </span>
      )
    }

    const parts: React.JSX.Element[] = []

    if (subtask.priority !== "none") {
      parts.push(
        <PriorityBadge key="priority" priority={subtask.priority} size="sm" />
      )
    }

    if (subtask.dueDate) {
      const { text, isOverdue } = formatDueDateWithStatus(subtask.dueDate)
      parts.push(
        <span
          key="due"
          className={cn(isOverdue && "text-destructive")}
        >
          {text}
        </span>
      )
    }

    if (parts.length === 0) return null

    return (
      <div className="flex items-center gap-2">
        {parts.map((part, index) => (
          <span key={index} className="flex items-center">
            {index > 0 && <span className="mx-1.5 text-muted-foreground/50">·</span>}
            {part}
          </span>
        ))}
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group rounded-lg border transition-colors",
        isCompleted
          ? "bg-muted/50 border-border"
          : "bg-background border-border hover:border-muted-foreground/30",
        isDragging && "opacity-50 shadow-lg ring-2 ring-primary z-10"
      )}
    >
      {/* Main row */}
      <div
        className={cn(
          "flex items-start gap-3 p-3",
          !isCompleted && "cursor-pointer"
        )}
        onClick={handleToggleExpand}
      >
        {/* Drag Handle */}
        <button
          type="button"
          data-drag-handle
          {...attributes}
          {...listeners}
          className={cn(
            "shrink-0 cursor-grab touch-none p-0.5 text-muted-foreground/40 mt-0.5",
            "hover:text-muted-foreground active:cursor-grabbing",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded",
            "opacity-0 group-hover:opacity-100 transition-opacity",
            isDragging && "cursor-grabbing opacity-100"
          )}
          aria-label="Drag to reorder subtask"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="size-4" />
        </button>

        {/* Checkbox */}
        <div onClick={(e) => e.stopPropagation()}>
          <TaskCheckbox
            checked={isCompleted}
            onChange={handleToggleComplete}
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={handleFinishEditing}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "w-full font-medium text-sm bg-transparent outline-none",
                "border-b border-ring pb-0.5"
              )}
            />
          ) : (
            <span
              className={cn(
                "font-medium text-sm block",
                isCompleted && "line-through text-muted-foreground"
              )}
              onDoubleClick={(e) => {
                e.stopPropagation()
                handleStartEditing()
              }}
            >
              {subtask.title}
            </span>
          )}

          {/* Metadata row */}
          <div className="mt-1 text-xs text-muted-foreground">
            {renderMetadata()}
          </div>
        </div>

        {/* Expand indicator (only for incomplete tasks) */}
        {!isCompleted && (
          <ChevronDown
            className={cn(
              "size-4 text-muted-foreground/50 shrink-0 transition-transform mt-0.5",
              isExpanded && "rotate-180"
            )}
          />
        )}

        {/* Actions menu */}
        <div onClick={(e) => e.stopPropagation()}>
          <SubtaskActionsMenu
            subtask={subtask}
            onEdit={handleStartEditing}
            onDelete={handleDelete}
            onPromote={handlePromote}
            onSetPriority={handleSetPriority}
            onSetDueDate={handleSetDueDate}
          />
        </div>
      </div>

      {/* Expanded details */}
      <AnimatePresence>
        {isExpanded && !isCompleted && (
          <SubtaskExpandedDetails
            subtask={subtask}
            onUpdate={handleUpdateFromExpanded}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

export default SubtaskDetailItem








