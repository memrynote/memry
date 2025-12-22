import { useState, useCallback } from "react"
import { toast } from "sonner"

import {
  createSubtask,
  createMultipleSubtasks,
  reorderSubtasks,
  promoteToTask,
  demoteToSubtask,
  deleteSubtask,
  deleteParentWithSubtasks,
  completeParentWithSubtasks,
  getIncompleteSubtasks,
  getSubtasks,
  hasIncompleteSubtasks,
  hasSubtasks,
  type CreateSubtaskOptions,
} from "@/lib/subtask-utils"
import {
  checkAllSubtasksComplete,
  completeAllSubtasks,
  markAllSubtasksIncomplete,
  setDueDateForAllSubtasks,
  setPriorityForAllSubtasks,
  deleteAllSubtasks,
  completeParentTask,
} from "@/lib/subtask-bulk-utils"
import { useTaskSettings } from "./use-task-settings"
import type { Task, Priority } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface UseSubtaskManagementOptions {
  tasks: Task[]
  projects: Project[]
  onTasksChange: (tasks: Task[]) => void
  // T038-T042: Database-aware operations for subtask persistence
  onAddTask?: (task: Task) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onDeleteTask?: (taskId: string) => void
  onReorderTasks?: (taskIds: string[], positions: number[]) => void
}

interface UseSubtaskManagementReturn {
  // Dialog state
  deleteParentDialogOpen: boolean
  completeParentDialogOpen: boolean
  parentPickerDialogOpen: boolean
  allSubtasksCompleteDialogOpen: boolean
  bulkDueDateDialogOpen: boolean
  bulkPriorityDialogOpen: boolean
  deleteAllSubtasksDialogOpen: boolean

  // Dialog data
  pendingDeleteParent: Task | null
  pendingDeleteSubtaskCount: number
  pendingCompleteParent: Task | null
  pendingCompleteIncompleteSubtasks: Task[]
  pendingDemoteTask: Task | null
  pendingAutoCompleteParent: Task | null
  pendingBulkOperationParent: Task | null
  pendingBulkOperationSubtasks: Task[]

  // Dialog handlers
  openDeleteParentDialog: (parent: Task) => void
  closeDeleteParentDialog: () => void
  confirmDeleteParent: (keepSubtasks: boolean) => void

  openCompleteParentDialog: (parent: Task) => void
  closeCompleteParentDialog: () => void
  confirmCompleteParent: (completeSubtasks: boolean) => void

  openParentPickerDialog: (task: Task) => void
  closeParentPickerDialog: () => void
  confirmDemoteToSubtask: (parentId: string) => void

  // All subtasks complete dialog handlers
  closeAllSubtasksCompleteDialog: () => void
  keepParentOpen: () => void
  autoCompleteParent: () => void

  // Bulk operation dialog handlers
  openBulkDueDateDialog: (parentId: string) => void
  closeBulkDueDateDialog: () => void
  confirmBulkDueDate: (dueDate: Date | null, includeCompleted: boolean) => void

  openBulkPriorityDialog: (parentId: string) => void
  closeBulkPriorityDialog: () => void
  confirmBulkPriority: (priority: Priority, includeCompleted: boolean) => void

  openDeleteAllSubtasksDialog: (parentId: string) => void
  closeDeleteAllSubtasksDialog: () => void
  confirmDeleteAllSubtasks: () => void

  // Direct actions
  handleAddSubtask: (parentId: string, title: string) => void
  handleBulkAddSubtasks: (parentId: string, titles: string[]) => void
  handleReorderSubtasks: (parentId: string, newOrder: string[]) => void
  handlePromoteToTask: (subtaskId: string) => void
  handleDeleteSubtask: (subtaskId: string) => void

  // Bulk actions
  handleCompleteAllSubtasks: (parentId: string) => void
  handleMarkAllSubtasksIncomplete: (parentId: string) => void

  // Smart actions (may open dialogs if needed)
  handleDeleteTask: (taskId: string) => void
  handleCompleteTask: (taskId: string) => void
  handleCompleteSubtask: (subtaskId: string) => void
}

// ============================================================================
// USE SUBTASK MANAGEMENT HOOK
// ============================================================================

export const useSubtaskManagement = ({
  tasks,
  projects: _projects,
  onTasksChange,
  onAddTask,
  onUpdateTask,
  onDeleteTask,
  onReorderTasks,
}: UseSubtaskManagementOptions): UseSubtaskManagementReturn => {
  // Note: projects is available for future use (e.g., status handling)
  void _projects
  // Get settings
  const { subtaskSettings } = useTaskSettings()

  // Delete parent dialog state
  const [deleteParentDialogOpen, setDeleteParentDialogOpen] = useState(false)
  const [pendingDeleteParent, setPendingDeleteParent] = useState<Task | null>(null)
  const [pendingDeleteSubtaskCount, setPendingDeleteSubtaskCount] = useState(0)

  // Complete parent dialog state
  const [completeParentDialogOpen, setCompleteParentDialogOpen] = useState(false)
  const [pendingCompleteParent, setPendingCompleteParent] = useState<Task | null>(null)
  const [pendingCompleteIncompleteSubtasks, setPendingCompleteIncompleteSubtasks] = useState<Task[]>([])

  // Parent picker dialog state
  const [parentPickerDialogOpen, setParentPickerDialogOpen] = useState(false)
  const [pendingDemoteTask, setPendingDemoteTask] = useState<Task | null>(null)

  // All subtasks complete dialog state
  const [allSubtasksCompleteDialogOpen, setAllSubtasksCompleteDialogOpen] = useState(false)
  const [pendingAutoCompleteParent, setPendingAutoCompleteParent] = useState<Task | null>(null)

  // Bulk operation dialog state
  const [bulkDueDateDialogOpen, setBulkDueDateDialogOpen] = useState(false)
  const [bulkPriorityDialogOpen, setBulkPriorityDialogOpen] = useState(false)
  const [deleteAllSubtasksDialogOpen, setDeleteAllSubtasksDialogOpen] = useState(false)
  const [pendingBulkOperationParent, setPendingBulkOperationParent] = useState<Task | null>(null)
  const [pendingBulkOperationSubtasks, setPendingBulkOperationSubtasks] = useState<Task[]>([])

  // ========================================================================
  // ADD SUBTASK
  // ========================================================================

  const handleAddSubtask = useCallback(
    (parentId: string, title: string): void => {
      const options: CreateSubtaskOptions = {
        parentId,
        title,
      }

      const result = createSubtask(options, tasks)

      if (result.success && result.updatedTasks && result.newTask) {
        // T038: Use database-aware callback if available
        if (onAddTask) {
          onAddTask(result.newTask)
        } else {
          onTasksChange(result.updatedTasks)
        }
        toast.success("Subtask added")
      } else {
        toast.error(result.error || "Failed to add subtask")
      }
    },
    [tasks, onTasksChange, onAddTask]
  )

  // ========================================================================
  // BULK ADD SUBTASKS
  // ========================================================================

  const handleBulkAddSubtasks = useCallback(
    (parentId: string, titles: string[]): void => {
      if (titles.length === 0) return

      const result = createMultipleSubtasks(parentId, titles, tasks)

      if (result.success && result.updatedTasks && result.newTasks) {
        // T038: Use database-aware callback if available
        if (onAddTask) {
          result.newTasks.forEach((task) => onAddTask(task))
        } else {
          onTasksChange(result.updatedTasks)
        }
        toast.success(`${titles.length} subtask${titles.length > 1 ? "s" : ""} added`)
      } else {
        toast.error(result.error || "Failed to add subtasks")
      }
    },
    [tasks, onTasksChange, onAddTask]
  )

  // ========================================================================
  // REORDER SUBTASKS
  // ========================================================================

  const handleReorderSubtasks = useCallback(
    (parentId: string, newOrder: string[]): void => {
      const result = reorderSubtasks(parentId, newOrder, tasks)

      if (result.success && result.updatedTasks) {
        // T039: Use database-aware callback if available
        if (onReorderTasks && result.reorderedTasks) {
          // Reorder subtasks in database
          const taskIds = result.reorderedTasks.map((t) => t.id)
          const positions = result.reorderedTasks.map((_, index) => index)
          onReorderTasks(taskIds, positions)
        } else {
          onTasksChange(result.updatedTasks)
        }
      } else {
        toast.error(result.error || "Failed to reorder subtasks")
      }
    },
    [tasks, onTasksChange, onReorderTasks]
  )

  // ========================================================================
  // PROMOTE TO TASK
  // ========================================================================

  const handlePromoteToTask = useCallback(
    (subtaskId: string): void => {
      const subtask = tasks.find((t) => t.id === subtaskId)
      const result = promoteToTask(subtaskId, tasks)

      if (result.success && result.updatedTasks) {
        // T042: Use database-aware callback if available
        if (onUpdateTask) {
          onUpdateTask(subtaskId, { parentId: null })
        } else {
          onTasksChange(result.updatedTasks)
        }
        toast.success(`"${subtask?.title}" promoted to task`)
      } else {
        toast.error(result.error || "Failed to promote subtask")
      }
    },
    [tasks, onTasksChange, onUpdateTask]
  )

  // ========================================================================
  // DELETE SUBTASK
  // ========================================================================

  const handleDeleteSubtask = useCallback(
    (subtaskId: string): void => {
      const result = deleteSubtask(subtaskId, tasks)

      if (result.success && result.updatedTasks) {
        // T041: Use database-aware callback if available
        if (onDeleteTask) {
          onDeleteTask(subtaskId)
        } else {
          onTasksChange(result.updatedTasks)
        }
        toast.success("Subtask deleted", {
          description: "The subtask has been removed",
        })
      } else {
        toast.error(result.error || "Failed to delete subtask")
      }
    },
    [tasks, onTasksChange, onDeleteTask]
  )

  // ========================================================================
  // DELETE PARENT DIALOG
  // ========================================================================

  const openDeleteParentDialog = useCallback((parent: Task): void => {
    setPendingDeleteParent(parent)
    setPendingDeleteSubtaskCount(parent.subtaskIds.length)
    setDeleteParentDialogOpen(true)
  }, [])

  const closeDeleteParentDialog = useCallback((): void => {
    setDeleteParentDialogOpen(false)
    setPendingDeleteParent(null)
    setPendingDeleteSubtaskCount(0)
  }, [])

  const confirmDeleteParent = useCallback(
    (keepSubtasks: boolean): void => {
      if (!pendingDeleteParent) return

      const result = deleteParentWithSubtasks(
        pendingDeleteParent.id,
        keepSubtasks,
        tasks
      )

      if (result.success && result.updatedTasks) {
        onTasksChange(result.updatedTasks)
        toast.success(
          keepSubtasks
            ? "Task deleted, subtasks converted to tasks"
            : "Task and subtasks deleted"
        )
      } else {
        toast.error(result.error || "Failed to delete task")
      }

      closeDeleteParentDialog()
    },
    [pendingDeleteParent, tasks, onTasksChange, closeDeleteParentDialog]
  )

  // ========================================================================
  // COMPLETE PARENT DIALOG
  // ========================================================================

  const openCompleteParentDialog = useCallback(
    (parent: Task): void => {
      const incompleteSubtasks = getIncompleteSubtasks(parent.id, tasks)
      setPendingCompleteParent(parent)
      setPendingCompleteIncompleteSubtasks(incompleteSubtasks)
      setCompleteParentDialogOpen(true)
    },
    [tasks]
  )

  const closeCompleteParentDialog = useCallback((): void => {
    setCompleteParentDialogOpen(false)
    setPendingCompleteParent(null)
    setPendingCompleteIncompleteSubtasks([])
  }, [])

  const confirmCompleteParent = useCallback(
    (completeSubtasks: boolean): void => {
      if (!pendingCompleteParent) return

      const result = completeParentWithSubtasks(
        pendingCompleteParent.id,
        completeSubtasks,
        tasks
      )

      if (result.success && result.updatedTasks) {
        onTasksChange(result.updatedTasks)
        toast.success(
          completeSubtasks
            ? "Task and subtasks completed"
            : "Task completed"
        )
      } else {
        toast.error(result.error || "Failed to complete task")
      }

      closeCompleteParentDialog()
    },
    [pendingCompleteParent, tasks, onTasksChange, closeCompleteParentDialog]
  )

  // ========================================================================
  // PARENT PICKER DIALOG (DEMOTE TO SUBTASK)
  // ========================================================================

  const openParentPickerDialog = useCallback((task: Task): void => {
    setPendingDemoteTask(task)
    setParentPickerDialogOpen(true)
  }, [])

  const closeParentPickerDialog = useCallback((): void => {
    setParentPickerDialogOpen(false)
    setPendingDemoteTask(null)
  }, [])

  const confirmDemoteToSubtask = useCallback(
    (parentId: string): void => {
      if (!pendingDemoteTask) return

      const parent = tasks.find((t) => t.id === parentId)
      const result = demoteToSubtask(pendingDemoteTask.id, parentId, tasks)

      if (result.success && result.updatedTasks) {
        // T038: Use database-aware callback if available
        if (onUpdateTask) {
          onUpdateTask(pendingDemoteTask.id, { parentId })
        } else {
          onTasksChange(result.updatedTasks)
        }
        toast.success(`Moved under "${parent?.title}"`)
      } else {
        toast.error(result.error || "Failed to make subtask")
      }

      closeParentPickerDialog()
    },
    [pendingDemoteTask, tasks, onTasksChange, onUpdateTask, closeParentPickerDialog]
  )

  // ========================================================================
  // SMART DELETE (opens dialog if has subtasks)
  // ========================================================================

  const handleDeleteTask = useCallback(
    (taskId: string): void => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return

      // If it's a subtask, use simple delete
      if (task.parentId !== null) {
        handleDeleteSubtask(taskId)
        return
      }

      // If it has subtasks, open confirmation dialog
      if (hasSubtasks(task)) {
        openDeleteParentDialog(task)
        return
      }

      // Simple delete for task without subtasks
      const updatedTasks = tasks.filter((t) => t.id !== taskId)
      onTasksChange(updatedTasks)
      toast.success("Task deleted")
    },
    [tasks, onTasksChange, handleDeleteSubtask, openDeleteParentDialog]
  )

  // ========================================================================
  // SMART COMPLETE (opens dialog if has incomplete subtasks)
  // ========================================================================

  const handleCompleteTask = useCallback(
    (taskId: string): void => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return

      // If already completed, uncomplete
      if (task.completedAt !== null) {
        const updatedTasks = tasks.map((t) =>
          t.id === taskId ? { ...t, completedAt: null } : t
        )
        onTasksChange(updatedTasks)
        return
      }

      // If it's a parent with incomplete subtasks, open dialog
      if (task.parentId === null && hasIncompleteSubtasks(taskId, tasks)) {
        openCompleteParentDialog(task)
        return
      }

      // Simple complete
      const updatedTasks = tasks.map((t) =>
        t.id === taskId ? { ...t, completedAt: new Date() } : t
      )
      onTasksChange(updatedTasks)
      toast.success("Task completed")
    },
    [tasks, onTasksChange, openCompleteParentDialog]
  )

  // ========================================================================
  // COMPLETE SUBTASK WITH AUTO-COMPLETE PARENT CHECK
  // ========================================================================

  const handleCompleteSubtask = useCallback(
    (subtaskId: string): void => {
      const subtask = tasks.find((t) => t.id === subtaskId)
      if (!subtask || !subtask.parentId) return

      const parentId = subtask.parentId
      const isCompleted = subtask.completedAt !== null

      // If already completed, uncomplete it (toggle off)
      if (isCompleted) {
        // Use database-aware callback if available
        if (onUpdateTask) {
          onUpdateTask(subtaskId, { completedAt: null })
        } else {
          const updatedTasks = tasks.map((t) =>
            t.id === subtaskId ? { ...t, completedAt: null } : t
          )
          onTasksChange(updatedTasks)
        }
        return
      }

      // Complete the subtask
      const now = new Date()

      // Use database-aware callback if available
      if (onUpdateTask) {
        onUpdateTask(subtaskId, { completedAt: now })
      } else {
        const updatedTasks = tasks.map((t) =>
          t.id === subtaskId ? { ...t, completedAt: now } : t
        )
        onTasksChange(updatedTasks)
      }

      // For auto-complete parent logic, we need to work with updated tasks
      const updatedTasks = tasks.map((t) =>
        t.id === subtaskId ? { ...t, completedAt: now } : t
      )

      // Check if all subtasks are now complete
      const allComplete = checkAllSubtasksComplete(parentId, updatedTasks)

      if (allComplete) {
        const parent = tasks.find((t) => t.id === parentId)
        if (!parent) return

        if (subtaskSettings.autoCompleteParent) {
          // Delay auto-complete to let celebration animation play
          setTimeout(() => {
            // Use database-aware callback if available
            if (onUpdateTask) {
              onUpdateTask(parentId, { completedAt: new Date() })
              toast.success("🎉 All subtasks complete! Task marked as done.", {
                duration: 10000, // T052: 10-second timeout for undo per spec
                action: {
                  label: "Undo",
                  onClick: () => {
                    onUpdateTask(parentId, { completedAt: null })
                    toast.success("Task reopened")
                  },
                },
              })
            } else {
              const result = completeParentTask(parentId, updatedTasks)
              if (result.success && result.updatedTasks) {
                onTasksChange(result.updatedTasks)
                toast.success("🎉 All subtasks complete! Task marked as done.")
              }
            }
          }, 200) // Wait 0.2 seconds for celebration animation
        } else {
          // Show dialog to ask user (after a brief delay for the animation)
          setTimeout(() => {
            setPendingAutoCompleteParent(parent)
            setAllSubtasksCompleteDialogOpen(true)
          }, 1000)
        }
      }
    },
    [tasks, onTasksChange, onUpdateTask, subtaskSettings.autoCompleteParent]
  )

  // ========================================================================
  // ALL SUBTASKS COMPLETE DIALOG
  // ========================================================================

  const closeAllSubtasksCompleteDialog = useCallback((): void => {
    setAllSubtasksCompleteDialogOpen(false)
    setPendingAutoCompleteParent(null)
  }, [])

  const keepParentOpen = useCallback((): void => {
    closeAllSubtasksCompleteDialog()
    toast.success("Task kept open")
  }, [closeAllSubtasksCompleteDialog])

  const autoCompleteParent = useCallback((): void => {
    if (!pendingAutoCompleteParent) return

    // Use database-aware callback if available
    if (onUpdateTask) {
      onUpdateTask(pendingAutoCompleteParent.id, { completedAt: new Date() })
      toast.success("Task completed")
    } else {
      const result = completeParentTask(pendingAutoCompleteParent.id, tasks)
      if (result.success && result.updatedTasks) {
        onTasksChange(result.updatedTasks)
        toast.success("Task completed")
      }
    }

    closeAllSubtasksCompleteDialog()
  }, [pendingAutoCompleteParent, tasks, onTasksChange, onUpdateTask, closeAllSubtasksCompleteDialog])

  // ========================================================================
  // BULK COMPLETE ALL SUBTASKS
  // ========================================================================

  const handleCompleteAllSubtasks = useCallback(
    (parentId: string): void => {
      const result = completeAllSubtasks(parentId, tasks)

      if (result.success && result.updatedTasks && result.completedSubtasks) {
        const affectedCount = result.affectedCount || 0
        const updatedTasks = result.updatedTasks

        // Use database-aware callback if available
        if (onUpdateTask) {
          const now = new Date()
          result.completedSubtasks.forEach((subtask) => {
            onUpdateTask(subtask.id, { completedAt: now })
          })
        } else {
          onTasksChange(updatedTasks)
        }
        toast.success(`${affectedCount} subtask${affectedCount !== 1 ? "s" : ""} completed`)

        // Check if we should auto-complete parent (with delay for celebration)
        const allComplete = checkAllSubtasksComplete(parentId, updatedTasks)

        if (allComplete && subtaskSettings.autoCompleteParent) {
          setTimeout(() => {
            if (onUpdateTask) {
              onUpdateTask(parentId, { completedAt: new Date() })
              toast.success("🎉 Task marked as done!")
            } else {
              const completeResult = completeParentTask(parentId, updatedTasks)
              if (completeResult.success && completeResult.updatedTasks) {
                onTasksChange(completeResult.updatedTasks)
                toast.success("🎉 Task marked as done!")
              }
            }
          }, 1500) // Wait 1.5 seconds for celebration animation
        }
      } else {
        toast.error(result.error || "Failed to complete subtasks")
      }
    },
    [tasks, onTasksChange, onUpdateTask, subtaskSettings.autoCompleteParent]
  )

  // ========================================================================
  // BULK MARK ALL INCOMPLETE
  // ========================================================================

  const handleMarkAllSubtasksIncomplete = useCallback(
    (parentId: string): void => {
      const result = markAllSubtasksIncomplete(parentId, tasks)

      if (result.success && result.updatedTasks && result.incompleteSubtasks) {
        const affectedCount = result.affectedCount || 0

        // Use database-aware callback if available
        if (onUpdateTask) {
          result.incompleteSubtasks.forEach((subtask) => {
            onUpdateTask(subtask.id, { completedAt: null })
          })
        } else {
          onTasksChange(result.updatedTasks)
        }
        toast.success(`${affectedCount} subtask${affectedCount !== 1 ? "s" : ""} marked incomplete`)
      } else {
        toast.error(result.error || "Failed to mark subtasks incomplete")
      }
    },
    [tasks, onTasksChange, onUpdateTask]
  )

  // ========================================================================
  // BULK DUE DATE DIALOG
  // ========================================================================

  const openBulkDueDateDialog = useCallback(
    (parentId: string): void => {
      const parent = tasks.find((t) => t.id === parentId)
      if (!parent) return

      const subtasks = getSubtasks(parentId, tasks)
      setPendingBulkOperationParent(parent)
      setPendingBulkOperationSubtasks(subtasks)
      setBulkDueDateDialogOpen(true)
    },
    [tasks]
  )

  const closeBulkDueDateDialog = useCallback((): void => {
    setBulkDueDateDialogOpen(false)
    setPendingBulkOperationParent(null)
    setPendingBulkOperationSubtasks([])
  }, [])

  const confirmBulkDueDate = useCallback(
    (dueDate: Date | null, includeCompleted: boolean): void => {
      if (!pendingBulkOperationParent) return

      const result = setDueDateForAllSubtasks(
        pendingBulkOperationParent.id,
        dueDate,
        includeCompleted,
        tasks
      )

      if (result.success && result.updatedTasks) {
        onTasksChange(result.updatedTasks)
        toast.success(
          dueDate
            ? `Due date set for ${result.affectedCount} subtask${result.affectedCount !== 1 ? "s" : ""}`
            : `Due date cleared for ${result.affectedCount} subtask${result.affectedCount !== 1 ? "s" : ""}`
        )
      } else {
        toast.error(result.error || "Failed to set due date")
      }

      closeBulkDueDateDialog()
    },
    [pendingBulkOperationParent, tasks, onTasksChange, closeBulkDueDateDialog]
  )

  // ========================================================================
  // BULK PRIORITY DIALOG
  // ========================================================================

  const openBulkPriorityDialog = useCallback(
    (parentId: string): void => {
      const parent = tasks.find((t) => t.id === parentId)
      if (!parent) return

      const subtasks = getSubtasks(parentId, tasks)
      setPendingBulkOperationParent(parent)
      setPendingBulkOperationSubtasks(subtasks)
      setBulkPriorityDialogOpen(true)
    },
    [tasks]
  )

  const closeBulkPriorityDialog = useCallback((): void => {
    setBulkPriorityDialogOpen(false)
    setPendingBulkOperationParent(null)
    setPendingBulkOperationSubtasks([])
  }, [])

  const confirmBulkPriority = useCallback(
    (priority: Priority, includeCompleted: boolean): void => {
      if (!pendingBulkOperationParent) return

      const result = setPriorityForAllSubtasks(
        pendingBulkOperationParent.id,
        priority,
        includeCompleted,
        tasks
      )

      if (result.success && result.updatedTasks) {
        onTasksChange(result.updatedTasks)
        toast.success(`Priority set for ${result.affectedCount} subtask${result.affectedCount !== 1 ? "s" : ""}`)
      } else {
        toast.error(result.error || "Failed to set priority")
      }

      closeBulkPriorityDialog()
    },
    [pendingBulkOperationParent, tasks, onTasksChange, closeBulkPriorityDialog]
  )

  // ========================================================================
  // DELETE ALL SUBTASKS DIALOG
  // ========================================================================

  const openDeleteAllSubtasksDialog = useCallback(
    (parentId: string): void => {
      const parent = tasks.find((t) => t.id === parentId)
      if (!parent) return

      const subtasks = getSubtasks(parentId, tasks)
      setPendingBulkOperationParent(parent)
      setPendingBulkOperationSubtasks(subtasks)
      setDeleteAllSubtasksDialogOpen(true)
    },
    [tasks]
  )

  const closeDeleteAllSubtasksDialog = useCallback((): void => {
    setDeleteAllSubtasksDialogOpen(false)
    setPendingBulkOperationParent(null)
    setPendingBulkOperationSubtasks([])
  }, [])

  const confirmDeleteAllSubtasks = useCallback((): void => {
    if (!pendingBulkOperationParent) return

    const result = deleteAllSubtasks(pendingBulkOperationParent.id, tasks)

    if (result.success && result.updatedTasks) {
      onTasksChange(result.updatedTasks)
      toast.success(`${result.affectedCount} subtask${result.affectedCount !== 1 ? "s" : ""} deleted`)
    } else {
      toast.error(result.error || "Failed to delete subtasks")
    }

    closeDeleteAllSubtasksDialog()
  }, [pendingBulkOperationParent, tasks, onTasksChange, closeDeleteAllSubtasksDialog])

  return {
    // Dialog state
    deleteParentDialogOpen,
    completeParentDialogOpen,
    parentPickerDialogOpen,
    allSubtasksCompleteDialogOpen,
    bulkDueDateDialogOpen,
    bulkPriorityDialogOpen,
    deleteAllSubtasksDialogOpen,

    // Dialog data
    pendingDeleteParent,
    pendingDeleteSubtaskCount,
    pendingCompleteParent,
    pendingCompleteIncompleteSubtasks,
    pendingDemoteTask,
    pendingAutoCompleteParent,
    pendingBulkOperationParent,
    pendingBulkOperationSubtasks,

    // Dialog handlers
    openDeleteParentDialog,
    closeDeleteParentDialog,
    confirmDeleteParent,

    openCompleteParentDialog,
    closeCompleteParentDialog,
    confirmCompleteParent,

    openParentPickerDialog,
    closeParentPickerDialog,
    confirmDemoteToSubtask,

    // All subtasks complete dialog handlers
    closeAllSubtasksCompleteDialog,
    keepParentOpen,
    autoCompleteParent,

    // Bulk operation dialog handlers
    openBulkDueDateDialog,
    closeBulkDueDateDialog,
    confirmBulkDueDate,

    openBulkPriorityDialog,
    closeBulkPriorityDialog,
    confirmBulkPriority,

    openDeleteAllSubtasksDialog,
    closeDeleteAllSubtasksDialog,
    confirmDeleteAllSubtasks,

    // Direct actions
    handleAddSubtask,
    handleBulkAddSubtasks,
    handleReorderSubtasks,
    handlePromoteToTask,
    handleDeleteSubtask,

    // Bulk actions
    handleCompleteAllSubtasks,
    handleMarkAllSubtasksIncomplete,

    // Smart actions
    handleDeleteTask,
    handleCompleteTask,
    handleCompleteSubtask,
  }
}

export default useSubtaskManagement


