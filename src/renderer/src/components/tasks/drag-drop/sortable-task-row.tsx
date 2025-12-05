import { useRef, useEffect, useMemo } from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatDueDate } from "@/lib/task-utils"
import {
  TaskCheckbox,
  ProjectBadge,
  PriorityBadge,
  DueDateBadge,
} from "@/components/tasks/task-badges"
import { RepeatIndicator } from "@/components/tasks/repeat-indicator"
import { SelectionCheckbox } from "@/components/tasks/bulk-actions"
import { SubtaskProgressBar } from "@/components/tasks/subtask-progress-bar"
import { getSubtasks, calculateProgress } from "@/lib/subtask-utils"
import type { Task } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface SortableTaskRowProps {
  task: Task
  project: Project
  sectionId: string
  allTasks?: Task[]
  isCompleted: boolean
  isSelected?: boolean
  showProjectBadge?: boolean
  onToggleComplete: (taskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
  /** Whether selection mode is active */
  isSelectionMode?: boolean
  /** Whether this specific task is checked for selection */
  isCheckedForSelection?: boolean
  /** Toggle selection for this task */
  onToggleSelect?: (taskId: string) => void
  /** Handle shift+click for range selection */
  onShiftSelect?: (taskId: string) => void
}

// ============================================================================
// SORTABLE TASK ROW COMPONENT
// ============================================================================

export const SortableTaskRow = ({
  task,
  project,
  sectionId,
  allTasks = [],
  isCompleted,
  isSelected = false,
  showProjectBadge = false,
  onToggleComplete,
  onClick,
  className,
  isSelectionMode = false,
  isCheckedForSelection = false,
  onToggleSelect,
  onShiftSelect,
}: SortableTaskRowProps): React.JSX.Element => {
  const rowRef = useRef<HTMLDivElement>(null)

  // Calculate subtasks and progress
  const subtasks = useMemo(() => {
    if (allTasks.length === 0) return []
    return getSubtasks(task.id, allTasks)
  }, [task.id, allTasks])

  const subtaskProgress = useMemo(() => {
    return calculateProgress(subtasks)
  }, [subtasks])

  const hasSubtasks = subtasks.length > 0

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
      sectionId,
      sourceType: "list",
    },
  })

  // Scroll into view when focused via keyboard navigation
  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      })
    }
  }, [isSelected])

  // Combine refs
  const setRefs = (node: HTMLDivElement | null): void => {
    setNodeRef(node)
      ; (rowRef as React.MutableRefObject<HTMLDivElement | null>).current = node
  }

  // Apply transform and transition styles
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || "transform 200ms ease-out",
  }

  // Check if overdue
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === "overdue"

  const handleRowClick = (e: React.MouseEvent): void => {
    // Don't trigger if clicking on drag handle
    if ((e.target as HTMLElement).closest("[data-drag-handle]")) {
      return
    }

    // Shift+click for range selection
    if (e.shiftKey && isSelectionMode && onShiftSelect) {
      e.preventDefault()
      onShiftSelect(task.id)
      return
    }

    // Cmd/Ctrl+click for toggle selection
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      e.preventDefault()
      onToggleSelect(task.id)
      return
    }

    // In selection mode, clicking toggles selection
    if (isSelectionMode && onToggleSelect) {
      onToggleSelect(task.id)
      return
    }

    // Normal click behavior
    onClick?.(task.id)
  }

  const handleRowKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" && onClick) {
      e.preventDefault()
      onClick(task.id)
    }
  }

  const handleToggleComplete = (): void => {
    onToggleComplete(task.id)
  }

  const handleSelectionCheckboxChange = (): void => {
    onToggleSelect?.(task.id)
  }

  const handleSelectionCheckboxClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  return (
    <div
      ref={setRefs}
      style={style}
      role="button"
      tabIndex={onClick ? 0 : -1}
      onClick={handleRowClick}
      onKeyDown={onClick ? handleRowKeyDown : undefined}
      className={cn(
        "group flex items-center gap-2 rounded-md px-2 py-2.5 transition-all duration-150",
        "hover:bg-accent/50",
        onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isOverdue && !isCompleted && "border-l-2 border-l-destructive",
        // Selection highlight (when checked for selection)
        isCheckedForSelection && "bg-primary/10 hover:bg-primary/15",
        // Detail panel selected (not the same as selection mode)
        isSelected && !isCheckedForSelection && "bg-primary/10 ring-2 ring-primary/30",
        // Dragging state
        isDragging && "opacity-50 shadow-lg ring-2 ring-primary bg-background z-10",
        className
      )}
      aria-label={`Task: ${task.title}${isCompleted ? ", completed" : ""}`}
    >
      {/* Drag Handle */}
      <button
        type="button"
        data-drag-handle
        {...attributes}
        {...listeners}
        className={cn(
          "shrink-0 cursor-grab touch-none p-1 text-muted-foreground/50",
          "hover:text-muted-foreground active:cursor-grabbing",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded",
          "opacity-0 group-hover:opacity-100 transition-opacity",
          isDragging && "cursor-grabbing opacity-100"
        )}
        aria-label="Drag to reorder"
      >
        <GripVertical className="size-4" />
      </button>

      {/* Selection Checkbox - visible in selection mode or on hover */}
      {onToggleSelect && (
        <div
          className={cn(
            "shrink-0 transition-opacity",
            isSelectionMode ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          )}
        >
          <SelectionCheckbox
            checked={isCheckedForSelection}
            onChange={handleSelectionCheckboxChange}
            onClick={handleSelectionCheckboxClick}
            aria-label={`Select ${task.title}`}
          />
        </div>
      )}

      {/* Task Completion Checkbox */}
      <TaskCheckbox
        checked={isCompleted}
        onChange={handleToggleComplete}
      />

      {/* Title with Repeat Indicator and Subtask Progress */}
      <div className="flex flex-1 items-center gap-2 min-w-0">
        <span
          className={cn(
            "truncate text-sm",
            isCompleted
              ? "text-text-tertiary line-through"
              : "text-text-primary"
          )}
        >
          {task.title}
        </span>
        {task.isRepeating && task.repeatConfig && !isCompleted && (
          <RepeatIndicator config={task.repeatConfig} size="sm" />
        )}
        {/* Subtask Progress */}
        {hasSubtasks && !isCompleted && (
          <SubtaskProgressBar progress={subtaskProgress} size="sm" className="max-w-[100px]" />
        )}
      </div>

      {/* Right side badges container */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Project Badge (conditional) */}
        {showProjectBadge && (
          <ProjectBadge project={project} />
        )}

        {/* Priority Badge (hidden when completed) */}
        {!isCompleted && (
          <PriorityBadge priority={task.priority} />
        )}

        {/* Due Date Badge */}
        <DueDateBadge
          dueDate={task.dueDate}
          dueTime={task.dueTime}
          isRepeating={task.isRepeating}
          className={cn(
            "min-w-[80px] text-right",
            isCompleted && "opacity-60"
          )}
        />
      </div>
    </div>
  )
}

// ============================================================================
// DRAG PREVIEW (for overlay)
// ============================================================================

interface TaskRowPreviewProps {
  task: Task
  project?: Project
  isCompleted?: boolean
}

export const TaskRowPreview = ({
  task,
  project,
  isCompleted = false,
}: TaskRowPreviewProps): React.JSX.Element => {
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === "overdue" && !isCompleted

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-3 shadow-xl",
        "rotate-2 scale-105",
        isOverdue && "border-l-2 border-l-destructive"
      )}
      style={{ width: "320px" }}
    >
      <TaskCheckbox checked={isCompleted} onChange={() => { }} />

      <div className="flex flex-1 items-center gap-2 min-w-0">
        <span
          className={cn(
            "truncate text-sm font-medium",
            isCompleted && "text-muted-foreground line-through"
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



