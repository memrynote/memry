import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { useDroppable } from "@dnd-kit/core"

import { cn } from "@/lib/utils"
import { SortableTaskRow } from "@/components/tasks/drag-drop"
import { isTaskCompleted, startOfDay, addDays } from "@/lib/task-utils"
import type { Task } from "@/data/sample-tasks"
import type { Project, Status } from "@/data/tasks-data"

// ============================================================================
// HELPER: Get date from label
// ============================================================================

/**
 * Convert a due date group label to an actual Date
 * Returns null for "No Due Date" or unknown labels
 */
const getDateFromLabel = (label: string): Date | null => {
  const normalizedLabel = label.toLowerCase()
  const today = startOfDay(new Date())

  switch (normalizedLabel) {
    case "overdue":
      // For overdue, we'll use yesterday as the target (or keep original)
      return addDays(today, -1)
    case "today":
      return today
    case "tomorrow":
      return addDays(today, 1)
    case "upcoming":
      // Upcoming typically means within the next week, use 2 days from now
      return addDays(today, 2)
    case "later":
      // Later means more than a week out, use next week
      return addDays(today, 7)
    case "no due date":
    case "noduedate":
      return null
    default:
      return null
  }
}

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
  /** Optional explicit date for this group (used for reschedule on drop) */
  date?: Date | null
  // Selection props
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
}

interface StatusTaskGroupProps {
  status: Status
  tasks: Task[]
  project: Project
  selectedTaskId?: string | null
  onToggleComplete: (taskId: string) => void
  onTaskClick?: (taskId: string) => void
  className?: string
  // Selection props
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
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
  date,
  // Selection props
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
}: TaskGroupProps): React.JSX.Element | null => {
  // Create a unique section ID based on label
  const sectionId = `group-${label.toLowerCase().replace(/\s+/g, "-")}`

  // Determine the target date for this section
  // Use explicit date prop if provided, otherwise derive from label
  const targetDate = date !== undefined ? date : getDateFromLabel(label)

  // Set up droppable for section-level drops
  const { setNodeRef, isOver } = useDroppable({
    id: sectionId,
    data: {
      type: "section",
      sectionId,
      label,
      date: targetDate,
    },
  })

  // Get task IDs for SortableContext
  const taskIds = tasks.map((t) => t.id)

  // Don't render if no tasks
  if (tasks.length === 0) return null

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "mb-4 rounded-lg transition-colors",
        isOver && "bg-primary/5 ring-2 ring-primary/30",
        className
      )}
      aria-labelledby={sectionId}
    >
      <TaskGroupHeader
        label={label}
        count={tasks.length}
        accentColor={accentColor}
        isMuted={isMuted}
      />
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col">
          {tasks.map((task) => {
            const project = projects.find((p) => p.id === task.projectId)
            if (!project) return null

            const completed = isTaskCompleted(task, projects)
            const isCheckedForSelection = selectedIds?.has(task.id) ?? false

            return (
              <SortableTaskRow
                key={task.id}
                task={task}
                project={project}
                sectionId={sectionId}
                isCompleted={completed}
                isSelected={selectedTaskId === task.id}
                showProjectBadge={showProjectBadge}
                onToggleComplete={onToggleComplete}
                onClick={onTaskClick}
                // Selection props
                isSelectionMode={isSelectionMode}
                isCheckedForSelection={isCheckedForSelection}
                onToggleSelect={onToggleSelect}
                onShiftSelect={onShiftSelect}
              />
            )
          })}
        </div>
      </SortableContext>
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
  // Selection props
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
}: StatusTaskGroupProps): React.JSX.Element | null => {
  // Create section ID from status
  const sectionId = `status-${status.id}`

  // Set up droppable for status changes (like Kanban columns)
  // Using type "column" so it triggers status change logic in drag handlers
  const { setNodeRef, isOver } = useDroppable({
    id: sectionId,
    data: {
      type: "column",
      columnId: status.id,
      statusId: status.id,
      status,
      project,
      label: status.name,
    },
  })

  // Get task IDs for SortableContext
  const taskIds = tasks.map((t) => t.id)

  const isDoneStatus = status.type === "done"
  const isEmpty = tasks.length === 0

  // Don't render empty groups - same as TaskGroup
  // This prevents flickering issues with empty drop targets
  if (isEmpty) return null

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "mb-4 rounded-lg",
        isOver && "bg-primary/5 ring-2 ring-primary/30",
        className
      )}
      aria-labelledby={sectionId}
    >
      <TaskGroupHeader
        label={status.name.toUpperCase()}
        count={tasks.length}
        accentColor={status.color}
        isMuted={isDoneStatus}
      />
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col">
          {tasks.map((task) => {
            const completed = status.type === "done"
            const isCheckedForSelection = selectedIds?.has(task.id) ?? false

            return (
              <SortableTaskRow
                key={task.id}
                task={task}
                project={project}
                sectionId={sectionId}
                isCompleted={completed}
                isSelected={selectedTaskId === task.id}
                showProjectBadge={false} // Never show in project view
                onToggleComplete={onToggleComplete}
                onClick={onTaskClick}
                // Selection props
                isSelectionMode={isSelectionMode}
                isCheckedForSelection={isCheckedForSelection}
                onToggleSelect={onToggleSelect}
                onShiftSelect={onShiftSelect}
              />
            )
          })}
        </div>
      </SortableContext>
    </section>
  )
}

export default TaskGroup
