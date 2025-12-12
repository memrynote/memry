import { useCallback } from "react"
import { toast } from "sonner"

import type { Task, Priority } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"
import { getDefaultTodoStatus, getDefaultDoneStatus } from "@/lib/task-utils"

// ============================================================================
// TYPES
// ============================================================================

export interface UseBulkActionsOptions {
  /** Array of selected task IDs */
  selectedIds: string[]
  /** All tasks */
  tasks: Task[]
  /** All projects */
  projects: Project[]
  /** Callback to update a single task */
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void
  /** Callback to delete a single task */
  onDeleteTask: (taskId: string) => void
  /** Callback when bulk action completes (to clear selection) */
  onComplete: () => void
}

export interface UseBulkActionsReturn {
  /** Complete all selected tasks */
  bulkComplete: () => void
  /** Uncomplete all selected tasks */
  bulkUncomplete: () => void
  /** Change priority for all selected tasks */
  bulkChangePriority: (priority: Priority) => void
  /** Change due date for all selected tasks */
  bulkChangeDueDate: (dueDate: Date | null) => void
  /** Move all selected tasks to a different project */
  bulkMoveToProject: (projectId: string) => void
  /** Change status for all selected tasks (Kanban) */
  bulkChangeStatus: (statusId: string) => void
  /** Archive all selected tasks */
  bulkArchive: () => void
  /** Delete all selected tasks */
  bulkDelete: () => void
  /** Get selected tasks */
  getSelectedTasks: () => Task[]
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Hook to handle bulk actions on selected tasks
 */
export const useBulkActions = ({
  selectedIds,
  tasks,
  projects,
  onUpdateTask,
  onDeleteTask,
  onComplete,
}: UseBulkActionsOptions): UseBulkActionsReturn => {
  // ========== HELPERS ==========

  const getSelectedTasks = useCallback((): Task[] => {
    return tasks.filter((task) => selectedIds.includes(task.id))
  }, [tasks, selectedIds])

  // ========== BULK ACTIONS ==========

  const bulkComplete = useCallback((): void => {
    const now = new Date()
    const selectedTasks = getSelectedTasks()
    const tasksToComplete = selectedTasks.filter((task) => {
      const project = projects.find((p) => p.id === task.projectId)
      if (!project) return false
      const status = project.statuses.find((s) => s.id === task.statusId)
      return status?.type !== "done"
    })

    if (tasksToComplete.length === 0) {
      toast.info("All selected tasks are already complete")
      return
    }

    // Store original states for undo
    const originalStates = tasksToComplete.map((task) => ({
      id: task.id,
      statusId: task.statusId,
      completedAt: task.completedAt,
    }))

    tasksToComplete.forEach((task) => {
      const project = projects.find((p) => p.id === task.projectId)
      if (!project) return

      const doneStatus = getDefaultDoneStatus(project)
      if (doneStatus) {
        onUpdateTask(task.id, {
          statusId: doneStatus.id,
          completedAt: now,
        })
      }
    })

    toast.success(`${tasksToComplete.length} task${tasksToComplete.length !== 1 ? "s" : ""} completed`, {
      action: {
        label: "Undo",
        onClick: () => {
          originalStates.forEach((state) => {
            onUpdateTask(state.id, {
              statusId: state.statusId,
              completedAt: state.completedAt,
            })
          })
          toast.success("Changes undone")
        },
      },
    })

    onComplete()
  }, [getSelectedTasks, projects, onUpdateTask, onComplete])

  const bulkUncomplete = useCallback((): void => {
    const selectedTasks = getSelectedTasks()
    const tasksToUncomplete = selectedTasks.filter((task) => {
      const project = projects.find((p) => p.id === task.projectId)
      if (!project) return false
      const status = project.statuses.find((s) => s.id === task.statusId)
      return status?.type === "done"
    })

    if (tasksToUncomplete.length === 0) {
      toast.info("No completed tasks selected")
      return
    }

    tasksToUncomplete.forEach((task) => {
      const project = projects.find((p) => p.id === task.projectId)
      if (!project) return

      const todoStatus = getDefaultTodoStatus(project)
      if (todoStatus) {
        onUpdateTask(task.id, {
          statusId: todoStatus.id,
          completedAt: null,
        })
      }
    })

    toast.success(`${tasksToUncomplete.length} task${tasksToUncomplete.length !== 1 ? "s" : ""} restored`)
    onComplete()
  }, [getSelectedTasks, projects, onUpdateTask, onComplete])

  const bulkChangePriority = useCallback(
    (priority: Priority): void => {
      const count = selectedIds.length
      if (count === 0) return

      selectedIds.forEach((taskId) => {
        onUpdateTask(taskId, { priority })
      })

      const priorityLabel = priority === "none" ? "removed" : `set to ${priority}`
      toast.success(`Priority ${priorityLabel} for ${count} task${count !== 1 ? "s" : ""}`)
      onComplete()
    },
    [selectedIds, onUpdateTask, onComplete]
  )

  const bulkChangeDueDate = useCallback(
    (dueDate: Date | null): void => {
      const count = selectedIds.length
      if (count === 0) return

      selectedIds.forEach((taskId) => {
        onUpdateTask(taskId, { dueDate })
      })

      const message = dueDate
        ? `Due date set for ${count} task${count !== 1 ? "s" : ""}`
        : `Due date removed from ${count} task${count !== 1 ? "s" : ""}`

      toast.success(message)
      onComplete()
    },
    [selectedIds, onUpdateTask, onComplete]
  )

  const bulkMoveToProject = useCallback(
    (projectId: string): void => {
      const count = selectedIds.length
      if (count === 0) return

      const targetProject = projects.find((p) => p.id === projectId)
      if (!targetProject) {
        toast.error("Project not found")
        return
      }

      const defaultStatus = getDefaultTodoStatus(targetProject)

      selectedIds.forEach((taskId) => {
        const task = tasks.find((t) => t.id === taskId)
        if (!task) return

        // Get current status type to try to match in new project
        const currentProject = projects.find((p) => p.id === task.projectId)
        const currentStatus = currentProject?.statuses.find((s) => s.id === task.statusId)
        const currentStatusType = currentStatus?.type || "todo"

        // Try to find matching status type in target project
        let newStatus = targetProject.statuses.find((s) => s.type === currentStatusType)
        if (!newStatus) {
          newStatus = defaultStatus
        }

        const updates: Partial<Task> = {
          projectId,
          statusId: newStatus?.id || targetProject.statuses[0]?.id,
        }

        // Handle completed status
        if (newStatus?.type === "done" && !task.completedAt) {
          updates.completedAt = new Date()
        } else if (newStatus?.type !== "done" && task.completedAt) {
          updates.completedAt = null
        }

        onUpdateTask(taskId, updates)
      })

      toast.success(`${count} task${count !== 1 ? "s" : ""} moved to ${targetProject.name}`)
      onComplete()
    },
    [selectedIds, tasks, projects, onUpdateTask, onComplete]
  )

  const bulkChangeStatus = useCallback(
    (statusId: string): void => {
      const count = selectedIds.length
      if (count === 0) return

      // Find the status to get its name and type
      let statusName = ""
      let statusType: "todo" | "in_progress" | "done" = "todo"

      for (const project of projects) {
        const status = project.statuses.find((s) => s.id === statusId)
        if (status) {
          statusName = status.name
          statusType = status.type
          break
        }
      }

      selectedIds.forEach((taskId) => {
        const task = tasks.find((t) => t.id === taskId)
        if (!task) return

        const updates: Partial<Task> = { statusId }

        // Handle completedAt based on status type
        if (statusType === "done" && !task.completedAt) {
          updates.completedAt = new Date()
        } else if (statusType !== "done" && task.completedAt) {
          updates.completedAt = null
        }

        onUpdateTask(taskId, updates)
      })

      toast.success(`${count} task${count !== 1 ? "s" : ""} moved to ${statusName}`)
      onComplete()
    },
    [selectedIds, tasks, projects, onUpdateTask, onComplete]
  )

  const bulkArchive = useCallback((): void => {
    const count = selectedIds.length
    if (count === 0) return

    const now = new Date()

    // Store for undo
    const archivedIds = [...selectedIds]

    selectedIds.forEach((taskId) => {
      onUpdateTask(taskId, { archivedAt: now })
    })

    toast.success(`${count} task${count !== 1 ? "s" : ""} archived`, {
      action: {
        label: "Undo",
        onClick: () => {
          archivedIds.forEach((taskId) => {
            onUpdateTask(taskId, { archivedAt: null })
          })
          toast.success("Tasks restored from archive")
        },
      },
    })

    onComplete()
  }, [selectedIds, onUpdateTask, onComplete])

  const bulkDelete = useCallback((): void => {
    const count = selectedIds.length
    if (count === 0) return

    // Store deleted tasks for undo
    const deletedTasks = getSelectedTasks().map((task) => ({ ...task }))

    selectedIds.forEach((taskId) => {
      onDeleteTask(taskId)
    })

    toast.success(`${count} task${count !== 1 ? "s" : ""} deleted`, {
      description: "This action can be undone for a short time.",
    })

    onComplete()
  }, [selectedIds, getSelectedTasks, onDeleteTask, onComplete])

  return {
    bulkComplete,
    bulkUncomplete,
    bulkChangePriority,
    bulkChangeDueDate,
    bulkMoveToProject,
    bulkChangeStatus,
    bulkArchive,
    bulkDelete,
    getSelectedTasks,
  }
}

export default useBulkActions











