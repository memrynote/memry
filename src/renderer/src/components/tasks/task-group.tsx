import { cn } from "@/lib/utils"
import { TaskRow } from "@/components/tasks/task-row"
import { isTaskCompleted } from "@/lib/task-utils"
import type { Task } from "@/data/sample-tasks"
import type { Project, Status } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface TaskGroupHeaderProps {
  label: string
  count: number
  accentColor?: string
  isMuted?: boolean
  className?: string
}

interface TaskGroupProps {
  label: string
  tasks: Task[]
  projects: Project[]
  accentColor?: string
  isMuted?: boolean
  showProjectBadge?: boolean
  selectedTaskId?: string | null
  onToggleComplete: (taskId: string) => void
  onTaskClick?: (taskId: string) => void
  className?: string
}

interface StatusTaskGroupProps {
  status: Status
  tasks: Task[]
  project: Project
  selectedTaskId?: string | null
  onToggleComplete: (taskId: string) => void
  onTaskClick?: (taskId: string) => void
  className?: string
}

// ============================================================================
// TASK GROUP HEADER
// ============================================================================

const TaskGroupHeader = ({
  label,
  count,
  accentColor,
  isMuted = false,
  className,
}: TaskGroupHeaderProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        "flex items-center justify-between px-3 py-2",
        className
      )}
    >
      <h3
        className={cn(
          "text-xs font-semibold uppercase tracking-wide",
          isMuted ? "text-text-tertiary" : "text-text-secondary"
        )}
        style={accentColor ? { color: accentColor } : undefined}
      >
        {label}
      </h3>
      <span className="text-xs text-text-tertiary">({count})</span>
    </div>
  )
}

// ============================================================================
// TASK GROUP (for due date grouping)
// ============================================================================

export const TaskGroup = ({
  label,
  tasks,
  projects,
  accentColor,
  isMuted = false,
  showProjectBadge = false,
  selectedTaskId,
  onToggleComplete,
  onTaskClick,
  className,
}: TaskGroupProps): React.JSX.Element | null => {
  // Don't render if no tasks
  if (tasks.length === 0) return null

  return (
    <section className={cn("mb-4", className)} aria-labelledby={`group-${label}`}>
      <TaskGroupHeader
        label={label}
        count={tasks.length}
        accentColor={accentColor}
        isMuted={isMuted}
      />
      <div className="flex flex-col">
        {tasks.map((task) => {
          const project = projects.find((p) => p.id === task.projectId)
          if (!project) return null

          const completed = isTaskCompleted(task, projects)

          return (
            <TaskRow
              key={task.id}
              task={task}
              project={project}
              isCompleted={completed}
              isSelected={selectedTaskId === task.id}
              showProjectBadge={showProjectBadge}
              onToggleComplete={onToggleComplete}
              onClick={onTaskClick}
            />
          )
        })}
      </div>
    </section>
  )
}

// ============================================================================
// STATUS TASK GROUP (for project view grouping by status)
// ============================================================================

export const StatusTaskGroup = ({
  status,
  tasks,
  project,
  selectedTaskId,
  onToggleComplete,
  onTaskClick,
  className,
}: StatusTaskGroupProps): React.JSX.Element | null => {
  // Don't render if no tasks
  if (tasks.length === 0) return null

  const isDoneStatus = status.type === "done"

  return (
    <section
      className={cn("mb-4", className)}
      aria-labelledby={`status-${status.id}`}
    >
      <TaskGroupHeader
        label={status.name.toUpperCase()}
        count={tasks.length}
        accentColor={status.color}
        isMuted={isDoneStatus}
      />
      <div className="flex flex-col">
        {tasks.map((task) => {
          const completed = status.type === "done"

          return (
            <TaskRow
              key={task.id}
              task={task}
              project={project}
              isCompleted={completed}
              isSelected={selectedTaskId === task.id}
              showProjectBadge={false} // Never show in project view
              onToggleComplete={onToggleComplete}
              onClick={onTaskClick}
            />
          )
        })}
      </div>
    </section>
  )
}

export default TaskGroup

