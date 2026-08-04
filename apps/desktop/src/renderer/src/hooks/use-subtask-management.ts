import { useState, useCallback } from 'react'
import { toast } from 'sonner'

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
  type CreateSubtaskOptions
} from '@/lib/subtask-utils'
import {
  checkAllSubtasksComplete,
  completeAllSubtasks,
  markAllSubtasksIncomplete,
  setDueDateForAllSubtasks,
  setPriorityForAllSubtasks,
  deleteAllSubtasks,
  completeParentTask
} from '@/lib/subtask-bulk-utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useTaskSettings } from './use-task-settings'
import type { Task, Priority } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { getI18n } from 'react-i18next'

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
  onReorderTasks
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
  const [pendingCompleteIncompleteSubtasks, setPendingCompleteIncompleteSubtasks] = useState<
    Task[]
  >([])

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
        title
      }

      const result = createSubtask(options, tasks)

      if (result.success && result.updatedTasks && result.newTask) {
        // T038: Use database-aware callback if available
        if (onAddTask) {
          onAddTask(result.newTask)
        } else {
          onTasksChange(result.updatedTasks)
        }
        toast.success(getI18n().getFixedT(null, 'tasks')('phaseI.toasts.subtaskAdded'))
      } else {
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToAddSubtask')
          )
        )
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
        toast.success(
          getI18n().getFixedT(null, 'tasks')('toasts.subtasks.added', { count: titles.length })
        )
      } else {
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToAddSubtasks')
          )
        )
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
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToReorderSubtasks')
          )
        )
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
        toast.success(
          getI18n().getFixedT(null, 'tasks')('toasts.subtasks.promoted', {
            title: subtask?.title ?? ''
          })
        )
      } else {
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToPromoteSubtask')
          )
        )
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
        toast.success(getI18n().getFixedT(null, 'tasks')('phaseI.toasts.subtaskDeleted'), {
          description: getI18n().getFixedT(null, 'tasks')('toasts.subtasks.deletedDescription')
        })
      } else {
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToDeleteSubtask')
          )
        )
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

      const result = deleteParentWithSubtasks(pendingDeleteParent.id, keepSubtasks, tasks)

      if (result.success && result.updatedTasks) {
        onTasksChange(result.updatedTasks)
        const translate = getI18n().getFixedT(null, 'tasks')
        toast.success(
          keepSubtasks
            ? translate('toasts.subtasks.parentDeletedKeepSubtasks')
            : translate('toasts.subtasks.parentDeletedWithSubtasks')
        )
      } else {
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToDeleteTask')
          )
        )
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

      const result = completeParentWithSubtasks(pendingCompleteParent.id, completeSubtasks, tasks)

      if (result.success && result.updatedTasks) {
        onTasksChange(result.updatedTasks)
        const translate = getI18n().getFixedT(null, 'tasks')
        toast.success(
          completeSubtasks
            ? translate('toasts.subtasks.parentAndSubtasksCompleted')
            : translate('phaseI.toasts.taskCompleted')
        )
      } else {
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToCompleteTask')
          )
        )
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
        toast.success(
          getI18n().getFixedT(null, 'tasks')('toasts.subtasks.movedUnder', {
            title: parent?.title ?? ''
          })
        )
      } else {
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToMakeSubtask')
          )
        )
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
      toast.success(getI18n().getFixedT(null, 'tasks')('toasts.deleted'))
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
        const updatedTasks = tasks.map((t) => (t.id === taskId ? { ...t, completedAt: null } : t))
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
      toast.success(getI18n().getFixedT(null, 'tasks')('phaseI.toasts.taskCompleted'))
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
        const updatedTasks = tasks.map((t) => (t.id === subtaskId ? { ...t, completedAt: now } : t))
        onTasksChange(updatedTasks)
      }

      // For auto-complete parent logic, we need to work with updated tasks
      const updatedTasks = tasks.map((t) => (t.id === subtaskId ? { ...t, completedAt: now } : t))

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
              toast.success(
                getI18n().getFixedT(
                  null,
                  'tasks'
                )('phaseI.toasts.allSubtasksCompleteTaskMarkedAsDone'),
                {
                  duration: 10000, // T052: 10-second timeout for undo per spec
                  action: {
                    label: getI18n().getFixedT(null, 'common')('action.undo'),
                    onClick: () => {
                      onUpdateTask(parentId, { completedAt: null })
                      toast.success(
                        getI18n().getFixedT(null, 'tasks')('phaseI.toasts.taskReopened')
                      )
                    }
                  }
                }
              )
            } else {
              const result = completeParentTask(parentId, updatedTasks)
              if (result.success && result.updatedTasks) {
                onTasksChange(result.updatedTasks)
                toast.success(
                  getI18n().getFixedT(
                    null,
                    'tasks'
                  )('phaseI.toasts.allSubtasksCompleteTaskMarkedAsDone')
                )
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
    toast.success(getI18n().getFixedT(null, 'tasks')('phaseI.toasts.taskKeptOpen'))
  }, [closeAllSubtasksCompleteDialog])

  const autoCompleteParent = useCallback((): void => {
    if (!pendingAutoCompleteParent) return

    // Use database-aware callback if available
    if (onUpdateTask) {
      onUpdateTask(pendingAutoCompleteParent.id, { completedAt: new Date() })
      toast.success(getI18n().getFixedT(null, 'tasks')('phaseI.toasts.taskCompleted'))
    } else {
      const result = completeParentTask(pendingAutoCompleteParent.id, tasks)
      if (result.success && result.updatedTasks) {
        onTasksChange(result.updatedTasks)
        toast.success(getI18n().getFixedT(null, 'tasks')('phaseI.toasts.taskCompleted'))
      }
    }

    closeAllSubtasksCompleteDialog()
  }, [
    pendingAutoCompleteParent,
    tasks,
    onTasksChange,
    onUpdateTask,
    closeAllSubtasksCompleteDialog
  ])

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
        toast.success(
          getI18n().getFixedT(null, 'tasks')('toasts.subtasks.completed', {
            count: affectedCount
          })
        )

        // Check if we should auto-complete parent (with delay for celebration)
        const allComplete = checkAllSubtasksComplete(parentId, updatedTasks)

        if (allComplete && subtaskSettings.autoCompleteParent) {
          setTimeout(() => {
            if (onUpdateTask) {
              onUpdateTask(parentId, { completedAt: new Date() })
              toast.success(getI18n().getFixedT(null, 'tasks')('phaseI.toasts.taskMarkedAsDone'))
            } else {
              const completeResult = completeParentTask(parentId, updatedTasks)
              if (completeResult.success && completeResult.updatedTasks) {
                onTasksChange(completeResult.updatedTasks)
                toast.success(getI18n().getFixedT(null, 'tasks')('phaseI.toasts.taskMarkedAsDone'))
              }
            }
          }, 1500) // Wait 1.5 seconds for celebration animation
        }
      } else {
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToCompleteSubtasks')
          )
        )
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
        toast.success(
          getI18n().getFixedT(null, 'tasks')('toasts.subtasks.markedIncomplete', {
            count: affectedCount
          })
        )
      } else {
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToMarkSubtasksIncomplete')
          )
        )
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
        const translate = getI18n().getFixedT(null, 'tasks')
        const count = result.affectedCount ?? 0
        toast.success(
          dueDate
            ? translate('toasts.subtasks.dueDateSet', { count })
            : translate('toasts.subtasks.dueDateCleared', { count })
        )
      } else {
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToSetDueDate')
          )
        )
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
        toast.success(
          getI18n().getFixedT(null, 'tasks')('toasts.subtasks.prioritySet', {
            count: result.affectedCount ?? 0
          })
        )
      } else {
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToSetPriority')
          )
        )
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
      toast.success(
        getI18n().getFixedT(null, 'tasks')('toasts.subtasks.deleted', {
          count: result.affectedCount ?? 0
        })
      )
    } else {
      toast.error(
        extractErrorMessage(
          result.error,
          getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToDeleteSubtasks')
        )
      )
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
    handleCompleteSubtask
  }
}

export default useSubtaskManagement
