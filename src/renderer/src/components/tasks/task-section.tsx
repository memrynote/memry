import { Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { TodayTaskRow } from "@/components/tasks/today-task-row"
import type { Task } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

type TaskSectionVariant = "overdue" | "today" | "default"

interface TaskSectionProps {
  id: string
  title: string
  subtitle?: string
  count: number
  tasks: Task[]
  projects: Project[]
  variant: TaskSectionVariant
  emptyMessage?: string
  showAddTask?: boolean
  selectedTaskId?: string | null
  onAddTask?: () => void
  onTaskClick?: (taskId: string) => void
  onToggleComplete: (taskId: string) => void
  className?: string
}

// ============================================================================
// SECTION HEADER COMPONENT
// ============================================================================

interface TaskSectionHeaderProps {
  title: string
  subtitle?: string
  count: number
  variant: TaskSectionVariant
}

const TaskSectionHeader = ({
  title,
  subtitle,
  count,
  variant,
}: TaskSectionHeaderProps): React.JSX.Element => {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "font-semibold text-sm uppercase tracking-wide",
            variant === "overdue" && "text-red-600 dark:text-red-400",
            variant === "today" && "text-amber-600 dark:text-amber-500",
            variant === "default" && "text-text-secondary"
          )}
        >
          {title}
        </span>
        {subtitle && (
          <span className="text-sm text-text-tertiary">· {subtitle}</span>
        )}
      </div>

      <span
        className={cn(
          "text-xs px-2 py-0.5 rounded-full font-medium",
          variant === "overdue" && "bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-400",
          variant === "today" && "bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-500",
          variant === "default" && "bg-muted text-text-tertiary"
        )}
      >
        {count}
      </span>
    </div>
  )
}

// ============================================================================
// TASK SECTION COMPONENT
// ============================================================================

export const TaskSection = ({
  id,
  title,
  subtitle,
  count,
  tasks,
  projects,
  variant,
  emptyMessage,
  showAddTask = false,
  selectedTaskId,
  onAddTask,
  onTaskClick,
  onToggleComplete,
  className,
}: TaskSectionProps): React.JSX.Element => {
  const accentBorderColor = {
    overdue: "border-l-red-500",
    today: "border-l-amber-500",
    default: "border-l-border",
  }[variant]

  const accentBgColor = {
    overdue: "bg-red-50/30 dark:bg-red-950/10",
    today: "bg-amber-50/30 dark:bg-amber-950/10",
    default: "bg-background",
  }[variant]

  // Get the section type for task row
  const sectionType = variant === "overdue" ? "overdue" : "today"

  return (
    <section
      className={cn(
        "rounded-lg border border-border overflow-hidden",
        "border-l-2",
        accentBorderColor,
        accentBgColor,
        className
      )}
      aria-labelledby={`section-${id}`}
    >
      {/* Header */}
      <TaskSectionHeader
        title={title}
        subtitle={subtitle}
        count={count}
        variant={variant}
      />

      {/* Task list */}
      <div className="divide-y divide-border/50">
        {tasks.length > 0 ? (
          tasks.map((task) => {
            const project = projects.find((p) => p.id === task.projectId)

            return (
              <TodayTaskRow
                key={task.id}
                task={task}
                project={project}
                section={sectionType}
                isSelected={selectedTaskId === task.id}
                onToggleComplete={onToggleComplete}
                onClick={onTaskClick}
              />
            )
          })
        ) : (
          <div className="px-4 py-8 text-center text-text-tertiary text-sm">
            {emptyMessage || "No tasks"}
            {showAddTask && onAddTask && (
              <button
                type="button"
                onClick={onAddTask}
                className={cn(
                  "block mx-auto mt-3 text-primary hover:text-primary/80",
                  "text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                )}
              >
                + Add task
              </button>
            )}
          </div>
        )}
      </div>

      {/* Add task footer (if tasks exist and showAddTask) */}
      {tasks.length > 0 && showAddTask && onAddTask && (
        <button
          type="button"
          onClick={onAddTask}
          className={cn(
            "w-full flex items-center gap-2 px-4 py-2.5 text-sm text-text-tertiary",
            "hover:bg-accent/50 hover:text-text-secondary",
            "border-t border-border/50 transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          )}
        >
          <Plus className="size-4" aria-hidden="true" />
          <span>Add task</span>
        </button>
      )}
    </section>
  )
}

export default TaskSection
