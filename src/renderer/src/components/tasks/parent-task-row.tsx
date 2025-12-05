import { cn } from "@/lib/utils"
import { formatDueDate } from "@/lib/task-utils"
import { hasSubtasks, type SubtaskProgress } from "@/lib/subtask-utils"
import {
  TaskCheckbox,
  ProjectBadge,
  PriorityBadge,
  DueDateBadge,
} from "@/components/tasks/task-badges"
import { RepeatIndicator } from "@/components/tasks/repeat-indicator"
import { CelebrationProgress } from "@/components/tasks/celebration-progress"
import { ExpandChevron } from "@/components/tasks/expand-chevron"
import { SubtaskBadge } from "@/components/tasks/subtask-badge"
import { SubtaskRow } from "@/components/tasks/subtask-row"
import type { Task } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface ParentTaskRowProps {
  task: Task
  subtasks: Task[]
  progress: SubtaskProgress
  project: Project
  isExpanded: boolean
  isCompleted: boolean
  isSelected?: boolean
  showProjectBadge?: boolean
  onToggleExpand: (taskId: string) => void
  onToggleComplete: (taskId: string) => void
  onToggleSubtaskComplete?: (subtaskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
}

// ============================================================================
// PARENT TASK ROW COMPONENT
// ============================================================================

export const ParentTaskRow = ({
  task,
  subtasks,
  progress,
  project,
  isExpanded,
  isCompleted,
  isSelected = false,
  showProjectBadge = false,
  onToggleExpand,
  onToggleComplete,
  onToggleSubtaskComplete,
  onClick,
  className,
}: ParentTaskRowProps): React.JSX.Element => {
  const taskHasSubtasks = hasSubtasks(task)

  // Check if overdue
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === "overdue" && !isCompleted

  const handleRowClick = (): void => {
    onClick?.(task.id)
  }

  const handleRowKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" && onClick) {
      e.preventDefault()
      onClick(task.id)
    }

    // Keyboard navigation for expand/collapse
    if (taskHasSubtasks) {
      if (e.key === "ArrowRight" && !isExpanded) {
        e.preventDefault()
        onToggleExpand(task.id)
      }
      if (e.key === "ArrowLeft" && isExpanded) {
        e.preventDefault()
        onToggleExpand(task.id)
      }
    }
  }

  const handleExpandToggle = (): void => {
    if (taskHasSubtasks) {
      onToggleExpand(task.id)
    }
  }

  const handleToggleComplete = (): void => {
    onToggleComplete(task.id)
  }

  return (
    <div className={cn("group", className)}>
      {/* Parent task row */}
      <div
        role="button"
        tabIndex={onClick ? 0 : -1}
        onClick={handleRowClick}
        onKeyDown={onClick ? handleRowKeyDown : undefined}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-2.5 transition-colors duration-150",
          "hover:bg-accent/50",
          onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isOverdue && "border-l-2 border-l-destructive",
          isSelected && "bg-primary/10 ring-2 ring-primary/30"
        )}
        aria-label={`Task: ${task.title}${isCompleted ? ", completed" : ""}${taskHasSubtasks ? `, ${subtasks.length} subtasks` : ""}`}
      >
        {/* Task checkbox */}
        <TaskCheckbox
          checked={isCompleted}
          onChange={handleToggleComplete}
        />

        {/* Expand/collapse chevron - after checkbox for alignment */}
        <ExpandChevron
          isExpanded={isExpanded}
          hasSubtasks={taskHasSubtasks}
          onClick={handleExpandToggle}
          size="md"
        />

        {/* Task content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "truncate text-sm",
                isCompleted && "line-through text-muted-foreground"
              )}
            >
              {task.title}
            </span>
            {task.isRepeating && task.repeatConfig && !isCompleted && (
              <RepeatIndicator config={task.repeatConfig} size="sm" />
            )}
            {/* Subtask badge - always visible when has subtasks */}
            {taskHasSubtasks && (
              <SubtaskBadge
                completed={progress.completed}
                total={progress.total}
                isExpanded={isExpanded}
                onClick={handleExpandToggle}
                size="sm"
              />
            )}
          </div>

          {/* Progress bar with celebration (only when expanded) */}
          {taskHasSubtasks && isExpanded && (
            <div className="mt-1">
              <CelebrationProgress progress={progress} size="sm" />
            </div>
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

      {/* Subtasks (when expanded) */}
      {isExpanded && taskHasSubtasks && (
        <div
          id={`subtasks-${task.id}`}
          role="group"
          aria-label={`Subtasks of ${task.title}`}
          className="ml-5 border-l border-border"
        >
          {subtasks.map((subtask, index) => (
            <SubtaskRow
              key={subtask.id}
              subtask={subtask}
              isLast={index === subtasks.length - 1}
              onToggleComplete={onToggleSubtaskComplete || onToggleComplete}
              onClick={onClick}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default ParentTaskRow
