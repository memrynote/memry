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
 * - date views show the task, not the tree: a dated task at any depth is its
 *   own row, provided it is placed in the tree (a root, or below one). The tree
 *   is built over non-archived tasks, so a task under an archived or missing
 *   parent is shown nowhere. Undated subtasks of a dated parent are not rows.
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
import { buildTaskTree } from '../tree.ts'

const hasStarted = (task: ViewTask, today: Date): boolean =>
  !!task.startDate && !isAfter(startOfDay(task.startDate), today)

export const isTaskCompleted = (task: ViewTask, projects: readonly ViewProject[]): boolean => {
  const project = projects.find((p) => p.id === task.projectId)
  if (!project) return false

  const status = project.statuses.find((s) => s.id === task.statusId)
  return status?.type === 'done'
}

/**
 * Non-archived tasks the tree places: roots and everything below them. A task
 * under a missing or archived parent is neither, so no view shows it.
 */
const placedTasks = <T extends ViewTask>(tasks: readonly T[]): T[] => {
  const live = tasks.filter((t) => !t.archivedAt)
  const tree = buildTaskTree(live)
  const placed = new Set<string>()
  for (const root of tree.roots) {
    placed.add(root.id)
    for (const id of tree.descendantIds(root.id)) placed.add(id)
  }
  return live.filter((t) => placed.has(t.id))
}

const includeSubtasksForMatchingParents = <T extends ViewTask>(
  matching: readonly T[],
  allTasks: readonly T[]
): T[] => {
  const tree = buildTaskTree(allTasks)
  const included = new Set<string>()
  for (const task of matching) {
    included.add(task.id)
    for (const id of tree.descendantIds(task.id)) included.add(id)
  }

  return allTasks.filter((t) => included.has(t.id))
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
  const tree = buildTaskTree(tasks)
  const isSubtask = (task: T): boolean => tree.parentOf(task.id) !== null

  const incompleteTopLevel = nonArchivedTasks.filter((t) => isIncomplete(t) && !isSubtask(t))
  const incompletePlaced = placedTasks(tasks).filter(isIncomplete)
  const completedTopLevel = nonArchivedTasks.filter((t) => isComplete(t) && !isSubtask(t))

  if (selectedType === 'view') {
    const today = startOfDay(now)
    const weekFromNow = addDays(today, 7)

    switch (selectedId) {
      case 'all':
        return includeSubtasksForMatchingParents(incompleteTopLevel, nonArchivedTasks)

      case 'today': {
        const matching = incompletePlaced.filter((task) => {
          if (hasStarted(task, today)) return true
          if (!task.dueDate) return false
          const taskDate = startOfDay(task.dueDate)
          return isSameDay(taskDate, today) || isBefore(taskDate, today)
        })
        return includeSubtasksForMatchingParents(matching, nonArchivedTasks)
      }

      case 'upcoming': {
        const matching = incompletePlaced.filter((task) => {
          if (!task.dueDate) return false
          const taskDate = startOfDay(task.dueDate)
          return isAfter(taskDate, today) && !isAfter(taskDate, weekFromNow)
        })
        return includeSubtasksForMatchingParents(matching, nonArchivedTasks)
      }

      case 'tomorrow': {
        const tomorrow = addDays(today, 1)
        const matching = incompletePlaced.filter((task) => {
          if (!task.dueDate) return false
          return isSameDay(startOfDay(task.dueDate), tomorrow)
        })
        return includeSubtasksForMatchingParents(matching, nonArchivedTasks)
      }

      case 'week': {
        const weekEnd = endOfWeek(today)
        const matching = incompletePlaced.filter((task) => {
          if (!task.dueDate) return false
          const taskDate = startOfDay(task.dueDate)
          return !isBefore(taskDate, today) && !isAfter(taskDate, weekEnd)
        })
        return includeSubtasksForMatchingParents(matching, nonArchivedTasks)
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
 * Flat, ordered task rows for one due-date window, overdue work first. Each
 * row is a placed task at any depth matched on its own dates; no descendants
 * ride along.
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

  placedTasks(tasks).forEach((task) => {
    if (isTaskCompleted(task, projects)) return
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

  return [...overdue, ...inWindow]
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

  return placedTasks(tasks).filter(
    (task) =>
      task.completedAt !== null &&
      task.dueDate !== null &&
      isWithinInterval(task.dueDate, { start: windowStart, end: windowEnd })
  )
}

/** Every completed, non-archived top-level task (the "All" Done section). */
export const getCompletedTasks = <T extends ViewTask>(tasks: readonly T[]): T[] =>
  tasks.filter(
    (task) => task.completedAt !== null && task.archivedAt === null && task.parentId === null
  )

/** Placed tasks at any depth completed on `now`'s calendar day (Today's Done section). */
export const getCompletedTodayTasks = <T extends ViewTask>(tasks: readonly T[], now: Date): T[] =>
  placedTasks(tasks).filter((task) => task.completedAt !== null && isSameDay(task.completedAt, now))

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
 * The Tasks page tab badges, scoped by the project picker. A date tab counts
 * the rows it draws: its window over the `all` list, as the page builds it.
 */
export const getTaskTabCounts = (
  tasks: readonly ViewTask[],
  projects: readonly ViewProject[],
  scopeProjectId: string | null,
  now: Date
): TaskTabCounts => {
  const scopedTasks = scopeTasksByProject(tasks, scopeProjectId)
  const open = getFilteredTasks(scopedTasks, 'all', 'view', projects, now)
  const countWindow = (window: TaskDueWindow): number =>
    getTasksInDueWindow(open, projects, window, now).length

  return {
    all: open.length,
    archived: scopedTasks.filter((t) => t.archivedAt && t.parentId === null).length,
    today: countWindow('today'),
    tomorrow: countWindow('tomorrow'),
    next7: countWindow('next7')
  }
}
