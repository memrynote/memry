import { useMemo } from "react"
import { Plus } from "lucide-react"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { useDroppable } from "@dnd-kit/core"

import { cn } from "@/lib/utils"
import { SortableTaskRow } from "@/components/tasks/drag-drop"
import { startOfDay, addDays } from "@/lib/task-utils"
import { createLookupContext, isTaskCompletedFast } from "@/lib/lookup-utils"
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
  allTasks?: Task[]
  projects: Project[]
  variant: TaskSectionVariant
  emptyMessage?: string
  showAddTask?: boolean
  selectedTaskId?: string | null
  /** Explicit date for this section (for reschedule on drop) */
  date?: Date | null
  onAddTask?: () => void
  onTaskClick?: (taskId: string) => void
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
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
  allTasks = [],
  projects,
  variant,
  emptyMessage,
  showAddTask = false,
  selectedTaskId,
  date,
  onAddTask,
  onTaskClick,
  onToggleComplete,
  onUpdateTask,
  className,
}: TaskSectionProps): React.JSX.Element => {
  // Section ID for drag-drop
  const sectionId = `section-${id}`

  // Determine target date based on variant if not explicitly provided
  const getDefaultDate = (): Date | null => {
    const today = startOfDay(new Date())
    switch (variant) {
      case "overdue":
        return addDays(today, -1) // Yesterday for overdue
      case "today":
        return today
      default:
        return null
    }
  }

  const targetDate = date !== undefined ? date : getDefaultDate()

  // Create lookup context for O(1) project/status lookups
  const lookupContext = useMemo(
    () => createLookupContext(projects),
    [projects]
  )

  // Set up droppable for section-level drops
  const { setNodeRef, isOver } = useDroppable({
    id: sectionId,
    data: {
      type: "section",
      sectionId: id,
      label: title,
      date: targetDate,
    },
  })

  // Get task IDs for SortableContext
  const taskIds = tasks.map((t) => t.id)

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

  // Use lookup context for O(1) completion checks
  const isTaskCompleted = (task: Task): boolean => {
    return isTaskCompletedFast(task, lookupContext.completionMap)
  }

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "rounded-lg border border-border overflow-hidden transition-all",
        "border-l-2",
        accentBorderColor,
        accentBgColor,
        isOver && "border-dotted border-primary/60 bg-primary/5",
        className
      )}
      aria-labelledby={sectionId}
    >
      {/* Header */}
      <TaskSectionHeader
        title={title}
        subtitle={subtitle}
        count={count}
        variant={variant}
      />

      {/* Task list */}
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div className="divide-y divide-border/50">
          {tasks.length > 0 ? (
            tasks.map((task) => {
              // Use lookup context for O(1) project lookup
              const project = lookupContext.projectMap.get(task.projectId)
              if (!project) return null

              return (
                <SortableTaskRow
                  key={task.id}
                  task={task}
                  project={project}
                  projects={projects}
                  sectionId={id}
                  allTasks={allTasks}
                  isCompleted={isTaskCompleted(task)}
                  isSelected={selectedTaskId === task.id}
                  showProjectBadge={true}
                  onToggleComplete={onToggleComplete}
                  onUpdateTask={onUpdateTask}
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
      </SortableContext>

      {/* Drop indicator message when hovering */}
      {isOver && (
        <div className="px-4 py-2 text-center text-sm text-primary font-medium bg-primary/5 border-t border-primary/20">
          Drop to move to {title}
        </div>
      )}

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
