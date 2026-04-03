import type { Task, Priority } from '@/data/sample-tasks'
import type {
  Project,
  TaskFilters,
  TaskSort,
  DueDateFilter,
  CompletionFilterType,
  RepeatFilterType,
  HasTimeFilterType
} from '@/data/tasks-data'
import {
  startOfDay,
  endOfDay,
  addDays,
  addWeeks,
  isBefore,
  isWithinInterval,
  isSameDay,
  startOfWeek,
  endOfWeek,
  endOfMonth
} from './task-date-utils'

// ============================================================================
// ADVANCED FILTER FUNCTIONS
// ============================================================================

export const filterBySearch = (tasks: Task[], query: string): Task[] => {
  if (!query.trim()) return tasks

  const lowerQuery = query.toLowerCase().trim()

  return tasks.filter((task) => {
    const titleMatch = task.title.toLowerCase().includes(lowerQuery)
    const descMatch = task.description?.toLowerCase().includes(lowerQuery)
    return titleMatch || descMatch
  })
}

export const filterByProjects = (tasks: Task[], projectIds: string[]): Task[] => {
  if (projectIds.length === 0) return tasks
  return tasks.filter((task) => projectIds.includes(task.projectId))
}

export const scopeTasksByProject = (tasks: Task[], projectId: string | null): Task[] => {
  if (!projectId) return tasks
  return tasks.filter((task) => task.projectId === projectId)
}

export const filterByPriorities = (tasks: Task[], priorities: Priority[]): Task[] => {
  if (priorities.length === 0) return tasks
  return tasks.filter((task) => priorities.includes(task.priority))
}

export const filterByDueDateRange = (tasks: Task[], filter: DueDateFilter): Task[] => {
  const now = new Date()
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
      const weekEnd = endOfWeek(now, 0)
      return tasks.filter(
        (t) => t.dueDate && isWithinInterval(t.dueDate, { start: todayStart, end: weekEnd })
      )
    }

    case 'next-week': {
      const nextWeekStart = startOfWeek(addWeeks(now, 1), 0)
      const nextWeekEnd = endOfWeek(addWeeks(now, 1), 0)
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

export const filterByStatuses = (tasks: Task[], statusIds: string[]): Task[] => {
  if (statusIds.length === 0) return tasks
  return tasks.filter((t) => statusIds.includes(t.statusId))
}

export const filterByCompletion = (
  tasks: Task[],
  completion: CompletionFilterType,
  projects: Project[]
): Task[] => {
  const isComplete = (task: Task): boolean => {
    const project = projects.find((p) => p.id === task.projectId)
    const status = project?.statuses.find((s) => s.id === task.statusId)
    return status?.type === 'done'
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

export const filterByRepeatType = (tasks: Task[], type: RepeatFilterType): Task[] => {
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

export const filterByHasTime = (tasks: Task[], type: HasTimeFilterType): Task[] => {
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

export const sortTasksAdvanced = (tasks: Task[], sort: TaskSort, projects: Project[]): Task[] => {
  const priorityOrder: Record<Priority, number> = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
    none: 4
  }

  const sorted = [...tasks].sort((a, b) => {
    let comparison = 0

    switch (sort.field) {
      case 'dueDate': {
        if (!a.dueDate && !b.dueDate) {
          comparison = 0
        } else if (!a.dueDate) {
          comparison = 1
        } else if (!b.dueDate) {
          comparison = -1
        } else {
          comparison = a.dueDate.getTime() - b.dueDate.getTime()

          if (comparison === 0) {
            if (!a.dueTime && !b.dueTime) {
              comparison = 0
            } else if (!a.dueTime) {
              comparison = 1
            } else if (!b.dueTime) {
              comparison = -1
            } else {
              comparison = a.dueTime.localeCompare(b.dueTime)
            }
          }
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
        const statusTypeOrder: Record<string, number> = { todo: 0, in_progress: 1, done: 2 }
        const getStatusOrder = (task: Task): number => {
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
        if (!a.completedAt && !b.completedAt) comparison = 0
        else if (!a.completedAt) comparison = 1
        else if (!b.completedAt) comparison = -1
        else comparison = a.completedAt.getTime() - b.completedAt.getTime()
        break
    }

    return sort.direction === 'desc' ? -comparison : comparison
  })

  return sorted
}

export const applyFiltersAndSort = (
  tasks: Task[],
  filters: TaskFilters,
  sort: TaskSort,
  projects: Project[]
): Task[] => {
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

  result = filterByDueDateRange(result, filters.dueDate)

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
  if (filters.dueDate.type !== 'any') count++
  if (filters.statusIds.length > 0) count++
  if (filters.completion !== 'active') count++
  if (filters.repeatType !== 'all') count++
  if (filters.hasTime !== 'all') count++
  return count
}
