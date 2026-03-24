import { useCallback } from 'react'
import { toast } from 'sonner'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import { getDefaultTodoStatus, getDefaultDoneStatus } from '@/lib/task-utils'
import { getSubtasks } from '@/lib/subtask-utils'
import { calculateNextOccurrence, shouldCreateNextOccurrence } from '@/lib/repeat-utils'
import { generateTaskId } from '@/data/sample-tasks'
import { formatDateShort } from '@/lib/task-utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:UndoableTaskActions')

export const UNDOABLE_FIELDS = new Set([
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
  addTask: (task: Task) => void
  updateTask: (taskId: string, updates: Partial<Task>) => void
  deleteTask: (taskId: string) => void
  registerUndo: (description: string, undoFn: () => void) => string
  removeUndoEntry: (id: string) => void
}

export interface UseUndoableTaskActionsReturn {
  createTask: (task: Task) => void
  deleteTask: (taskId: string) => void
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
    (task: Task): void => {
      addTask(task)
      registerUndo(`Create "${task.title}"`, () => {
        deleteTask(task.id)
      })
    },
    [addTask, deleteTask, registerUndo]
  )

  // ========== DELETE ==========

  const deleteTaskWithUndo = useCallback(
    (taskId: string): void => {
      const task = findTask(taskId)
      if (!task) return

      const snapshot = { ...task }
      deleteTask(taskId)

      const undoId = registerUndo(`Delete "${task.title}"`, () => {
        addTask(snapshot)
      })

      toast.success('Task deleted', {
        description: `"${task.title}" has been deleted.`,
        duration: 10000,
        action: {
          label: 'Undo',
          onClick: () => {
            removeUndoEntry(undoId)
            addTask(snapshot)
          }
        }
      })
    },
    [findTask, deleteTask, addTask, registerUndo, removeUndoEntry]
  )

  // ========== COMPLETE ==========

  const completeTaskWithUndo = useCallback(
    (taskId: string): void => {
      const task = findTask(taskId)
      if (!task) return

      const project = findProject(task.projectId)
      if (!project) return

      const currentStatus = project.statuses.find((s) => s.id === task.statusId)
      if (!currentStatus) return

      if (currentStatus.type === 'done') {
        return
      }

      const doneStatus = getDefaultDoneStatus(project)
      const completedAt = new Date()

      const subtasks = getSubtasks(taskId, tasks)
      const incompleteSubtasks = subtasks.filter((s) => !s.completedAt)

      const subtaskSnapshots = incompleteSubtasks.map((s) => ({
        id: s.id,
        statusId: s.statusId,
        completedAt: s.completedAt
      }))

      if (task.isRepeating && task.repeatConfig && task.dueDate) {
        const config = task.repeatConfig
        const newCompletedCount = config.completedCount + 1
        const nextDate = calculateNextOccurrence(task.dueDate, config)
        const shouldCreate = shouldCreateNextOccurrence({
          ...config,
          completedCount: newCompletedCount
        })

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
            repeatConfig: {
              ...config,
              completedCount: newCompletedCount
            }
          }
          nextOccurrenceId = newTask.id
          addTask(newTask)
          toast.success('Task completed!', {
            description: `Next occurrence: ${formatDateShort(nextDate)}`
          })
        } else {
          toast.success('Series complete!', {
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

        if (incompleteSubtasks.length > 0) {
          toast.success('Task completed!', {
            description: `Also marked ${incompleteSubtasks.length} subtask(s) as done.`
          })
        }

        registerUndo(`Complete "${task.title}"`, () => {
          updateTask(taskId, {
            statusId: task.statusId,
            completedAt: null
          })
          subtaskSnapshots.forEach((snap) => {
            updateTask(snap.id, { statusId: snap.statusId, completedAt: snap.completedAt })
          })
        })
      }
    },
    [findTask, findProject, tasks, updateTask, addTask, deleteTask, registerUndo]
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

      registerUndo(`Uncomplete "${task.title}"`, () => {
        updateTask(taskId, {
          statusId: prevStatusId,
          completedAt: prevCompletedAt
        })
      })
    },
    [findTask, findProject, updateTask, registerUndo]
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
        undoableKeys[0] === 'priority'
          ? `Priority → ${String((updates as Partial<Task>).priority ?? '')}`
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
