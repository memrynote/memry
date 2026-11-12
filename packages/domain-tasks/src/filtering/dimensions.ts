/**
 * One filter per `TaskFilters` dimension. The chip filters chain them in
 * `filters.ts`, and the advanced filter runs them one task at a time per rule
 * (`expression.ts`), so both read a dimension the same way.
 */
import { foldTag } from '@memry/shared/tag-fold'
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
import type { Priority } from '../parsing/types.ts'
import type {
  CompletionFilterType,
  DueDateFilter,
  FilterProject,
  FilterTask,
  HasTimeFilterType,
  RepeatFilterType,
  TaskNoteIndex
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
  const selected = new Set(tags.map(foldTag))
  return tasks.filter((task) => task.tags.some((tag) => selected.has(foldTag(tag))))
}

/**
 * Tasks filed under the selected folders (subfolders included) or notes.
 *
 * A task counts for every note it touches: the one its line lives in and every
 * linked note. "Show tasks" on a note should list the tasks attached to it, not
 * only the ones typed there. A note the index does not know matches nothing,
 * and with no index at all nothing matches: the caller passes one whenever the
 * location filter is set, and an unfiltered list would be the wrong answer.
 */
export const filterByLocation = <T extends FilterTask>(
  tasks: T[],
  folderPaths: readonly string[],
  noteIds: readonly string[],
  noteIndex: TaskNoteIndex | undefined
): T[] => {
  if (folderPaths.length === 0 && noteIds.length === 0) return tasks
  if (!noteIndex) return []

  const selectedNotes = new Set(noteIds)
  const inSelectedFolder = (folderPath: string): boolean =>
    folderPaths.some((path) => folderPath === path || folderPath.startsWith(`${path}/`))

  return tasks.filter((task) => {
    const taskNoteIds = task.sourceNoteId
      ? [task.sourceNoteId, ...task.linkedNoteIds]
      : task.linkedNoteIds
    return taskNoteIds.some((noteId) => {
      if (selectedNotes.has(noteId)) return true
      const info = noteIndex.get(noteId)
      return info !== undefined && inSelectedFolder(info.folderPath)
    })
  })
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
