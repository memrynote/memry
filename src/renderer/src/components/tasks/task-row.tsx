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
import type { Task } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface TaskRowProps {
  task: Task
  project: Project
  isCompleted: boolean
  isSelected?: boolean
  showProjectBadge?: boolean
  onToggleComplete: (taskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
  // Selection props
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
// TASK ROW COMPONENT
// ============================================================================

export const TaskRow = ({
  task,
  project,
  isCompleted,
  isSelected = false,
  showProjectBadge = false,
  onToggleComplete,
  onClick,
  className,
  // Selection props
  isSelectionMode = false,
  isCheckedForSelection = false,
  onToggleSelect,
  onShiftSelect,
}: TaskRowProps): React.JSX.Element => {
  // Check if overdue
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === "overdue"

  const handleRowClick = (e: React.MouseEvent): void => {
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
      role="button"
      tabIndex={onClick ? 0 : -1}
      onClick={handleRowClick}
      onKeyDown={onClick ? handleRowKeyDown : undefined}
      className={cn(
        "group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors duration-150",
        "hover:bg-accent/50",
        onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isOverdue && !isCompleted && "border-l-2 border-l-destructive",
        // Selection highlight (when checked for selection)
        isCheckedForSelection && "bg-primary/10 hover:bg-primary/15",
        // Detail panel selected (not the same as selection mode)
        isSelected && !isCheckedForSelection && "bg-primary/10 ring-2 ring-primary/30",
        className
      )}
      aria-label={`Task: ${task.title}${isCompleted ? ", completed" : ""}`}
    >
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

      {/* Title with Repeat Indicator */}
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

export default TaskRow
