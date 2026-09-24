/**
 * Task filters and sorts (spec 004 TP015), moved from the renderer's
 * `task-filters.ts`. Generic over the task shape; `now` and the week start are
 * the caller's (the renderer reads the Calendar `weekStartDay` setting).
 *
 * `title` and `project` order with `String.prototype.localeCompare` (ICU root
 * collation), which the `task-filtering` vectors pin.
 */
import {
  addDays,
  addWeeks,
  endOfDay,
  endOfMonth,
  endOfWeek,
  isBefore,
  isWithinInterval,
  startOfDay,
  startOfWeek
} from '../parsing/dates.ts'
import type { Priority, StatusType } from '../parsing/types.ts'
import type {
  CompletionFilterType,
  DueDateFilter,
  FilterProject,
  FilterTask,
  HasTimeFilterType,
  RepeatFilterType,
  TaskFilters,
  TaskSort
} from './types.ts'

// ============================================================================
// ADVANCED FILTER FUNCTIONS
// ============================================================================

export const filterBySearch = <T extends FilterTask>(tasks: T[], query: string): T[] => {
  if (!query.trim()) return tasks

  const lowerQuery = query.toLowerCase().trim()

  return tasks.filter((task) => {
    const titleMatch = task.title.toLowerCase().includes(lowerQuery)
    const descMatch = task.description?.toLowerCase().includes(lowerQuery)
    return titleMatch || descMatch
  })
}

export const filterByProjects = <T extends FilterTask>(tasks: T[], projectIds: string[]): T[] => {
  if (projectIds.length === 0) return tasks
  return tasks.filter((task) => projectIds.includes(task.projectId))
}

export const filterByPriorities = <T extends FilterTask>(
  tasks: T[],
  priorities: Priority[]
): T[] => {
  if (priorities.length === 0) return tasks
  return tasks.filter((task) => priorities.includes(task.priority))
}

export const filterByTags = <T extends FilterTask>(tasks: T[], tags: string[]): T[] => {
  if (tags.length === 0) return tasks
  const selected = new Set(tags.map((t) => t.toLowerCase()))
  return tasks.filter((task) => task.tags.some((tag) => selected.has(tag.toLowerCase())))
}

export const filterByDueDateRange = <T extends FilterTask>(
  tasks: T[],
  filter: DueDateFilter,
  now: Date,
  weekStartsOn: 0 | 1
): T[] => {
  const todayStart = startOfDay(now)
  const todayEnd = endOfDay(now)

  switch (filter.type) {
    case 'any':
      return tasks

    case 'none':
      return tasks.filter((t) => !t.dueDate)

    case 'overdue':
      return tasks.filter(
        (t) => t.dueDate && isBefore(startOfDay(t.dueDate), todayStart) && !t.completedAt
      )

    case 'today':
      return tasks.filter(
        (t) => t.dueDate && isWithinInterval(t.dueDate, { start: todayStart, end: todayEnd })
      )

    case 'tomorrow': {
      const tomorrowStart = startOfDay(addDays(now, 1))
      const tomorrowEnd = endOfDay(addDays(now, 1))
      return tasks.filter(
        (t) => t.dueDate && isWithinInterval(t.dueDate, { start: tomorrowStart, end: tomorrowEnd })
      )
    }

    case 'this-week': {
      const weekEnd = endOfWeek(now, weekStartsOn)
      return tasks.filter(
        (t) => t.dueDate && isWithinInterval(t.dueDate, { start: todayStart, end: weekEnd })
      )
    }

    case 'next-week': {
      const nextWeekStart = startOfWeek(addWeeks(now, 1), weekStartsOn)
      const nextWeekEnd = endOfWeek(addWeeks(now, 1), weekStartsOn)
      return tasks.filter(
        (t) => t.dueDate && isWithinInterval(t.dueDate, { start: nextWeekStart, end: nextWeekEnd })
      )
    }

    case 'this-month': {
      const monthEnd = endOfMonth(now)
      return tasks.filter(
        (t) => t.dueDate && isWithinInterval(t.dueDate, { start: todayStart, end: monthEnd })
      )
    }

    case 'custom':
      if (!filter.customStart || !filter.customEnd) return tasks
      return tasks.filter(
        (t) =>
          t.dueDate &&
          isWithinInterval(t.dueDate, {
            start: startOfDay(filter.customStart!),
            end: endOfDay(filter.customEnd!)
          })
      )

    default:
      return tasks
  }
}

export const filterByStatuses = <T extends FilterTask>(tasks: T[], statusIds: string[]): T[] => {
  if (statusIds.length === 0) return tasks
  return tasks.filter((t) => statusIds.includes(t.statusId))
}

export const filterByCompletion = <T extends FilterTask>(
  tasks: T[],
  completion: CompletionFilterType,
  projects: readonly FilterProject[]
): T[] => {
  const isComplete = (task: T): boolean => {
    const project = projects.find((p) => p.id === task.projectId)
    const status = project?.statuses.find((s) => s.id === task.statusId)
    return status?.type === 'done'
  }

  if (completion === 'archived') {
    return tasks.filter((t) => !!t.archivedAt)
  }

  const nonArchivedTasks = tasks.filter((t) => !t.archivedAt)

  switch (completion) {
    case 'active':
      return nonArchivedTasks.filter((t) => !isComplete(t))
    case 'completed':
      return nonArchivedTasks.filter((t) => isComplete(t))
    case 'all':
    default:
      return nonArchivedTasks
  }
}

export const filterByRepeatType = <T extends FilterTask>(
  tasks: T[],
  type: RepeatFilterType
): T[] => {
  switch (type) {
    case 'repeating':
      return tasks.filter((t) => t.isRepeating)
    case 'one-time':
      return tasks.filter((t) => !t.isRepeating)
    case 'all':
    default:
      return tasks
  }
}

export const filterByHasTime = <T extends FilterTask>(tasks: T[], type: HasTimeFilterType): T[] => {
  switch (type) {
    case 'with-time':
      return tasks.filter((t) => t.dueTime !== null)
    case 'without-time':
      return tasks.filter((t) => t.dueTime === null)
    case 'all':
    default:
      return tasks
  }
}

/**
 * Orders two optional values with "missing sorts last", which is what every
 * date-ish sort field here wants.
 */
const compareNullable = <T>(
  a: T | null | undefined,
  b: T | null | undefined,
  compare: (a: T, b: T) => number
): number => {
  if (a && b) return compare(a, b)
  if (a) return -1
  if (b) return 1
  return 0
}

export const sortTasksAdvanced = <T extends FilterTask>(
  tasks: T[],
  sort: TaskSort,
  projects: readonly FilterProject[]
): T[] => {
  const priorityOrder = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
    none: 4
  } satisfies Record<Priority, number>

  const sorted = [...tasks].sort((a, b) => {
    let comparison = 0

    switch (sort.field) {
      // `folder` and `note` order rows by the note they came from, which lives
      // in the note index the grouping layer holds, not on the task. The group
      // order is decided there; here only the order inside one group matters,
      // and that is the due date.
      case 'folder':
      case 'note':
      case 'dueDate': {
        comparison = compareNullable(a.dueDate, b.dueDate, (x, y) => x.getTime() - y.getTime())

        if (comparison === 0 && a.dueDate && b.dueDate) {
          comparison = compareNullable(a.dueTime, b.dueTime, (x, y) => x.localeCompare(y))
        }
        break
      }

      case 'priority':
        comparison = priorityOrder[a.priority] - priorityOrder[b.priority]
        break

      case 'createdAt':
        comparison = a.createdAt.getTime() - b.createdAt.getTime()
        break

      case 'title':
        comparison = a.title.localeCompare(b.title)
        break

      case 'status': {
        const statusTypeOrder = { todo: 0, in_progress: 1, done: 2 } satisfies Record<
          StatusType,
          number
        >
        const getStatusOrder = (task: T): number => {
          const proj = projects.find((p) => p.id === task.projectId)
          const status = proj?.statuses.find((s) => s.id === task.statusId)
          if (!status) return 99
          return statusTypeOrder[status.type] * 100 + status.order
        }
        comparison = getStatusOrder(a) - getStatusOrder(b)
        break
      }

      case 'project': {
        const projectA = projects.find((p) => p.id === a.projectId)?.name || ''
        const projectB = projects.find((p) => p.id === b.projectId)?.name || ''
        comparison = projectA.localeCompare(projectB)
        break
      }

      case 'completedAt':
        comparison = compareNullable(
          a.completedAt,
          b.completedAt,
          (x, y) => x.getTime() - y.getTime()
        )
        break
    }

    return sort.direction === 'desc' ? -comparison : comparison
  })

  return sorted
}

export const applyFiltersAndSort = <T extends FilterTask>(
  tasks: T[],
  filters: TaskFilters,
  sort: TaskSort,
  projects: readonly FilterProject[],
  now: Date,
  weekStartsOn: 0 | 1
): T[] => {
  const topLevel = tasks.filter((t) => t.parentId === null)
  const subtasks = tasks.filter((t) => t.parentId !== null)

  let result = [...topLevel]

  if (filters.search) {
    result = filterBySearch(result, filters.search)
  }

  if (filters.projectIds.length > 0) {
    result = filterByProjects(result, filters.projectIds)
  }

  if (filters.priorities.length > 0) {
    result = filterByPriorities(result, filters.priorities)
  }

  if (filters.tags.length > 0) {
    result = filterByTags(result, filters.tags)
  }

  result = filterByDueDateRange(result, filters.dueDate, now, weekStartsOn)

  if (filters.statusIds.length > 0) {
    result = filterByStatuses(result, filters.statusIds)
  }

  result = filterByCompletion(result, filters.completion, projects)

  result = filterByRepeatType(result, filters.repeatType)

  result = filterByHasTime(result, filters.hasTime)

  const survivingParentIds = new Set(result.map((t) => t.id))
  const attachedSubtasks = subtasks.filter(
    (t) => t.parentId !== null && survivingParentIds.has(t.parentId)
  )

  return sortTasksAdvanced([...result, ...attachedSubtasks], sort, projects)
}

export const hasActiveFilters = (filters: TaskFilters): boolean => {
  return (
    filters.search !== '' ||
    filters.projectIds.length > 0 ||
    filters.priorities.length > 0 ||
    filters.tags.length > 0 ||
    filters.dueDate.type !== 'any' ||
    filters.statusIds.length > 0 ||
    filters.completion !== 'active' ||
    filters.repeatType !== 'all' ||
    filters.hasTime !== 'all'
  )
}

export const countActiveFilters = (filters: TaskFilters): number => {
  let count = 0
  if (filters.search) count++
  if (filters.projectIds.length > 0) count++
  if (filters.priorities.length > 0) count++
  if (filters.tags.length > 0) count++
  if (filters.dueDate.type !== 'any') count++
  if (filters.statusIds.length > 0) count++
  if (filters.completion !== 'active') count++
  if (filters.repeatType !== 'all') count++
  if (filters.hasTime !== 'all') count++
  return count
}
