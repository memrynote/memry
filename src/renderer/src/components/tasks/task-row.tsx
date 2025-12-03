import { cn } from "@/lib/utils"
import { formatDueDate } from "@/lib/task-utils"
import {
  TaskCheckbox,
  ProjectBadge,
  PriorityBadge,
  DueDateBadge,
} from "@/components/tasks/task-badges"
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
}: TaskRowProps): React.JSX.Element => {
  // Check if overdue
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === "overdue"

  const handleRowClick = (): void => {
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

  return (
    <div
      role="button"
      tabIndex={onClick ? 0 : -1}
      onClick={onClick ? handleRowClick : undefined}
      onKeyDown={onClick ? handleRowKeyDown : undefined}
      className={cn(
        "group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors duration-150",
        "hover:bg-accent/50",
        onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isOverdue && !isCompleted && "border-l-2 border-l-destructive",
        isSelected && "bg-primary/10 ring-2 ring-primary/30",
        className
      )}
      aria-label={`Task: ${task.title}${isCompleted ? ", completed" : ""}`}
    >
      {/* Checkbox */}
      <TaskCheckbox
        checked={isCompleted}
        onChange={handleToggleComplete}
      />

      {/* Title */}
      <span
        className={cn(
          "flex-1 truncate text-sm",
          isCompleted
            ? "text-text-tertiary line-through"
            : "text-text-primary"
        )}
      >
        {task.title}
      </span>

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

