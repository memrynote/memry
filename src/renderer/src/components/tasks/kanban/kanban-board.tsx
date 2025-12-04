import { useState, useMemo, useCallback, useRef, useEffect } from "react"
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
  MeasuringStrategy,
} from "@dnd-kit/core"
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { KanbanColumn, type KanbanColumnData } from "./kanban-column"
import { KanbanDragOverlay } from "./kanban-drag-overlay"
import { startOfDay, isBefore, getDefaultTodoStatus, getDefaultDoneStatus } from "@/lib/task-utils"
import type { Task } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

type SelectionType = "view" | "project"

interface LinearCardItem {
  taskId: string
  columnId: string
}

interface KanbanBoardProps {
  tasks: Task[]
  projects: Project[]
  selectedId: string
  selectedType: SelectionType
  selectedTaskId: string | null
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void
  onTaskClick: (taskId: string) => void
  onToggleComplete: (taskId: string) => void
  onDeleteTask: (taskId: string) => void
  onQuickAdd: (
    title: string,
    parsedData?: {
      dueDate: Date | null
      priority: Task["priority"]
      projectId: string | null
    }
  ) => void
  className?: string
}

// ============================================================================
// COLUMN GENERATION
// ============================================================================

const getKanbanColumns = (
  selectedId: string,
  selectedType: SelectionType,
  projects: Project[]
): KanbanColumnData[] => {
  // Project view: columns = project's statuses
  if (selectedType === "project") {
    const project = projects.find((p) => p.id === selectedId)
    if (!project) return []

    return project.statuses.map((status) => ({
      id: status.id,
      title: status.name,
      color: status.color,
      type: "status" as const,
      statusType: status.type,
    }))
  }

  // All Tasks view: columns = projects
  if (selectedId === "all") {
    return projects
      .filter((p) => !p.isArchived)
      .sort((a, b) => {
        if (a.isDefault) return -1
        if (b.isDefault) return 1
        return a.name.localeCompare(b.name)
      })
      .map((project) => ({
        id: project.id,
        title: project.name,
        color: project.color,
        icon: project.icon,
        type: "project" as const,
      }))
  }

  return []
}

// ============================================================================
// KANBAN BOARD COMPONENT
// ============================================================================

export const KanbanBoard = ({
  tasks,
  projects,
  selectedId,
  selectedType,
  selectedTaskId,
  onUpdateTask,
  onTaskClick,
  onToggleComplete,
  onDeleteTask,
  onQuickAdd,
  className,
}: KanbanBoardProps): React.JSX.Element => {
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null)
  const boardRef = useRef<HTMLDivElement>(null)

  // Generate columns based on view context
  const columns = useMemo(
    () => getKanbanColumns(selectedId, selectedType, projects),
    [selectedId, selectedType, projects]
  )

  // Get the currently selected project (for status columns)
  const selectedProject = useMemo(() => {
    if (selectedType === "project") {
      return projects.find((p) => p.id === selectedId) || null
    }
    return null
  }, [selectedId, selectedType, projects])

  // Group tasks by column
  const columnTasks = useMemo(() => {
    const grouped: Record<string, Task[]> = {}

    columns.forEach((column) => {
      if (column.type === "status") {
        grouped[column.id] = tasks.filter((t) => t.statusId === column.id)
      } else if (column.type === "project") {
        grouped[column.id] = tasks.filter((t) => t.projectId === column.id)
      }
    })

    return grouped
  }, [columns, tasks])

  // Get the active task being dragged
  const activeTask = useMemo(() => {
    if (!activeTaskId) return null
    return tasks.find((t) => t.id === activeTaskId) || null
  }, [activeTaskId, tasks])

  // Check if a task is completed
  const getTaskIsCompleted = useCallback(
    (task: Task): boolean => {
      const project = projects.find((p) => p.id === task.projectId)
      if (!project) return false
      const status = project.statuses.find((s) => s.id === task.statusId)
      return status?.type === "done"
    },
    [projects]
  )

  // Check if a task is overdue
  const isTaskOverdue = useCallback((task: Task): boolean => {
    if (!task.dueDate) return false
    const today = startOfDay(new Date())
    const dueDate = startOfDay(task.dueDate)
    return isBefore(dueDate, today)
  }, [])

  // Sensors for drag and drop
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  // Measuring configuration for smooth animations
  const measuringConfig = {
    droppable: {
      strategy: MeasuringStrategy.Always,
    },
  }

  // Handle drag start
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveTaskId(event.active.id as string)
  }, [])

  // Handle drag over - for real-time visual feedback
  const handleDragOver = useCallback((event: DragOverEvent) => {
    // This provides visual feedback as items move between columns
    // The actual update happens in handleDragEnd
  }, [])

  // Handle drag end
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event

      setActiveTaskId(null)

      if (!over) return

      const taskId = active.id as string
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return

      // Determine target column
      const overData = over.data.current
      let targetColumnId: string

      if (overData?.type === "column") {
        // Dropped on a column
        targetColumnId = over.id as string
      } else if (overData?.type === "task") {
        // Dropped on a task - find its column
        const overTask = overData.task as Task
        if (selectedType === "project") {
          targetColumnId = overTask.statusId
        } else {
          targetColumnId = overTask.projectId
        }
      } else {
        // Dropped on column directly
        targetColumnId = over.id as string
      }

      // Find target column
      const targetColumn = columns.find((c) => c.id === targetColumnId)
      if (!targetColumn) return

      // Handle status columns (project view)
      if (targetColumn.type === "status" && selectedProject) {
        const targetStatus = selectedProject.statuses.find(
          (s) => s.id === targetColumnId
        )
        if (!targetStatus) return

        const updates: Partial<Task> = {
          statusId: targetColumnId,
        }

        // If moving to "done" status, set completedAt
        if (targetStatus.type === "done" && !task.completedAt) {
          updates.completedAt = new Date()
        }
        // If moving out of "done" status, clear completedAt
        else if (targetStatus.type !== "done" && task.completedAt) {
          updates.completedAt = null
        }

        // Only update if something changed
        if (task.statusId !== targetColumnId) {
          onUpdateTask(taskId, updates)
        }
      }

      // Handle project columns (all tasks view)
      if (targetColumn.type === "project") {
        if (task.projectId === targetColumnId) return // No change

        const targetProject = projects.find((p) => p.id === targetColumnId)
        if (!targetProject) return

        // Find the current status type
        const currentProject = projects.find((p) => p.id === task.projectId)
        const currentStatus = currentProject?.statuses.find(
          (s) => s.id === task.statusId
        )
        const currentStatusType = currentStatus?.type || "todo"

        // Map to equivalent status in new project
        let newStatus = targetProject.statuses.find(
          (s) => s.type === currentStatusType
        )
        // Fall back to first todo status if no match
        if (!newStatus) {
          newStatus = getDefaultTodoStatus(targetProject)
        }

        const updates: Partial<Task> = {
          projectId: targetColumnId,
          statusId: newStatus?.id || targetProject.statuses[0]?.id,
        }

        onUpdateTask(taskId, updates)
      }
    },
    [tasks, columns, selectedType, selectedProject, projects, onUpdateTask]
  )

  // Handle quick add from column
  const handleColumnQuickAdd = useCallback(
    (title: string, columnId: string) => {
      const column = columns.find((c) => c.id === columnId)
      if (!column) return

      if (column.type === "status" && selectedProject) {
        // Adding to a status column - use the current project and the column's status
        onQuickAdd(title, {
          dueDate: null,
          priority: "none",
          projectId: selectedProject.id,
          statusId: columnId, // Pass the status ID from the column
        })
      } else if (column.type === "project") {
        // Adding to a project column - status will be default todo
        onQuickAdd(title, {
          dueDate: null,
          priority: "none",
          projectId: columnId,
        })
      }
    },
    [columns, selectedProject, onQuickAdd]
  )

  // Determine if active task is completed/overdue for overlay
  const isActiveTaskCompleted = activeTask ? getTaskIsCompleted(activeTask) : false
  const isActiveTaskOverdue =
    activeTask && !isActiveTaskCompleted ? isTaskOverdue(activeTask) : false

  // ========================================================================
  // LINEAR KEYBOARD NAVIGATION
  // ========================================================================

  // Build linear card order (flatten all cards across columns)
  const getLinearCardOrder = useCallback((): LinearCardItem[] => {
    const linearOrder: LinearCardItem[] = []
    columns.forEach((column) => {
      const tasksInColumn = columnTasks[column.id] || []
      tasksInColumn.forEach((task) => {
        linearOrder.push({ taskId: task.id, columnId: column.id })
      })
    })
    return linearOrder
  }, [columns, columnTasks])

  // Navigate to next card (linear, wraps between columns)
  const navigateNext = useCallback(() => {
    const linearOrder = getLinearCardOrder()
    if (linearOrder.length === 0) return

    const currentIndex = linearOrder.findIndex((item) => item.taskId === focusedTaskId)

    if (currentIndex === -1) {
      // No card focused, focus first card
      setFocusedTaskId(linearOrder[0].taskId)
    } else {
      // Move to next card (wrap to beginning if at end)
      const nextIndex = (currentIndex + 1) % linearOrder.length
      setFocusedTaskId(linearOrder[nextIndex].taskId)
    }
  }, [focusedTaskId, getLinearCardOrder])

  // Navigate to previous card (linear, wraps between columns)
  const navigatePrevious = useCallback(() => {
    const linearOrder = getLinearCardOrder()
    if (linearOrder.length === 0) return

    const currentIndex = linearOrder.findIndex((item) => item.taskId === focusedTaskId)

    if (currentIndex === -1) {
      // No card focused, focus last card
      setFocusedTaskId(linearOrder[linearOrder.length - 1].taskId)
    } else {
      // Move to previous card (wrap to end if at beginning)
      const prevIndex = currentIndex === 0 ? linearOrder.length - 1 : currentIndex - 1
      setFocusedTaskId(linearOrder[prevIndex].taskId)
    }
  }, [focusedTaskId, getLinearCardOrder])

  // Navigate to first card of adjacent column
  const navigateToColumn = useCallback(
    (direction: "next" | "previous") => {
      const linearOrder = getLinearCardOrder()
      if (linearOrder.length === 0 || columns.length === 0) return

      // Find current column index
      const currentItem = linearOrder.find((item) => item.taskId === focusedTaskId)
      let currentColumnIndex = currentItem
        ? columns.findIndex((col) => col.id === currentItem.columnId)
        : -1

      // If no current focus, start from first/last column
      if (currentColumnIndex === -1) {
        currentColumnIndex = direction === "next" ? -1 : columns.length
      }

      // Calculate target column (no wrap)
      const targetIndex =
        direction === "next"
          ? Math.min(currentColumnIndex + 1, columns.length - 1)
          : Math.max(currentColumnIndex - 1, 0)

      const targetColumnId = columns[targetIndex].id

      // Find first card in target column
      const firstInColumn = linearOrder.find((item) => item.columnId === targetColumnId)

      if (firstInColumn) {
        setFocusedTaskId(firstInColumn.taskId)
      }
    },
    [focusedTaskId, columns, getLinearCardOrder]
  )

  // Move focused task to adjacent column
  const moveTaskToAdjacentColumn = useCallback(
    (direction: "next" | "previous") => {
      if (!focusedTaskId) return

      const task = tasks.find((t) => t.id === focusedTaskId)
      if (!task) return

      // Find current column index
      let currentColumnIndex: number
      if (selectedType === "project") {
        currentColumnIndex = columns.findIndex((col) => col.id === task.statusId)
      } else {
        currentColumnIndex = columns.findIndex((col) => col.id === task.projectId)
      }

      if (currentColumnIndex === -1) return

      // Calculate target column (no wrap)
      const targetIndex =
        direction === "next"
          ? Math.min(currentColumnIndex + 1, columns.length - 1)
          : Math.max(currentColumnIndex - 1, 0)

      // Don't move if already at edge
      if (targetIndex === currentColumnIndex) return

      const targetColumn = columns[targetIndex]

      // Update task based on column type
      if (selectedType === "project" && targetColumn.type === "status") {
        const updates: Partial<Task> = {
          statusId: targetColumn.id,
        }

        // Handle completedAt based on status type
        if (targetColumn.statusType === "done" && !task.completedAt) {
          updates.completedAt = new Date()
        } else if (targetColumn.statusType !== "done" && task.completedAt) {
          updates.completedAt = null
        }

        onUpdateTask(focusedTaskId, updates)
        toast.success(`Moved to ${targetColumn.title}`)
      } else if (targetColumn.type === "project") {
        const targetProject = projects.find((p) => p.id === targetColumn.id)
        if (!targetProject) return

        // Find current status type and map to new project
        const currentProject = projects.find((p) => p.id === task.projectId)
        const currentStatus = currentProject?.statuses.find((s) => s.id === task.statusId)
        const currentStatusType = currentStatus?.type || "todo"

        let newStatus = targetProject.statuses.find((s) => s.type === currentStatusType)
        if (!newStatus) {
          newStatus = getDefaultTodoStatus(targetProject)
        }

        onUpdateTask(focusedTaskId, {
          projectId: targetColumn.id,
          statusId: newStatus?.id || targetProject.statuses[0]?.id,
        })
        toast.success(`Moved to ${targetColumn.title}`)
      }
    },
    [focusedTaskId, tasks, columns, selectedType, projects, onUpdateTask]
  )

  // Check if an input element is focused
  const isInputFocused = useCallback((): boolean => {
    const activeElement = document.activeElement
    if (!activeElement) return false
    const tagName = activeElement.tagName.toLowerCase()
    return (
      tagName === "input" ||
      tagName === "textarea" ||
      activeElement.getAttribute("contenteditable") === "true"
    )
  }, [])

  // Keyboard handler for linear navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Skip if typing in input
      if (isInputFocused()) return

      // Handle Cmd/Ctrl + arrow keys for moving cards
      if (e.metaKey || e.ctrlKey) {
        switch (e.key) {
          case "ArrowRight":
            e.preventDefault()
            moveTaskToAdjacentColumn("next")
            return
          case "ArrowLeft":
            e.preventDefault()
            moveTaskToAdjacentColumn("previous")
            return
        }
      }

      // Regular navigation
      switch (e.key) {
        // Linear navigation (down/up or j/k)
        case "ArrowDown":
        case "j":
          e.preventDefault()
          navigateNext()
          break

        case "ArrowUp":
        case "k":
          e.preventDefault()
          navigatePrevious()
          break

        // Column jump (left/right)
        case "ArrowLeft":
          e.preventDefault()
          navigateToColumn("previous")
          break

        case "ArrowRight":
          e.preventDefault()
          navigateToColumn("next")
          break

        // Actions
        case "Enter":
        case "e":
          e.preventDefault()
          if (focusedTaskId) {
            onTaskClick(focusedTaskId)
          }
          break

        case " ": // Space - complete task
          e.preventDefault()
          if (focusedTaskId) {
            onToggleComplete(focusedTaskId)
          }
          break

        case "Delete":
        case "Backspace":
          e.preventDefault()
          if (focusedTaskId) {
            onDeleteTask(focusedTaskId)
          }
          break
      }
    },
    [
      isInputFocused,
      focusedTaskId,
      navigateNext,
      navigatePrevious,
      navigateToColumn,
      moveTaskToAdjacentColumn,
      onTaskClick,
      onToggleComplete,
      onDeleteTask,
    ]
  )

  // Clear focus when focused card is deleted
  useEffect(() => {
    if (focusedTaskId) {
      const taskExists = tasks.some((t) => t.id === focusedTaskId)
      if (!taskExists) {
        // Focus was on deleted task, try to move to next
        const linearOrder = getLinearCardOrder()
        if (linearOrder.length > 0) {
          setFocusedTaskId(linearOrder[0].taskId)
        } else {
          setFocusedTaskId(null)
        }
      }
    }
  }, [tasks, focusedTaskId, getLinearCardOrder])

  // Focus the board container when component mounts to enable keyboard nav
  useEffect(() => {
    if (boardRef.current) {
      boardRef.current.focus()
    }
  }, [])

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={measuringConfig}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div
        ref={boardRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className={cn("flex-1 outline-none", className)}
        role="grid"
        aria-label="Kanban board. Use arrow keys to navigate cards."
      >
        <ScrollArea className="h-full">
          <div className="flex h-full gap-4 p-6">
            {columns.map((column) => (
              <KanbanColumn
                key={column.id}
                column={column}
                tasks={columnTasks[column.id] || []}
                selectedTaskId={selectedTaskId}
                focusedTaskId={focusedTaskId}
                getTaskIsCompleted={getTaskIsCompleted}
                onTaskClick={onTaskClick}
                onQuickAdd={handleColumnQuickAdd}
              />
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>

      <KanbanDragOverlay
        activeTask={activeTask}
        isCompleted={isActiveTaskCompleted}
        isOverdue={isActiveTaskOverdue}
      />
    </DndContext>
  )
}

export default KanbanBoard

