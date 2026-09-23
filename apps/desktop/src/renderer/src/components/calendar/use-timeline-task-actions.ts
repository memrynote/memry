import { useCallback, useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTasksOptional } from '@/contexts/tasks'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { useUndoTracker } from '@/hooks/use-undo'
import { useUndoableTaskActions } from '@/hooks/use-undoable-task-actions'
import { parseLocalDate } from './date-utils'
import type { TimelineDates } from './timeline-model'

const NO_TASKS: Task[] = []
const NO_PROJECTS: Project[] = []
const noop = (): void => {}

export interface TimelineTaskActions {
  tasks: Task[]
  projects: Project[]
  /** Writes both dates at once; undo restores the dates and time it replaced. */
  setDates: (task: Task, dates: TimelineDates) => void
  complete: (taskId: string) => void
  uncomplete: (taskId: string) => void
  moveToProject: (taskId: string, projectId: string) => void
}

function toDate(value: string | null): Date | null {
  return value === null ? null : parseLocalDate(value)
}

function sameDay(a: Date | null | undefined, b: Date | null): boolean {
  if (!a || !b) return !a && !b
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * Every write the timeline makes to a task, each undoable with Cmd+Z. Goes
 * through the workspace's optimistic `updateTask`, so a bar lands where it was
 * dropped before the round trip finishes.
 */
export function useTimelineTaskActions(): TimelineTaskActions {
  const { t } = useT('calendar')
  const context = useTasksOptional()
  const { registerUndo, removeUndoEntry } = useUndoTracker()
  const tasks = context?.tasks ?? NO_TASKS
  const projects = context?.projects ?? NO_PROJECTS
  const updateTask = context?.updateTask

  const undoable = useUndoableTaskActions({
    tasks,
    projects,
    addTask: (task) => void context?.addTask(task),
    updateTask: (taskId, updates) => void updateTask?.(taskId, updates),
    deleteTask: (taskId) => void context?.deleteTask(taskId),
    registerUndo,
    removeUndoEntry
  })

  const setDates = useCallback(
    (task: Task, dates: TimelineDates): void => {
      if (!updateTask) return
      const startDate = toDate(dates.startDate)
      const dueDate = toDate(dates.dueDate)
      if (sameDay(task.startDate, startDate) && sameDay(task.dueDate, dueDate)) return
      const previous: Partial<Task> = {
        startDate: task.startDate ?? null,
        dueDate: task.dueDate,
        dueTime: task.dueTime
      }
      // A time without a day means nothing, so it goes with the due date.
      const updates: Partial<Task> = dueDate
        ? { startDate, dueDate }
        : { startDate, dueDate, dueTime: null }
      void updateTask(task.id, updates)
      registerUndo(t('timeline.undo.reschedule', { title: task.title }), () => {
        void updateTask(task.id, previous)
      })
    },
    [updateTask, registerUndo, t]
  )

  const moveToProject = useCallback(
    (taskId: string, projectId: string): void => {
      undoable.updateTaskWithUndo(taskId, { projectId })
    },
    [undoable]
  )

  return useMemo(
    () => ({
      tasks,
      projects,
      setDates: updateTask ? setDates : noop,
      complete: undoable.completeTask,
      uncomplete: undoable.uncompleteTask,
      moveToProject
    }),
    [
      tasks,
      projects,
      updateTask,
      setDates,
      undoable.completeTask,
      undoable.uncompleteTask,
      moveToProject
    ]
  )
}
