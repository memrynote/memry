import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'

import type { SubtaskTreeValue } from '@/components/tasks/subtask-tree/subtask-tree-context'
import { canHaveSubtasks, createSubtask, validateSubtaskRelationship } from '@/lib/subtask-utils'
import type { Task } from '@/data/task-model'

interface UseSubtaskTreeControllerOptions {
  tasks: Task[]
  allowNested: boolean
  contextIds: ReadonlySet<string>
  createTask: (task: Task) => void
  updateTask: (taskId: string, updates: Partial<Task>) => void
  onZoom: (taskId: string) => void
  openTask: (taskId: string) => void
  toggleComplete: (taskId: string) => void
  deleteTask: (taskId: string) => void
}

export interface SubtaskTreeController {
  value: SubtaskTreeValue
  /** The task the "Move under…" picker is open for. */
  moveUnderTaskId: string | null
  closeMoveUnder: () => void
}

/** The Tasks page's side of `SubtaskTreeContext`: one draft row and one picker at a time. */
export function useSubtaskTreeController({
  tasks,
  allowNested,
  contextIds,
  createTask,
  updateTask,
  onZoom,
  openTask,
  toggleComplete,
  deleteTask
}: UseSubtaskTreeControllerOptions): SubtaskTreeController {
  const [draftParentId, setDraftParentId] = useState<string | null>(null)
  const [moveUnderTaskId, setMoveUnderTaskId] = useState<string | null>(null)

  const canAddUnder = useCallback(
    (parentId: string): boolean => {
      const parent = tasks.find((t) => t.id === parentId)
      return parent !== undefined && canHaveSubtasks(parent, allowNested)
    },
    [tasks, allowNested]
  )

  const addSubtask = useCallback(
    (parentId: string, title: string): void => {
      const result = createSubtask({ parentId, title, allowNested }, tasks)
      if (result.success && result.newTask) {
        createTask(result.newTask)
        return
      }
      toast.error(getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToAddSubtask'))
    },
    [tasks, allowNested, createTask]
  )

  const canMoveUnder = useCallback(
    (taskId: string, parentId: string | null): boolean =>
      parentId === null || validateSubtaskRelationship(parentId, taskId, tasks, allowNested).valid,
    [tasks, allowNested]
  )

  const moveUnder = useCallback(
    (taskId: string, parentId: string | null): void => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task || task.parentId === parentId) return
      if (!canMoveUnder(taskId, parentId)) {
        toast.error(getI18n().getFixedT(null, 'errors')('task.invalidParent'))
        return
      }
      updateTask(taskId, { parentId })
    },
    [tasks, canMoveUnder, updateTask]
  )

  const value = useMemo<SubtaskTreeValue>(
    () => ({
      allowNested,
      contextIds,
      draftParentId,
      openDraft: setDraftParentId,
      closeDraft: (parentId?: string) =>
        setDraftParentId((current) =>
          parentId === undefined || current === parentId ? null : current
        ),
      canAddUnder,
      addSubtask,
      canMoveUnder,
      moveUnder,
      openMoveUnder: setMoveUnderTaskId,
      zoomInto: onZoom,
      parentOf: (taskId: string) => tasks.find((t) => t.id === taskId)?.parentId ?? null,
      openTask,
      toggleComplete,
      deleteTask
    }),
    [
      allowNested,
      contextIds,
      draftParentId,
      canAddUnder,
      addSubtask,
      canMoveUnder,
      moveUnder,
      onZoom,
      tasks,
      openTask,
      toggleComplete,
      deleteTask
    ]
  )

  return { value, moveUnderTaskId, closeMoveUnder: () => setMoveUnderTaskId(null) }
}
