import type { Task } from '@/data/task-model'
import type { Project, StatusType } from '@/data/tasks-data'
import { startOfDay, addDays, endOfWeek, isSameDay, isBefore, isAfter } from './task-date-utils'
import { isTaskCompleted } from './task-status-helpers'
import {
  getCompletedTasks as getCompletedTasksAt,
  getCompletedTasksInDueWindow as getCompletedTasksInDueWindowAt,
  getCompletedTodayTasks as getCompletedTodayTasksAt,
  getFilteredTasks as getFilteredTasksAt,
  getTasksInDueWindow as getTasksInDueWindowAt,
  type TaskDueWindow
} from '@memry/domain-tasks/parsing'
import { buildTaskTree } from '@memry/domain-tasks/tree'

/** The sidebar views `getFilteredTasks` matches at any depth. */
const DATE_VIEW_IDS: ReadonlySet<string> = new Set(['today', 'upcoming', 'tomorrow', 'week'])

const hasStarted = (task: Task, today: Date): boolean =>
  !!task.startDate && !isAfter(startOfDay(task.startDate), today)

// ============================================================================
// TASK FILTERING
// ============================================================================

export const getFilteredTasks = (
  tasks: Task[],
  selectedId: string,
  selectedType: 'view' | 'project',
  projects: Project[],
  _includeCompleted = false,
  now = new Date()
): Task[] => getFilteredTasksAt(tasks, selectedId, selectedType, projects, now)

// ============================================================================
// WORKSPACE BADGE COUNTS (SINGLE PASS)
// ============================================================================

export interface TaskWorkspaceCounts {
  /** Per view id, equal to `getFilteredTasks(tasks, viewId, 'view', projects).length`. */
  viewCounts: Record<string, number>
  /**
   * Per `task.projectId`, the number of that project's non-archived, top-level
   * tasks not in a `done` status — i.e. the rows `getFilteredTasks(tasks,
   * projectId, 'project', projects)` renders as rows, minus the completed ones.
   * Subtasks are excluded: they render nested under their parent.
   */
  projectTaskCounts: Record<string, number>
}

/**
 * Derives every sidebar view badge and every project badge in one pass over the
 * task list.
 *
 * Calling `getFilteredTasks` once per view re-walks the whole list per view and,
 * because its status lookup is `projects.find(...)` per task, costs
 * O(views x tasks x projects) on every task mutation. This bucket-as-you-go
 * version is O(tasks) after an O(projects x statuses) index build, and is exactly
 * equivalent — the equivalence is asserted against `getFilteredTasks` in
 * `task-workspace-counts.test.ts`.
 */
export const getTaskWorkspaceCounts = (
  tasks: Task[],
  projects: Project[],
  viewIds: readonly string[],
  now = new Date()
): TaskWorkspaceCounts => {
  const statusTypesByProject = new Map<string, Map<string, StatusType>>()
  for (const project of projects) {
    const statusTypes = new Map<string, StatusType>()
    for (const status of project.statuses) {
      statusTypes.set(status.id, status.type)
    }
    statusTypesByProject.set(project.id, statusTypes)
  }

  const today = startOfDay(now)
  const tomorrow = addDays(today, 1)
  const weekFromNow = addDays(today, 7)
  const weekEnd = endOfWeek(today)

  const matchesView = (viewId: string, task: Task, isIncomplete: boolean): boolean => {
    if (viewId === 'completed') return !isIncomplete
    if (!isIncomplete) return false

    switch (viewId) {
      case 'today': {
        if (hasStarted(task, today)) return true
        if (!task.dueDate) return false
        const taskDate = startOfDay(task.dueDate)
        return isSameDay(taskDate, today) || isBefore(taskDate, today)
      }

      case 'upcoming': {
        if (!task.dueDate) return false
        const taskDate = startOfDay(task.dueDate)
        return isAfter(taskDate, today) && !isAfter(taskDate, weekFromNow)
      }

      case 'tomorrow': {
        if (!task.dueDate) return false
        return isSameDay(startOfDay(task.dueDate), tomorrow)
      }

      case 'week': {
        if (!task.dueDate) return false
        const taskDate = startOfDay(task.dueDate)
        return !isBefore(taskDate, today) && !isAfter(taskDate, weekEnd)
      }

      // 'all', and every unknown id, land on getFilteredTasks' default arm.
      default:
        return true
    }
  }

  // `getFilteredTasks` matches a date view at any depth among the tasks the
  // tree places, the other views among top-level tasks, then adds every
  // non-archived task below a match.
  const liveTasks = tasks.filter((task) => !task.archivedAt)
  const tree = buildTaskTree(tasks)
  const liveTree = buildTaskTree(liveTasks)
  const placedIds = new Set<string>()
  for (const root of liveTree.roots) {
    placedIds.add(root.id)
    for (const id of liveTree.descendantIds(root.id)) placedIds.add(id)
  }

  const matchedByView = new Map<string, Set<string>>()
  for (const viewId of viewIds) matchedByView.set(viewId, new Set<string>())

  const projectTaskCounts: Record<string, number> = {}

  for (const task of tasks) {
    const projectId = task.projectId
    const isIncomplete = statusTypesByProject.get(projectId)?.get(task.statusId) !== 'done'

    // Archived tasks are dropped by `getFilteredTasks` before anything else, so
    // no view — the project view included — can render them. Counting them in a
    // badge makes it read higher than the list it opens.
    if (task.archivedAt) continue
    const isTopLevel = tree.parentOf(task.id) === null

    // A subtask is a row under its parent, never a row of its own, so it must
    // not lift the project badge past the number of rows the project lists.
    // Counting them made a project of finished parents read as dozens of open
    // tasks over an empty To Do section.
    if (task.parentId === null && isIncomplete) {
      projectTaskCounts[projectId] = (projectTaskCounts[projectId] ?? 0) + 1
    }

    for (const viewId of viewIds) {
      const eligible = DATE_VIEW_IDS.has(viewId) ? placedIds.has(task.id) : isTopLevel
      if (eligible && matchesView(viewId, task, isIncomplete)) {
        matchedByView.get(viewId)?.add(task.id)
      }
    }
  }

  const viewCounts: Record<string, number> = {}
  for (const viewId of viewIds) {
    const listed = new Set(matchedByView.get(viewId))
    for (const id of matchedByView.get(viewId) ?? []) {
      for (const below of liveTree.descendantIds(id)) listed.add(below)
    }
    viewCounts[viewId] = listed.size
  }

  return { viewCounts, projectTaskCounts }
}

// ============================================================================
// TASK COUNTS
// ============================================================================

export interface TaskCounts {
  total: number
  dueToday: number
  overdue: number
  completed: number
}

export const getTaskCounts = (
  tasks: Task[],
  selectedId: string,
  selectedType: 'view' | 'project',
  projects: Project[]
): TaskCounts => {
  const filteredTasks = getFilteredTasks(tasks, selectedId, selectedType, projects)
  const today = startOfDay(new Date())

  let total = 0
  let dueToday = 0
  let overdue = 0
  let completed = 0

  filteredTasks.forEach((task) => {
    const isTaskDone = isTaskCompleted(task, projects)

    if (isTaskDone) {
      completed++
    } else {
      total++

      if (task.dueDate) {
        const taskDate = startOfDay(task.dueDate)
        if (isBefore(taskDate, today)) {
          overdue++
        } else if (isSameDay(taskDate, today)) {
          dueToday++
        }
      }
    }
  })

  return { total, dueToday, overdue, completed }
}

export const formatTaskSubtitle = (
  counts: TaskCounts,
  selectedId: string,
  selectedType: 'view' | 'project'
): string => {
  if (selectedType === 'view') {
    switch (selectedId) {
      case 'all': {
        const parts = [`${counts.total} tasks`]
        if (counts.dueToday > 0) parts.push(`${counts.dueToday} due today`)
        if (counts.overdue > 0) parts.push(`${counts.overdue} overdue`)
        return parts.join(' · ')
      }

      case 'today': {
        const parts = [`${counts.total + counts.overdue} tasks due`]
        if (counts.overdue > 0) parts.push(`${counts.overdue} overdue`)
        return parts.join(' · ')
      }

      case 'upcoming':
        return `${counts.total} tasks in the next 7 days`

      case 'completed':
        return `${counts.completed} tasks completed`

      default:
        return `${counts.total} tasks`
    }
  }

  const parts = [`${counts.total} tasks`]
  if (counts.dueToday > 0) parts.push(`${counts.dueToday} due today`)
  return parts.join(' · ')
}

// ============================================================================
// TODAY & UPCOMING VIEW HELPERS
// ============================================================================

export type { TaskDueWindow } from '@memry/domain-tasks/parsing'

/** Flat, ordered task list for one due-date window, overdue work first. */
export const getTasksInDueWindow = (
  tasks: Task[],
  projects: Project[],
  window: TaskDueWindow,
  now = new Date()
): Task[] => getTasksInDueWindowAt(tasks, projects, window, now)

/** Done tasks to show under a due-date window (scoped by due date). */
export const getCompletedTasksInDueWindow = (
  tasks: Task[],
  window: TaskDueWindow,
  now = new Date()
): Task[] => getCompletedTasksInDueWindowAt(tasks, window, now)

export interface DayHeaderText {
  primary: string
  secondary: string
}

export const getDayHeaderText = (date: Date): DayHeaderText => {
  const now = new Date()
  const todayStart = startOfDay(now)
  const tomorrowStart = addDays(todayStart, 1)

  const secondary = date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  })

  if (isSameDay(date, todayStart)) {
    return {
      primary: 'TODAY',
      secondary
    }
  }

  if (isSameDay(date, tomorrowStart)) {
    return {
      primary: 'TOMORROW',
      secondary
    }
  }

  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()
  const shortDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return {
    primary: dayName,
    secondary: shortDate
  }
}

// ============================================================================
// COMPLETED VIEW HELPERS
// ============================================================================

export const getCompletedTasks = (tasks: Task[]): Task[] => getCompletedTasksAt(tasks)

export const getCompletedTodayTasks = (tasks: Task[], now = new Date()): Task[] =>
  getCompletedTodayTasksAt(tasks, now)
