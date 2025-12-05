import { useRef, useEffect } from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical } from "lucide-react"

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
import { SelectionCheckbox } from "@/components/tasks/bulk-actions"
import { CelebrationProgress } from "@/components/tasks/celebration-progress"
import { ExpandChevron } from "@/components/tasks/expand-chevron"
import { SubtaskBadge } from "@/components/tasks/subtask-badge"
import { SortableSubtaskList } from "@/components/tasks/sortable-subtask-list"
import type { Task } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface SortableParentTaskRowProps {
  task: Task
  project: Project
  sectionId: string
  subtasks: Task[]
  progress: SubtaskProgress
  isExpanded: boolean
  isCompleted: boolean
  isSelected?: boolean
  showProjectBadge?: boolean
  onToggleExpand: (taskId: string) => void
  onToggleComplete: (taskId: string) => void
  onToggleSubtaskComplete?: (subtaskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
  // Selection props
  isSelectionMode?: boolean
  isCheckedForSelection?: boolean
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
  // Subtask management props
  onAddSubtask?: (parentId: string, title: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
  /** Optional accent class for urgency styling (e.g., left border) */
  accentClass?: string
}

// ============================================================================
// SORTABLE PARENT TASK ROW COMPONENT
// ============================================================================

export const SortableParentTaskRow = ({
  task,
  project,
  sectionId,
  subtasks,
  progress,
  isExpanded,
  isCompleted,
  isSelected = false,
  showProjectBadge = false,
  onToggleExpand,
  onToggleComplete,
  onToggleSubtaskComplete,
  onClick,
  className,
  isSelectionMode = false,
  isCheckedForSelection = false,
  onToggleSelect,
  onShiftSelect,
  onAddSubtask,
  onReorderSubtasks,
  accentClass,
}: SortableParentTaskRowProps): React.JSX.Element => {
  const rowRef = useRef<HTMLDivElement>(null)
  const taskHasSubtasks = hasSubtasks(task)

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
  const isOverdue = formattedDate?.status === "overdue" && !isCompleted

  const handleRowClick = (e: React.MouseEvent): void => {
    // Don't trigger if clicking on drag handle or expand button
    if ((e.target as HTMLElement).closest("[data-drag-handle]")) {
      return
    }
    if ((e.target as HTMLElement).closest("[data-expand-button]")) {
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

  const handleSelectionCheckboxChange = (): void => {
    onToggleSelect?.(task.id)
  }

  const handleSelectionCheckboxClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  return (
    <div className={cn("group", className)}>
      {/* Parent task row */}
      <div
        ref={setRefs}
        style={style}
        role="button"
        tabIndex={onClick ? 0 : -1}
        onClick={handleRowClick}
        onKeyDown={onClick ? handleRowKeyDown : undefined}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-2.5 transition-all duration-150",
          "hover:bg-accent/50",
          onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          // Urgency accent class takes priority, otherwise fall back to overdue styling
          accentClass ? accentClass : (isOverdue && "border-l-2 border-l-destructive"),
          // Selection highlight (when checked for selection)
          isCheckedForSelection && "bg-primary/10 hover:bg-primary/15",
          // Detail panel selected (not the same as selection mode)
          isSelected && !isCheckedForSelection && "bg-primary/10 ring-2 ring-primary/30",
          // Dragging state
          isDragging && "opacity-50 shadow-lg ring-2 ring-primary bg-background z-10"
        )}
        aria-label={`Task: ${task.title}${isCompleted ? ", completed" : ""}${taskHasSubtasks ? `, ${subtasks.length} subtasks` : ""}`}
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

        {/* Selection Checkbox - visible only in selection mode */}
        {onToggleSelect && isSelectionMode && (
          <div className="shrink-0">
            <SelectionCheckbox
              checked={isCheckedForSelection}
              onChange={handleSelectionCheckboxChange}
              onClick={handleSelectionCheckboxClick}
              aria-label={`Select ${task.title}`}
            />
          </div>
        )}

        {/* Expand/collapse chevron */}
        <ExpandChevron
          isExpanded={isExpanded}
          hasSubtasks={taskHasSubtasks}
          onClick={handleExpandToggle}
          size="md"
        />

        {/* Task checkbox */}
        <TaskCheckbox
          checked={isCompleted}
          onChange={handleToggleComplete}
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
      {isExpanded && (
        <SortableSubtaskList
          parentId={task.id}
          parentTitle={task.title}
          subtasks={subtasks}
          onReorder={onReorderSubtasks || (() => { })}
          onToggleComplete={onToggleSubtaskComplete || onToggleComplete}
          onAddSubtask={onAddSubtask}
          onClick={onClick}
        />
      )}
    </div>
  )
}

export default SortableParentTaskRow
