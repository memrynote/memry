import { useCallback } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { getDefaultTodoStatus, getDefaultDoneStatus, formatDateShort } from '@/lib/task-utils'
import { buildTaskTree } from '@memry/domain-tasks/tree'
import { completeRepeatingTask } from '@memry/domain-tasks/parsing'
import { generateTaskId } from '@/data/task-model'
import { createLogger } from '@/lib/logger'

const _log = createLogger('Hook:UndoableTaskActions')

export const UNDOABLE_FIELDS = new Set([
  'parentId',
  'priority',
  'statusId',
  'dueDate',
  'dueTime',
  'projectId',
  'archivedAt'
])

export interface UseUndoableTaskActionsOptions {
  tasks: Task[]
  projects: Project[]
  /** May resolve with the stored task id; `createTask` passes it through. */
  addTask: (task: Task) => void | Promise<string | null>
  updateTask: (taskId: string, updates: Partial<Task>) => void
  deleteTask: (taskId: string) => void
  registerUndo: (description: string, undoFn: () => void) => string
  removeUndoEntry: (id: string) => void
}

export interface UseUndoableTaskActionsReturn {
  /** Resolves with the stored task id when `addTask` reports one, else null. */
  createTask: (task: Task) => Promise<string | null>
  /** `subtasks`: what happens to the task's subtasks (default: deleted with it). */
  deleteTask: (taskId: string, subtasks?: 'keep' | 'delete') => void
  completeTask: (taskId: string) => void
  uncompleteTask: (taskId: string) => void
  archiveTask: (taskId: string) => void
  updateTaskWithUndo: (taskId: string, updates: Partial<Task>) => void
}

export const useUndoableTaskActions = ({
  tasks,
  projects,
  addTask,
  updateTask,
  deleteTask,
  registerUndo,
  removeUndoEntry
}: UseUndoableTaskActionsOptions): UseUndoableTaskActionsReturn => {
  const { t } = useT('tasks')
  const { t: tCommon } = useT('common')

  const findTask = useCallback(
    (taskId: string): Task | undefined => tasks.find((t) => t.id === taskId),
    [tasks]
  )

  const findProject = useCallback(
    (projectId: string): Project | undefined => projects.find((p) => p.id === projectId),
    [projects]
  )

  // ========== CREATE ==========

  const createTaskWithUndo = useCallback(
    (task: Task): Promise<string | null> => {
      const created = addTask(task)
      registerUndo(`Create "${task.title}"`, () => {
        deleteTask(task.id)
      })
      return created instanceof Promise ? created : Promise.resolve(null)
    },
    [addTask, deleteTask, registerUndo]
  )

  // ========== DELETE ==========

  const deleteTaskWithUndo = useCallback(
    (taskId: string, subtasks: 'keep' | 'delete' = 'delete'): void => {
      const task = findTask(taskId)
      if (!task) return

      const snapshot = { ...task }
      const tree = buildTaskTree(tasks)
      const children = tree.childrenOf(taskId)
      // Parent before child, so an undo can recreate them top-down.
      const branch =
        subtasks === 'delete'
          ? tree
              .descendantIds(taskId)
              .map((id) => findTask(id))
              .filter((t): t is Task => t !== undefined)
          : []

      if (subtasks === 'keep') {
        // The direct subtasks take the deleted task's place, one level up.
        for (const child of children) updateTask(child.id, { parentId: task.parentId })
      } else {
        for (const descendant of [...branch].reverse()) deleteTask(descendant.id)
      }
      deleteTask(taskId)

      // Recreating gives new ids, so children are re-pointed at the new parent.
      const undo = async (): Promise<void> => {
        const newId = await addTask(snapshot)
        if (!newId) return
        if (subtasks === 'keep') {
          for (const child of children) updateTask(child.id, { parentId: newId })
          return
        }
        const ids = new Map([[taskId, newId]])
        for (const descendant of branch) {
          const parentId = descendant.parentId ? (ids.get(descendant.parentId) ?? null) : null
          const recreated = await addTask({ ...descendant, parentId, subtaskIds: [] })
          if (recreated) ids.set(descendant.id, recreated)
        }
      }

      const undoId = registerUndo(`Delete "${task.title}"`, () => void undo())

      toast.success(
        children.length === 0
          ? t('toasts.deleted')
          : subtasks === 'keep'
            ? t('toasts.deletedKeepSubtasks', { title: task.title })
            : t('toasts.deletedBranch', { title: task.title, count: branch.length }),
        {
          description: children.length === 0 ? `"${task.title}" has been deleted.` : undefined,
          duration: 10000,
          action: {
            label: tCommon('action.undo'),
            onClick: () => {
              removeUndoEntry(undoId)
              void undo()
            }
          }
        }
      )
    },
    [findTask, tasks, deleteTask, addTask, updateTask, registerUndo, removeUndoEntry, t, tCommon]
  )

  // ========== COMPLETE ==========

  const completeTaskWithUndo = useCallback(
    (taskId: string): void => {
      const task = findTask(taskId)
      if (!task) return

      const project = findProject(task.projectId)
      if (!project) return

      const currentStatus = project.statuses.find((s) => s.id === task.statusId)
      // A task whose status is gone (`status_id` is ON DELETE SET NULL) is still
      // completable; `completedAt` says whether it already is.
      if (currentStatus?.type === 'done' || task.completedAt) {
        return
      }

      const doneStatus = getDefaultDoneStatus(project)
      const completedAt = new Date()

      // The whole branch, at any depth: a done row never hides open work.
      const byId = new Map(tasks.map((t) => [t.id, t]))
      const incompleteSubtasks = buildTaskTree(tasks)
        .descendantIds(taskId)
        .map((id) => byId.get(id))
        .filter((s): s is Task => s !== undefined && !s.completedAt)

      const subtaskSnapshots = incompleteSubtasks.map((s) => ({
        id: s.id,
        statusId: s.statusId,
        completedAt: s.completedAt
      }))

      if (task.isRepeating && task.repeatConfig && task.dueDate) {
        const config = task.repeatConfig
        // The anchor (due vs completion), the next date and the series end are
        // `completeRepeatingTask`, pinned for the iOS core by vectors (spec 004 D3).
        const { nextDueDate: nextDate, completedCount: newCompletedCount } = completeRepeatingTask(
          { dueDate: task.dueDate, repeatConfig: config, repeatFrom: task.repeatFrom },
          completedAt
        )
        const shouldCreate = nextDate !== null

        updateTask(taskId, {
          statusId: doneStatus?.id || task.statusId,
          completedAt,
          isRepeating: false,
          repeatConfig: null
        })

        incompleteSubtasks.forEach((subtask) => {
          updateTask(subtask.id, {
            statusId: doneStatus?.id || subtask.statusId,
            completedAt
          })
        })

        let nextOccurrenceId: string | null = null

        if (shouldCreate && nextDate) {
          const newTask: Task = {
            ...task,
            id: generateTaskId(),
            dueDate: nextDate,
            statusId: getDefaultTodoStatus(project)?.id || task.statusId,
            completedAt: null,
            createdAt: new Date(),
            // The subtasks that just closed stay attached to the occurrence
            // that owned them, so the fresh one starts empty rather than
            // briefly listing the previous cycle's finished rows.
            subtaskIds: [],
            repeatConfig: {
              ...config,
              completedCount: newCompletedCount
            }
          }
          nextOccurrenceId = newTask.id
          void addTask(newTask)
          toast.success(t('toasts.completed'), {
            description: `Next occurrence: ${formatDateShort(nextDate)}`
          })
        } else {
          toast.success(t('toasts.deletedSeries'), {
            description: 'This was the final occurrence.'
          })
        }

        const originalSnapshot = {
          statusId: task.statusId,
          completedAt: task.completedAt,
          isRepeating: task.isRepeating,
          repeatConfig: task.repeatConfig
        }

        registerUndo(`Complete "${task.title}"`, () => {
          updateTask(taskId, originalSnapshot)
          subtaskSnapshots.forEach((snap) => {
            updateTask(snap.id, { statusId: snap.statusId, completedAt: snap.completedAt })
          })
          if (nextOccurrenceId) {
            deleteTask(nextOccurrenceId)
          }
        })
      } else {
        updateTask(taskId, {
          statusId: doneStatus?.id || task.statusId,
          completedAt
        })

        incompleteSubtasks.forEach((subtask) => {
          updateTask(subtask.id, {
            statusId: doneStatus?.id || subtask.statusId,
            completedAt
          })
        })

        const undo = (): void => {
          updateTask(taskId, {
            statusId: task.statusId,
            completedAt: null
          })
          subtaskSnapshots.forEach((snap) => {
            updateTask(snap.id, { statusId: snap.statusId, completedAt: snap.completedAt })
          })
        }
        const undoId = registerUndo(`Complete "${task.title}"`, undo)

        if (incompleteSubtasks.length > 0) {
          toast.success(
            t('toasts.completedBranch', { title: task.title, count: incompleteSubtasks.length }),
            {
              duration: 10000,
              action: {
                label: tCommon('action.undo'),
                onClick: () => {
                  removeUndoEntry(undoId)
                  undo()
                }
              }
            }
          )
        }
      }
    },
    [
      findTask,
      findProject,
      tasks,
      updateTask,
      addTask,
      deleteTask,
      registerUndo,
      removeUndoEntry,
      t,
      tCommon
    ]
  )

  // ========== UNCOMPLETE ==========

  const uncompleteTaskWithUndo = useCallback(
    (taskId: string): void => {
      const task = findTask(taskId)
      if (!task) return

      const project = findProject(task.projectId)
      if (!project) return

      const prevStatusId = task.statusId
      const prevCompletedAt = task.completedAt

      const todoStatus = getDefaultTodoStatus(project)
      updateTask(taskId, {
        statusId: todoStatus?.id || task.statusId,
        completedAt: null
      })

      // Reopening work under a done task reopens that task too, all the way up.
      const reopenedAncestors = buildTaskTree(tasks)
        .ancestorIds(taskId)
        .map((id) => findTask(id))
        .filter((ancestor): ancestor is Task => ancestor !== undefined && !!ancestor.completedAt)
      for (const ancestor of reopenedAncestors) {
        updateTask(ancestor.id, {
          statusId: todoStatus?.id || ancestor.statusId,
          completedAt: null
        })
      }

      registerUndo(`Uncomplete "${task.title}"`, () => {
        updateTask(taskId, {
          statusId: prevStatusId,
          completedAt: prevCompletedAt
        })
        for (const ancestor of reopenedAncestors) {
          updateTask(ancestor.id, {
            statusId: ancestor.statusId,
            completedAt: ancestor.completedAt
          })
        }
      })
    },
    [findTask, findProject, tasks, updateTask, registerUndo]
  )

  // ========== ARCHIVE ==========

  const archiveTaskWithUndo = useCallback(
    (taskId: string): void => {
      const task = findTask(taskId)
      if (!task) return

      updateTask(taskId, { archivedAt: new Date() })

      registerUndo(`Archive "${task.title}"`, () => {
        updateTask(taskId, { archivedAt: null })
      })
    },
    [findTask, updateTask, registerUndo]
  )

  // ========== UPDATE (discrete fields only) ==========

  const updateTaskWithUndo = useCallback(
    (taskId: string, updates: Partial<Task>): void => {
      const task = findTask(taskId)

      updateTask(taskId, updates)

      if (!task) return

      const undoableKeys = Object.keys(updates).filter((k) => UNDOABLE_FIELDS.has(k))
      if (undoableKeys.length === 0) return

      const previousValues: Partial<Task> = {}
      for (const key of undoableKeys) {
        ;(previousValues as Record<string, unknown>)[key] = (
          task as unknown as Record<string, unknown>
        )[key]
      }

      const fieldLabel =
        undoableKeys[0] === 'parentId'
          ? 'Moved'
          : undoableKeys[0] === 'priority'
            ? `Priority → ${String(updates.priority ?? '')}`
            : undoableKeys[0] === 'statusId'
              ? 'Status changed'
              : undoableKeys[0] === 'dueDate'
                ? 'Due date changed'
                : undoableKeys[0] === 'projectId'
                  ? 'Moved to project'
                  : 'Task updated'

      registerUndo(fieldLabel, () => {
        updateTask(taskId, previousValues)
      })
    },
    [findTask, updateTask, registerUndo]
  )

  return {
    createTask: createTaskWithUndo,
    deleteTask: deleteTaskWithUndo,
    completeTask: completeTaskWithUndo,
    uncompleteTask: uncompleteTaskWithUndo,
    archiveTask: archiveTaskWithUndo,
    updateTaskWithUndo
  }
}
