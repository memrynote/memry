import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import {
  startOfDay,
  addDays,
  endOfDay,
  isSameDay,
  isBefore,
  isAfter,
  isWithinInterval,
  formatDateKey
} from './task-date-utils'
import { isTaskCompleted } from './task-status-helpers'

// ============================================================================
// SUBTASK INCLUSION HELPER
// ============================================================================

const includeSubtasksForMatchingParents = (matchingTopLevel: Task[], allTasks: Task[]): Task[] => {
  const matchingIds = new Set(matchingTopLevel.map((t) => t.id))

  return allTasks.filter(
    (t) =>
      matchingIds.has(t.id) ||
      (t.parentId !== null && matchingIds.has(t.parentId))
  )
}

// ============================================================================
// TASK FILTERING
// ============================================================================

export const getFilteredTasks = (
  tasks: Task[],
  selectedId: string,
  selectedType: 'view' | 'project',
  projects: Project[],
  includeCompleted = false
): Task[] => {
  const nonArchivedTasks = tasks.filter((t) => !t.archivedAt)

  const isIncomplete = (task: Task): boolean => {
    const project = projects.find((p) => p.id === task.projectId)
    const status = project?.statuses.find((s) => s.id === task.statusId)
    return status?.type !== 'done'
  }

  const isComplete = (task: Task): boolean => !isIncomplete(task)
  const isSubtask = (task: Task): boolean => task.parentId !== null

  const incompleteTopLevel = nonArchivedTasks.filter((t) => isIncomplete(t) && !isSubtask(t))
  const completedTopLevel = nonArchivedTasks.filter((t) => isComplete(t) && !isSubtask(t))

  if (selectedType === 'view') {
    const today = startOfDay(new Date())
    const weekFromNow = addDays(today, 7)

    switch (selectedId) {
      case 'all':
        return includeSubtasksForMatchingParents(incompleteTopLevel, nonArchivedTasks)

      case 'today': {
        const matchingTopLevel = incompleteTopLevel.filter((task) => {
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

      case 'completed':
        return includeSubtasksForMatchingParents(completedTopLevel, nonArchivedTasks)

      default:
        return includeSubtasksForMatchingParents(incompleteTopLevel, nonArchivedTasks)
    }
  }

  if (selectedType === 'project') {
    const projectTasks = nonArchivedTasks.filter((task) => task.projectId === selectedId)
    return projectTasks
  }

  return includeSubtasksForMatchingParents(incompleteTopLevel, nonArchivedTasks)
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

export interface TodayViewTasks {
  overdue: Task[]
  today: Task[]
}

export const getTodayTasks = (tasks: Task[], projects: Project[]): TodayViewTasks => {
  const now = new Date()
  const todayStart = startOfDay(now)
  const todayEnd = endOfDay(now)

  const overdue: Task[] = []
  const today: Task[] = []

  tasks.forEach((task) => {
    if (isTaskCompleted(task, projects)) return
    if (task.parentId !== null) return
    if (!task.dueDate) return

    const dueDate = startOfDay(task.dueDate)

    if (isBefore(dueDate, todayStart)) {
      overdue.push(task)
    } else if (isWithinInterval(task.dueDate, { start: todayStart, end: todayEnd })) {
      today.push(task)
    }
  })

  const overdueWithSubtasks = includeSubtasksForMatchingParents(overdue, tasks)
  const todayWithSubtasks = includeSubtasksForMatchingParents(today, tasks)

  return {
    overdue: overdueWithSubtasks,
    today: todayWithSubtasks
  }
}

export interface TodayWithWeekTasks {
  overdue: Task[]
  today: Task[]
  weekByDay: Map<string, Task[]>
}

export const getTodayWithWeekTasks = (
  tasks: Task[],
  projects: Project[],
  weekDays: number = 6
): TodayWithWeekTasks => {
  const now = new Date()
  const todayStart = startOfDay(now)
  const todayEnd = endOfDay(now)
  const tomorrowStart = addDays(todayStart, 1)
  const weekEnd = endOfDay(addDays(todayStart, weekDays))

  const overdue: Task[] = []
  const today: Task[] = []
  const weekByDay = new Map<string, Task[]>()

  for (let i = 1; i <= weekDays; i++) {
    const date = addDays(todayStart, i)
    const key = formatDateKey(date)
    weekByDay.set(key, [])
  }

  tasks.forEach((task) => {
    if (isTaskCompleted(task, projects)) return
    if (task.parentId !== null) return
    if (!task.dueDate) return

    const dueDate = startOfDay(task.dueDate)

    if (isBefore(dueDate, todayStart)) {
      overdue.push(task)
    } else if (isWithinInterval(task.dueDate, { start: todayStart, end: todayEnd })) {
      today.push(task)
    } else if (isWithinInterval(task.dueDate, { start: tomorrowStart, end: weekEnd })) {
      const key = formatDateKey(dueDate)
      if (weekByDay.has(key)) {
        weekByDay.get(key)!.push(task)
      }
    }
  })

  const overdueWithSubtasks = includeSubtasksForMatchingParents(overdue, tasks)
  const todayWithSubtasks = includeSubtasksForMatchingParents(today, tasks)

  const weekByDayWithSubtasks = new Map<string, Task[]>()
  weekByDay.forEach((dayTasks, key) => {
    weekByDayWithSubtasks.set(key, includeSubtasksForMatchingParents(dayTasks, tasks))
  })

  return {
    overdue: overdueWithSubtasks,
    today: todayWithSubtasks,
    weekByDay: weekByDayWithSubtasks
  }
}

export interface UpcomingViewTasks {
  overdue: Task[]
  byDay: Map<string, Task[]>
}

export const getUpcomingTasks = (
  tasks: Task[],
  projects: Project[],
  daysAhead: number = 7
): UpcomingViewTasks => {
  const now = new Date()
  const todayStart = startOfDay(now)
  const rangeEnd = endOfDay(addDays(now, daysAhead - 1))

  const overdue: Task[] = []
  const byDay = new Map<string, Task[]>()

  for (let i = 0; i < daysAhead; i++) {
    const date = addDays(todayStart, i)
    const key = formatDateKey(date)
    byDay.set(key, [])
  }

  tasks.forEach((task) => {
    if (isTaskCompleted(task, projects)) return
    if (task.parentId !== null) return
    if (!task.dueDate) return

    const dueDate = startOfDay(task.dueDate)

    if (isBefore(dueDate, todayStart)) {
      overdue.push(task)
    } else if (isWithinInterval(task.dueDate, { start: todayStart, end: rangeEnd })) {
      const key = formatDateKey(dueDate)
      if (byDay.has(key)) {
        byDay.get(key)!.push(task)
      }
    }
  })

  const overdueWithSubtasks = includeSubtasksForMatchingParents(overdue, tasks)

  const byDayWithSubtasks = new Map<string, Task[]>()
  byDay.forEach((dayTasks, key) => {
    byDayWithSubtasks.set(key, includeSubtasksForMatchingParents(dayTasks, tasks))
  })

  return { overdue: overdueWithSubtasks, byDay: byDayWithSubtasks }
}

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
// COMPLETED VIEW & ARCHIVE HELPERS
// ============================================================================

export const getCompletedTasks = (tasks: Task[]): Task[] => {
  return tasks.filter(
    (task) => task.completedAt !== null && task.archivedAt === null && task.parentId === null
  )
}

export const getCompletedTodayTasks = (tasks: Task[]): Task[] => {
  const today = new Date()
  return tasks.filter(
    (task) =>
      task.completedAt !== null &&
      task.archivedAt === null &&
      task.parentId === null &&
      isSameDay(task.completedAt, today)
  )
}

export const getArchivedTasks = (tasks: Task[]): Task[] => {
  return tasks.filter((task) => task.archivedAt !== null)
}
