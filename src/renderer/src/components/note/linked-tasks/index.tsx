import { useState } from "react"
import { CheckSquare, ChevronDown, ChevronRight, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"
import type { Task } from '@/services/tasks-service'

// ============================================================================
// TYPES
// ============================================================================

interface LinkedTasksSectionProps {
  tasks: Task[]
  isLoading?: boolean
  onTaskClick?: (taskId: string) => void
  className?: string
}

// ============================================================================
// LINKED TASK ITEM
// ============================================================================

interface LinkedTaskItemProps {
  task: Task
  onClick?: () => void
}

const LinkedTaskItem = ({ task, onClick }: LinkedTaskItemProps): React.JSX.Element => {
  const isCompleted = task.completedAt !== null

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 w-full p-2 rounded-md text-left",
        "hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
        isCompleted && "opacity-60"
      )}
    >
      <CheckSquare
        className={cn(
          "size-4 flex-shrink-0",
          isCompleted ? "text-green-500" : "text-stone-400 dark:text-stone-500"
        )}
        aria-hidden="true"
      />
      <span
        className={cn("text-sm truncate", isCompleted && "line-through text-muted-foreground")}
      >
        {task.title}
      </span>
    </button>
  )
}

// ============================================================================
// LINKED TASKS SECTION COMPONENT
// ============================================================================

export const LinkedTasksSection = ({
  tasks,
  isLoading = false,
  onTaskClick,
  className,
}: LinkedTasksSectionProps): React.JSX.Element | null => {
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Show loading state
  if (isLoading) {
    return (
      <section className={cn("mt-6 pt-4 border-t border-stone-200 dark:border-stone-700", className)}>
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin text-stone-400" aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            Loading linked tasks...
          </span>
        </div>
      </section>
    )
  }

  // Don't render if no linked tasks
  if (tasks.length === 0) {
    return null
  }

  const handleToggle = (): void => {
    setIsCollapsed(!isCollapsed)
  }

  const handleTaskClick = (taskId: string) => (): void => {
    onTaskClick?.(taskId)
  }

  return (
    <section className={cn("mt-6 pt-4 border-t border-stone-200 dark:border-stone-700", className)}>
      {/* Header */}
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
        aria-expanded={!isCollapsed}
        aria-controls="linked-tasks-list"
      >
        {isCollapsed ? (
          <ChevronRight className="size-4 text-stone-400" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-4 text-stone-400" aria-hidden="true" />
        )}
        <CheckSquare className="size-4 text-blue-500" aria-hidden="true" />
        <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Linked Tasks
        </span>
        <span className="text-xs text-stone-400">({tasks.length})</span>
      </button>

      {/* Task list */}
      {!isCollapsed && (
        <div id="linked-tasks-list" className="mt-3 space-y-1">
          {tasks.map((task) => (
            <LinkedTaskItem
              key={task.id}
              task={task}
              onClick={onTaskClick ? handleTaskClick(task.id) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export default LinkedTasksSection
