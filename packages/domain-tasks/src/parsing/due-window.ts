/**
 * Task view membership: the Tasks page's All / Today / Tomorrow / Next 7 days /
 * Archived scopes and their tab counts (spec 004 D4).
 *
 * Moved from the renderer's `task-view-helpers.ts`. Generic over the task and
 * project shapes, so the renderer's own `Task` flows through unchanged. `now`
 * is the caller's clock.
 *
 * Rules pinned by the `task-parsing` vectors:
 * - completion is the task's **status** type within its own project; an
 *   unresolvable status is incomplete;
 * - overdue work leads Today and Next 7, never Tomorrow;
 * - a started task (start date not after today) is in Today whatever its due
 *   date says, unless it is overdue (then it leads as overdue);
 * - subtasks ride with a matching parent and are never matched on their own.
 */

import {
  addDays,
  endOfDay,
  endOfWeek,
  isAfter,
  isBefore,
  isSameDay,
  isWithinInterval,
  startOfDay
} from './dates.ts'
import type { ViewProject, ViewTask } from './types.ts'

const hasStarted = (task: ViewTask, today: Date): boolean =>
  !!task.startDate && !isAfter(startOfDay(task.startDate), today)

export const isTaskCompleted = (task: ViewTask, projects: readonly ViewProject[]): boolean => {
  const project = projects.find((p) => p.id === task.projectId)
  if (!project) return false

  const status = project.statuses.find((s) => s.id === task.statusId)
  return status?.type === 'done'
}

const includeSubtasksForMatchingParents = <T extends ViewTask>(
  matchingTopLevel: readonly T[],
  allTasks: readonly T[]
): T[] => {
  const matchingIds = new Set(matchingTopLevel.map((t) => t.id))

  return allTasks.filter(
    (t) => matchingIds.has(t.id) || (t.parentId !== null && matchingIds.has(t.parentId))
  )
}

/**
 * The renderer's sidebar/tasks-page selection: a view id (`all`, `today`,
 * `upcoming`, `tomorrow`, `week`, `completed`) or a project id.
 */
export const getFilteredTasks = <T extends ViewTask>(
  tasks: readonly T[],
  selectedId: string,
  selectedType: 'view' | 'project',
  projects: readonly ViewProject[],
  now: Date
): T[] => {
  const nonArchivedTasks = tasks.filter((t) => !t.archivedAt)

  const isIncomplete = (task: T): boolean => {
    const project = projects.find((p) => p.id === task.projectId)
    const status = project?.statuses.find((s) => s.id === task.statusId)
    return status?.type !== 'done'
  }

  const isComplete = (task: T): boolean => !isIncomplete(task)
  const isSubtask = (task: T): boolean => task.parentId !== null

  const incompleteTopLevel = nonArchivedTasks.filter((t) => isIncomplete(t) && !isSubtask(t))
  const completedTopLevel = nonArchivedTasks.filter((t) => isComplete(t) && !isSubtask(t))

  if (selectedType === 'view') {
    const today = startOfDay(now)
    const weekFromNow = addDays(today, 7)

    switch (selectedId) {
      case 'all':
        return includeSubtasksForMatchingParents(incompleteTopLevel, nonArchivedTasks)

      case 'today': {
        const matchingTopLevel = incompleteTopLevel.filter((task) => {
          if (hasStarted(task, today)) return true
          if (!task.dueDate) return false
          const taskDate = startOfDay(task.dueDate)
          return isSameDay(taskDate, today) || isBefore(taskDate, today)
        })
        return includeSubtasksForMatchingParents(matchingTopLevel, nonArchivedTasks)
      }

      case 'upcoming': {
        const matchingTopLevel = incompleteTopLevel.filter((task) => {
          if (!task.dueDate) return false
          const taskDate = startOfDay(task.dueDate)
          return isAfter(taskDate, today) && !isAfter(taskDate, weekFromNow)
        })
        return includeSubtasksForMatchingParents(matchingTopLevel, nonArchivedTasks)
      }

      case 'tomorrow': {
        const tomorrow = addDays(today, 1)
        const matchingTopLevel = incompleteTopLevel.filter((task) => {
          if (!task.dueDate) return false
          return isSameDay(startOfDay(task.dueDate), tomorrow)
        })
        return includeSubtasksForMatchingParents(matchingTopLevel, nonArchivedTasks)
      }

      case 'week': {
        const weekEnd = endOfWeek(today)
        const matchingTopLevel = incompleteTopLevel.filter((task) => {
          if (!task.dueDate) return false
          const taskDate = startOfDay(task.dueDate)
          return !isBefore(taskDate, today) && !isAfter(taskDate, weekEnd)
        })
        return includeSubtasksForMatchingParents(matchingTopLevel, nonArchivedTasks)
      }

      case 'completed':
        return includeSubtasksForMatchingParents(completedTopLevel, nonArchivedTasks)

      default:
        return includeSubtasksForMatchingParents(incompleteTopLevel, nonArchivedTasks)
    }
  }

  if (selectedType === 'project') {
    return nonArchivedTasks.filter((task) => task.projectId === selectedId)
  }

  return includeSubtasksForMatchingParents(incompleteTopLevel, nonArchivedTasks)
}

/**
 * The due-date windows the Tasks page can be scoped to. `all` is deliberately
 * not one of these: it is "no window at all", not a range.
 */
export type TaskDueWindow = 'today' | 'tomorrow' | 'next7'

/** Inclusive day offsets from today, as [first day, last day]. */
const DUE_WINDOW_DAYS: Record<TaskDueWindow, [number, number]> = {
  today: [0, 0],
  tomorrow: [1, 1],
  next7: [0, 6]
}

/**
 * Flat, ordered task list for one due-date window, overdue work first.
 *
 * `today` and `next7` lead with overdue tasks — that work is still owed inside
 * the window, and `today` has always shown it. `tomorrow` is a preview of a
 * single day, so it stays strictly that day and carries no overdue backlog.
 */
export const getTasksInDueWindow = <T extends ViewTask>(
  tasks: readonly T[],
  projects: readonly ViewProject[],
  window: TaskDueWindow,
  now: Date
): T[] => {
  const todayStart = startOfDay(now)
  const [firstDay, lastDay] = DUE_WINDOW_DAYS[window]
  const windowStart = addDays(todayStart, firstDay)
  const windowEnd = endOfDay(addDays(todayStart, lastDay))
  const includeOverdue = window !== 'tomorrow'

  const overdue: T[] = []
  const inWindow: T[] = []

  tasks.forEach((task) => {
    if (isTaskCompleted(task, projects)) return
    if (task.parentId !== null) return
    if (task.archivedAt) return
    if (
      window === 'today' &&
      hasStarted(task, todayStart) &&
      (!task.dueDate || !isBefore(startOfDay(task.dueDate), todayStart))
    ) {
      inWindow.push(task)
      return
    }
    if (!task.dueDate) return

    const dueDate = startOfDay(task.dueDate)

    if (isBefore(dueDate, todayStart)) {
      if (includeOverdue) overdue.push(task)
    } else if (isWithinInterval(task.dueDate, { start: windowStart, end: windowEnd })) {
      inWindow.push(task)
    }
  })

  return [
    ...includeSubtasksForMatchingParents(overdue, tasks),
    ...includeSubtasksForMatchingParents(inWindow, tasks)
  ]
}

/**
 * Done tasks to show under a due-date window.
 *
 * Scoped by due date, not by completion date — "what in this window is already
 * finished". `today` is the exception and keeps its own completed-today rule
 * (see `getCompletedTodayTasks`), which is what the day's progress celebrates.
 */
export const getCompletedTasksInDueWindow = <T extends ViewTask>(
  tasks: readonly T[],
  window: TaskDueWindow,
  now: Date
): T[] => {
  const todayStart = startOfDay(now)
  const [firstDay, lastDay] = DUE_WINDOW_DAYS[window]
  const windowStart = addDays(todayStart, firstDay)
  const windowEnd = endOfDay(addDays(todayStart, lastDay))

  return tasks.filter(
    (task) =>
      task.completedAt !== null &&
      task.archivedAt === null &&
      task.parentId === null &&
      task.dueDate !== null &&
      isWithinInterval(task.dueDate, { start: windowStart, end: windowEnd })
  )
}

/** Every completed, non-archived top-level task (the "All" Done section). */
export const getCompletedTasks = <T extends ViewTask>(tasks: readonly T[]): T[] =>
  tasks.filter(
    (task) => task.completedAt !== null && task.archivedAt === null && task.parentId === null
  )

/** Top-level tasks completed on `now`'s calendar day (Today's Done section). */
export const getCompletedTodayTasks = <T extends ViewTask>(tasks: readonly T[], now: Date): T[] =>
  tasks.filter(
    (task) =>
      task.completedAt !== null &&
      task.archivedAt === null &&
      task.parentId === null &&
      isSameDay(task.completedAt, now)
  )

/** Narrows to one project; `null` keeps every project. */
export const scopeTasksByProject = <T extends ViewTask>(
  tasks: readonly T[],
  projectId: string | null
): T[] => {
  if (!projectId) return [...tasks]
  return tasks.filter((task) => task.projectId === projectId)
}

export interface TaskTabCounts {
  all: number
  archived: number
  today: number
  tomorrow: number
  next7: number
}

/**
 * The Tasks page tab badges, scoped by the project picker. Parents only —
 * subtasks ride along in the lists but are not counted.
 */
export const getTaskTabCounts = (
  tasks: readonly ViewTask[],
  projects: readonly ViewProject[],
  scopeProjectId: string | null,
  now: Date
): TaskTabCounts => {
  const scopedTasks = scopeTasksByProject(tasks, scopeProjectId)
  const countWindow = (window: TaskDueWindow): number =>
    getTasksInDueWindow(scopedTasks, projects, window, now).filter((t) => t.parentId === null)
      .length

  return {
    all: getFilteredTasks(scopedTasks, 'all', 'view', projects, now).length,
    archived: scopedTasks.filter((t) => t.archivedAt && t.parentId === null).length,
    today: countWindow('today'),
    tomorrow: countWindow('tomorrow'),
    next7: countWindow('next7')
  }
}
