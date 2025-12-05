import { useMemo, useState, useCallback } from "react"
import { useDroppable } from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { KanbanCard } from "./kanban-card"
import { KanbanCardEdit } from "./kanban-card-edit"
import { KanbanEmptyColumn } from "./kanban-empty-column"
import { getIconByName } from "@/components/icon-picker"
import { startOfDay, isBefore } from "@/lib/task-utils"
import type { Task } from "@/data/sample-tasks"
import type { Status, StatusType } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

export interface KanbanColumnData {
  id: string
  title: string
  color: string
  icon?: string // For project columns
  type: "status" | "project"
  statusType?: StatusType // For status columns
}

interface KanbanColumnProps {
  column: KanbanColumnData
  tasks: Task[]
  allTasks: Task[]
  selectedTaskId: string | null
  focusedTaskId: string | null
  editingTaskId: string | null
  statuses: Status[]
  getTaskIsCompleted: (task: Task) => boolean
  onTaskClick: (taskId: string) => void
  onTaskDoubleClick: (taskId: string) => void
  onQuickAdd: (title: string, columnId: string) => void
  onEditSave: (taskId: string, updates: Partial<Task>) => void
  onEditCancel: () => void
  // Selection props
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
}

// ============================================================================
// KANBAN COLUMN COMPONENT
// ============================================================================

export const KanbanColumn = ({
  column,
  tasks,
  allTasks,
  selectedTaskId,
  focusedTaskId,
  editingTaskId,
  statuses,
  getTaskIsCompleted,
  onTaskClick,
  onTaskDoubleClick,
  onQuickAdd,
  onEditSave,
  onEditCancel,
  // Selection props
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
}: KanbanColumnProps): React.JSX.Element => {
  const [isAddingTask, setIsAddingTask] = useState(false)
  const [newTaskTitle, setNewTaskTitle] = useState("")

  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    data: {
      type: "column",
      column,
    },
  })

  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks])

  const isDoneColumn = column.statusType === "done"
  const today = startOfDay(new Date())

  // Check if a task is overdue
  const isTaskOverdue = useCallback(
    (task: Task): boolean => {
      if (!task.dueDate) return false
      const dueDate = startOfDay(task.dueDate)
      return isBefore(dueDate, today)
    },
    [today]
  )

  // Handle inline add task
  const handleAddClick = (): void => {
    setIsAddingTask(true)
  }

  const handleAddSubmit = (): void => {
    if (newTaskTitle.trim()) {
      onQuickAdd(newTaskTitle.trim(), column.id)
      setNewTaskTitle("")
    }
    setIsAddingTask(false)
  }

  const handleAddKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleAddSubmit()
    } else if (e.key === "Escape") {
      setNewTaskTitle("")
      setIsAddingTask(false)
    }
  }

  const handleAddBlur = (): void => {
    if (newTaskTitle.trim()) {
      handleAddSubmit()
    } else {
      setIsAddingTask(false)
    }
  }

  // Get icon component for project columns
  const IconComponent = column.icon ? getIconByName(column.icon) : null

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex h-full w-[280px] shrink-0 flex-col rounded-lg bg-muted/30 transition-colors",
        isOver && "bg-primary/5 ring-2 ring-primary/20"
      )}
    >
      {/* Column Header */}
      <div className="flex items-center gap-2 px-3 py-3">
        {/* Color indicator / Icon */}
        {column.type === "project" && IconComponent ? (
          <IconComponent
            className="size-4 shrink-0"
            style={{ color: column.color }}
            aria-hidden="true"
          />
        ) : (
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: column.color }}
            aria-hidden="true"
          />
        )}

        {/* Title */}
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          {column.title}
        </span>

        {/* Count */}
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {tasks.length}
        </span>
      </div>

      {/* Card List */}
      <ScrollArea className="flex-1 px-2">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {/* Container with min-height ensures drop target area */}
          <div className="flex min-h-[100px] flex-col gap-2 pb-2">
            {tasks.length === 0 ? (
              <KanbanEmptyColumn
                columnType={column.type}
                isDone={isDoneColumn}
                isDropTarget={isOver}
              />
            ) : (
              tasks.map((task) => {
                const isCompleted = getTaskIsCompleted(task)
                const isOverdue = isTaskOverdue(task) && !isCompleted
                const isEditing = editingTaskId === task.id
                const isCheckedForSelection = selectedIds?.has(task.id) ?? false

                // Render edit form if this task is being edited
                if (isEditing) {
                  return (
                    <KanbanCardEdit
                      key={`edit-${task.id}`}
                      task={task}
                      statuses={statuses}
                      onSave={onEditSave}
                      onCancel={onEditCancel}
                    />
                  )
                }

                // Render normal card
                return (
                  <KanbanCard
                    key={task.id}
                    task={task}
                    allTasks={allTasks}
                    isSelected={selectedTaskId === task.id}
                    isFocused={focusedTaskId === task.id}
                    isCompleted={isCompleted}
                    isOverdue={isOverdue}
                    onClick={() => onTaskClick(task.id)}
                    onDoubleClick={() => onTaskDoubleClick(task.id)}
                    // Selection props
                    isSelectionMode={isSelectionMode}
                    isCheckedForSelection={isCheckedForSelection}
                    onToggleSelect={onToggleSelect}
                  />
                )
              })
            )}
          </div>
        </SortableContext>
      </ScrollArea>

      {/* Footer - Add Task (hidden for done columns) */}
      {!isDoneColumn && (
        <div className="border-t border-border/50 px-2 py-2">
          {isAddingTask ? (
            <input
              type="text"
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              onKeyDown={handleAddKeyDown}
              onBlur={handleAddBlur}
              placeholder="Task title..."
              autoFocus
              className={cn(
                "w-full rounded-md border border-border bg-background px-3 py-2 text-sm",
                "placeholder:text-muted-foreground",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              )}
            />
          ) : (
            <button
              type="button"
              onClick={handleAddClick}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors",
                "hover:bg-accent hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              )}
            >
              <Plus className="size-4" />
              <span>Add task</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default KanbanColumn
