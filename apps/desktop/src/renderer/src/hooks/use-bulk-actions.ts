import { useCallback } from 'react'
import { createLogger } from '@/lib/logger'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'
import { getI18n } from 'react-i18next'

const log = createLogger('Hook:BulkActions')

import type { Task, Priority } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { getDefaultTodoStatus, getDefaultDoneStatus } from '@/lib/task-utils'
import { tasksService } from '@/services/tasks-service'
import { useVault } from '@/hooks/use-vault'

// ============================================================================
// TYPES
// ============================================================================

export interface UseBulkActionsOptions {
  selectedIds: string[]
  tasks: Task[]
  projects: Project[]
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void
  onDeleteTask: (taskId: string) => void
  onComplete: () => void
  registerUndo?: (description: string, undoFn: () => void) => string
  onAddTask?: (task: Task) => void
}

export interface UseBulkActionsReturn {
  bulkComplete: () => void | Promise<void>
  bulkUncomplete: () => void
  bulkChangePriority: (priority: Priority) => void
  bulkChangeDueDate: (dueDate: Date | null) => void
  bulkMoveToProject: (projectId: string) => void | Promise<void>
  bulkChangeStatus: (statusId: string) => void
  bulkArchive: () => void | Promise<void>
  bulkDelete: () => void | Promise<void>
  getSelectedTasks: () => Task[]
}

// ============================================================================
// HOOK
// ============================================================================

export const useBulkActions = ({
  selectedIds,
  tasks,
  projects,
  onUpdateTask,
  onDeleteTask,
  onComplete,
  registerUndo,
  onAddTask
}: UseBulkActionsOptions): UseBulkActionsReturn => {
  const { status } = useVault()
  const isVaultOpen = status?.isOpen ?? false
  const { t } = useT('tasks')

  // ========== HELPERS ==========

  const getSelectedTasks = useCallback((): Task[] => {
    return tasks.filter((task) => selectedIds.includes(task.id))
  }, [tasks, selectedIds])

  // ========== BULK ACTIONS ==========

  const bulkComplete = useCallback(async (): Promise<void> => {
    const selectedTasks = getSelectedTasks()
    const tasksToComplete = selectedTasks.filter((task) => {
      const project = projects.find((p) => p.id === task.projectId)
      if (!project) return false
      const status = project.statuses.find((s) => s.id === task.statusId)
      return status?.type !== 'done'
    })

    if (tasksToComplete.length === 0) {
      toast.info(t('toasts.alreadyAllComplete'))
      return
    }

    const originalStates = tasksToComplete.map((task) => ({
      id: task.id,
      statusId: task.statusId,
      completedAt: task.completedAt
    }))

    const taskIds = tasksToComplete.map((t) => t.id)

    if (isVaultOpen) {
      try {
        const result = await tasksService.bulkComplete(taskIds)
        if (!result.success) {
          toast.error(extractErrorMessage(result.error, t('toasts.completeFailed')))
          return
        }
      } catch (error) {
        log.error('bulkComplete backend error:', error)
        toast.error(t('toasts.completeFailed'))
        return
      }
    } else {
      const now = new Date()
      tasksToComplete.forEach((task) => {
        const project = projects.find((p) => p.id === task.projectId)
        if (!project) return

        const doneStatus = getDefaultDoneStatus(project)
        if (doneStatus) {
          onUpdateTask(task.id, {
            statusId: doneStatus.id,
            completedAt: now
          })
        }
      })
    }

    const undoRestore = () => {
      originalStates.forEach((state) => {
        onUpdateTask(state.id, {
          statusId: state.statusId,
          completedAt: state.completedAt
        })
      })
    }

    const count = tasksToComplete.length
    const desc = t('toasts.bulk.undoComplete', { count })

    if (registerUndo) {
      registerUndo(desc, undoRestore)
    }

    toast.success(t('toasts.bulk.completed', { count }), {
      duration: 10000,
      action: {
        label: getI18n().getFixedT(null, 'common')('action.undo'),
        onClick: () => {
          undoRestore()
          toast.success(getI18n().getFixedT(null, 'tasks')('phaseI.toasts.changesUndone'))
        }
      }
    })

    onComplete()
  }, [getSelectedTasks, projects, onUpdateTask, onComplete, isVaultOpen, registerUndo, t])

  const bulkUncomplete = useCallback((): void => {
    const selectedTasks = getSelectedTasks()
    const tasksToUncomplete = selectedTasks.filter((task) => {
      const project = projects.find((p) => p.id === task.projectId)
      if (!project) return false
      const status = project.statuses.find((s) => s.id === task.statusId)
      return status?.type === 'done'
    })

    if (tasksToUncomplete.length === 0) {
      toast.info(t('toasts.noCompletedSelected'))
      return
    }

    const originalStates = tasksToUncomplete.map((task) => ({
      id: task.id,
      statusId: task.statusId,
      completedAt: task.completedAt
    }))

    tasksToUncomplete.forEach((task) => {
      const project = projects.find((p) => p.id === task.projectId)
      if (!project) return

      const todoStatus = getDefaultTodoStatus(project)
      if (todoStatus) {
        onUpdateTask(task.id, {
          statusId: todoStatus.id,
          completedAt: null
        })
      }
    })

    const count = tasksToUncomplete.length

    if (registerUndo) {
      registerUndo(t('toasts.bulk.undoUncomplete', { count }), () => {
        originalStates.forEach((state) => {
          onUpdateTask(state.id, {
            statusId: state.statusId,
            completedAt: state.completedAt
          })
        })
      })
    }

    toast.success(t('toasts.bulk.restored', { count }))
    onComplete()
  }, [getSelectedTasks, projects, onUpdateTask, onComplete, registerUndo, t])

  const bulkChangePriority = useCallback(
    (priority: Priority): void => {
      const count = selectedIds.length
      if (count === 0) return

      const originalPriorities = selectedIds.map((taskId) => {
        const task = tasks.find((t) => t.id === taskId)
        return { id: taskId, priority: task?.priority ?? ('none' as Priority) }
      })

      selectedIds.forEach((taskId) => {
        onUpdateTask(taskId, { priority })
      })

      const priorityMessage =
        priority === 'none'
          ? t('toasts.bulk.priorityRemoved', { count })
          : t('toasts.bulk.prioritySet', { count, priority: t(`priorityInline.${priority}`) })

      if (registerUndo) {
        registerUndo(priorityMessage, () => {
          originalPriorities.forEach((snap) => {
            onUpdateTask(snap.id, { priority: snap.priority })
          })
        })
      }

      toast.success(priorityMessage)
      onComplete()
    },
    [selectedIds, tasks, onUpdateTask, onComplete, registerUndo, t]
  )

  const bulkChangeDueDate = useCallback(
    (dueDate: Date | null): void => {
      const count = selectedIds.length
      if (count === 0) return

      const originalDates = selectedIds.map((taskId) => {
        const task = tasks.find((t) => t.id === taskId)
        return { id: taskId, dueDate: task?.dueDate ?? null }
      })

      selectedIds.forEach((taskId) => {
        onUpdateTask(taskId, { dueDate })
      })

      if (registerUndo) {
        registerUndo(t('toasts.bulk.undoDueDate', { count }), () => {
          originalDates.forEach((snap) => {
            onUpdateTask(snap.id, { dueDate: snap.dueDate })
          })
        })
      }

      const message = dueDate
        ? t('toasts.bulk.dueDateSet', { count })
        : t('toasts.bulk.dueDateRemoved', { count })

      toast.success(message)
      onComplete()
    },
    [selectedIds, tasks, onUpdateTask, onComplete, registerUndo, t]
  )

  const bulkMoveToProject = useCallback(
    async (projectId: string): Promise<void> => {
      const count = selectedIds.length
      if (count === 0) return

      const targetProject = projects.find((p) => p.id === projectId)
      if (!targetProject) {
        toast.error(getI18n().getFixedT(null, 'tasks')('phaseI.toasts.projectNotFound'))
        return
      }

      const originalMoveStates = selectedIds.map((taskId) => {
        const task = tasks.find((t) => t.id === taskId)
        return {
          id: taskId,
          projectId: task?.projectId ?? '',
          statusId: task?.statusId ?? '',
          completedAt: task?.completedAt ?? null
        }
      })

      if (isVaultOpen) {
        try {
          const result = await tasksService.bulkMove(selectedIds, projectId)
          if (!result.success) {
            toast.error(extractErrorMessage(result.error, t('toasts.moveFailed')))
            return
          }
        } catch (error) {
          log.error('bulkMoveToProject backend error:', error)
          toast.error(t('toasts.moveFailed'))
          return
        }
      } else {
        const defaultStatus = getDefaultTodoStatus(targetProject)

        selectedIds.forEach((taskId) => {
          const task = tasks.find((t) => t.id === taskId)
          if (!task) return

          const currentProject = projects.find((p) => p.id === task.projectId)
          const currentStatus = currentProject?.statuses.find((s) => s.id === task.statusId)
          const currentStatusType = currentStatus?.type || 'todo'

          let newStatus = targetProject.statuses.find((s) => s.type === currentStatusType)
          if (!newStatus) {
            newStatus = defaultStatus
          }

          const updates: Partial<Task> = {
            projectId,
            statusId: newStatus?.id || targetProject.statuses[0]?.id
          }

          if (newStatus?.type === 'done' && !task.completedAt) {
            updates.completedAt = new Date()
          } else if (newStatus?.type !== 'done' && task.completedAt) {
            updates.completedAt = null
          }

          onUpdateTask(taskId, updates)
        })
      }

      if (registerUndo) {
        registerUndo(t('toasts.bulk.undoMove', { count }), () => {
          originalMoveStates.forEach((snap) => {
            onUpdateTask(snap.id, {
              projectId: snap.projectId,
              statusId: snap.statusId,
              completedAt: snap.completedAt
            })
          })
        })
      }

      toast.success(t('toasts.bulk.movedToProject', { count, project: targetProject.name }))
      onComplete()
    },
    [selectedIds, tasks, projects, onUpdateTask, onComplete, isVaultOpen, registerUndo, t]
  )

  const bulkChangeStatus = useCallback(
    (statusId: string): void => {
      const count = selectedIds.length
      if (count === 0) return

      let statusName = ''
      let statusType: 'todo' | 'in_progress' | 'done' = 'todo'

      for (const project of projects) {
        const status = project.statuses.find((s) => s.id === statusId)
        if (status) {
          statusName = status.name
          statusType = status.type
          break
        }
      }

      const originalStatusStates = selectedIds.map((taskId) => {
        const task = tasks.find((t) => t.id === taskId)
        return {
          id: taskId,
          statusId: task?.statusId ?? '',
          completedAt: task?.completedAt ?? null
        }
      })

      selectedIds.forEach((taskId) => {
        const task = tasks.find((t) => t.id === taskId)
        if (!task) return

        const updates: Partial<Task> = { statusId }

        if (statusType === 'done' && !task.completedAt) {
          updates.completedAt = new Date()
        } else if (statusType !== 'done' && task.completedAt) {
          updates.completedAt = null
        }

        onUpdateTask(taskId, updates)
      })

      if (registerUndo) {
        registerUndo(t('toasts.bulk.undoStatus', { count, status: statusName }), () => {
          originalStatusStates.forEach((snap) => {
            onUpdateTask(snap.id, {
              statusId: snap.statusId,
              completedAt: snap.completedAt
            })
          })
        })
      }

      toast.success(t('toasts.bulk.movedToStatus', { count, status: statusName }))
      onComplete()
    },
    [selectedIds, tasks, projects, onUpdateTask, onComplete, registerUndo, t]
  )

  const bulkArchive = useCallback(async (): Promise<void> => {
    const count = selectedIds.length
    if (count === 0) return

    const archivedIds = [...selectedIds]

    if (isVaultOpen) {
      try {
        const result = await tasksService.bulkArchive(selectedIds)
        if (!result.success) {
          toast.error(
            extractErrorMessage(
              result.error,
              getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToArchiveTasks')
            )
          )
          return
        }
      } catch (error) {
        log.error('bulkArchive backend error:', error)
        toast.error(getI18n().getFixedT(null, 'tasks')('phaseI.toasts.failedToArchiveTasks'))
        return
      }
    } else {
      const now = new Date()
      selectedIds.forEach((taskId) => {
        onUpdateTask(taskId, { archivedAt: now })
      })
    }

    const undoRestore = () => {
      archivedIds.forEach((taskId) => {
        onUpdateTask(taskId, { archivedAt: null })
      })
    }

    const desc = t('toasts.bulk.undoArchive', { count })

    if (registerUndo) {
      registerUndo(desc, undoRestore)
    }

    toast.success(t('toasts.bulk.archived', { count }), {
      duration: 10000,
      action: {
        label: getI18n().getFixedT(null, 'common')('action.undo'),
        onClick: () => {
          undoRestore()
          toast.success(
            getI18n().getFixedT(null, 'tasks')('phaseI.toasts.tasksRestoredFromArchive')
          )
        }
      }
    })

    onComplete()
  }, [selectedIds, onUpdateTask, onComplete, isVaultOpen, registerUndo, t])

  const bulkDelete = useCallback(async (): Promise<void> => {
    const count = selectedIds.length
    if (count === 0) return

    const deletedSnapshots = selectedIds
      .map((taskId) => {
        const task = tasks.find((t) => t.id === taskId)
        return task ? { ...task } : null
      })
      .filter(Boolean) as Task[]

    if (isVaultOpen) {
      try {
        const result = await tasksService.bulkDelete(selectedIds)
        if (!result.success) {
          toast.error(extractErrorMessage(result.error, t('toasts.deleteFailed')))
          return
        }
      } catch (error) {
        log.error('bulkDelete backend error:', error)
        toast.error(t('toasts.deleteFailed'))
        return
      }
    } else {
      selectedIds.forEach((taskId) => {
        onDeleteTask(taskId)
      })
    }

    if (registerUndo && onAddTask && deletedSnapshots.length > 0) {
      registerUndo(t('toasts.bulk.undoDelete', { count }), () => {
        deletedSnapshots.forEach((snapshot) => {
          onAddTask(snapshot)
        })
      })
    }

    toast.success(t('toasts.bulk.deleted', { count }), {
      description: t('toasts.bulk.deletedDescription')
    })

    onComplete()
  }, [selectedIds, tasks, onDeleteTask, onComplete, isVaultOpen, registerUndo, onAddTask, t])

  return {
    bulkComplete,
    bulkUncomplete,
    bulkChangePriority,
    bulkChangeDueDate,
    bulkMoveToProject,
    bulkChangeStatus,
    bulkArchive,
    bulkDelete,
    getSelectedTasks
  }
}

export default useBulkActions
