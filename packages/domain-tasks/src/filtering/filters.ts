/**
 * Task filters and sorts (spec 004 TP015), moved from the renderer's
 * `task-filters.ts`. Generic over the task shape; `now` and the week start are
 * the caller's (the renderer reads the Calendar `weekStartDay` setting).
 *
 * `title` and `project` order with `String.prototype.localeCompare` (ICU root
 * collation), which the `task-filtering` vectors pin.
 */
import type { Priority, StatusType } from '../parsing/types.ts'
import { buildTaskTree } from '../tree.ts'
import {
  filterByCompletion,
  filterByDueDateRange,
  filterByHasTime,
  filterByLocation,
  filterByPriorities,
  filterByProjects,
  filterByRepeatType,
  filterBySearch,
  filterByStatuses,
  filterByTags
} from './dimensions.ts'
import { countTaskFilterRules, matchesTaskFilterExpression } from './expression.ts'
import type { FilterProject, FilterTask, TaskFilters, TaskNoteIndex, TaskSort } from './types.ts'

const hasLocation = (filters: TaskFilters): boolean =>
  (filters.folderPaths?.length ?? 0) > 0 || (filters.noteIds?.length ?? 0) > 0

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

  const sorted = tasks.toSorted((a, b) => {
    let comparison = 0

    switch (sort.field) {
      // `folder` and `note` order rows by the note they came from, which lives
      // in the note index the grouping layer holds, not on the task. The group
      // order is decided there, and `note` groups then follow the note body.
      // Here the due date orders the rest: folder groups, and tasks the body
      // does not carry.
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

const applyFilterChain = <T extends FilterTask>(
  tasks: T[],
  filters: TaskFilters,
  projects: readonly FilterProject[],
  now: Date,
  weekStartsOn: 0 | 1,
  noteIndex: TaskNoteIndex | undefined
): T[] => {
  let result = tasks

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

  if (hasLocation(filters)) {
    result = filterByLocation(result, filters.folderPaths ?? [], filters.noteIds ?? [], noteIndex)
  }

  result = filterByDueDateRange(result, filters.dueDate, now, weekStartsOn)

  if (filters.statusIds.length > 0) {
    result = filterByStatuses(result, filters.statusIds)
  }

  result = filterByCompletion(result, filters.completion, projects)

  result = filterByRepeatType(result, filters.repeatType)

  result = filterByHasTime(result, filters.hasTime)

  const expression = filters.expression
  if (expression) {
    const ctx = { now, weekStartsOn, noteIndex }
    result = result.filter((task) => matchesTaskFilterExpression(task, expression, ctx))
  }

  return result
}

/**
 * A filter that picks tasks by what they are, as opposed to the completion
 * and project scopes every list always has. Only these reach below the top
 * level: with none set, a subtask shows exactly when its top-level task does.
 */
const hasNarrowingFilter = (filters: TaskFilters): boolean =>
  filters.search.trim() !== '' ||
  filters.priorities.length > 0 ||
  filters.tags.length > 0 ||
  filters.dueDate.type !== 'any' ||
  filters.statusIds.length > 0 ||
  filters.repeatType !== 'all' ||
  filters.hasTime !== 'all' ||
  hasLocation(filters) ||
  countTaskFilterRules(filters.expression) > 0

export interface FilteredTasks<T> {
  tasks: T[]
  /**
   * Ancestors shown only so a deeper match keeps its place in the tree. They
   * did not match the filters themselves; lists draw them muted.
   */
  contextIds: Set<string>
}

/**
 * Top-level tasks that match bring their whole branch, at any depth. With a
 * narrowing filter set, a deeper task that matches also shows, with its own
 * branch and with its ancestors as context.
 */
export const applyFiltersAndSortWithContext = <T extends FilterTask>(
  tasks: T[],
  filters: TaskFilters,
  sort: TaskSort,
  projects: readonly FilterProject[],
  now: Date,
  weekStartsOn: 0 | 1,
  /** Required for `folderPaths`/`noteIds` and `location` rules to match anything; see `filterByLocation`. */
  noteIndex?: TaskNoteIndex
): FilteredTasks<T> => {
  const tree = buildTaskTree(tasks)
  const roots = tasks.filter((t) => tree.parentOf(t.id) === null)
  const included = new Set<string>()
  const contextIds = new Set<string>()
  const includeBranch = (id: string): void => {
    included.add(id)
    contextIds.delete(id)
    for (const descendantId of tree.descendantIds(id)) {
      included.add(descendantId)
      contextIds.delete(descendantId)
    }
  }

  for (const root of applyFilterChain(roots, filters, projects, now, weekStartsOn, noteIndex)) {
    includeBranch(root.id)
  }

  if (hasNarrowingFilter(filters)) {
    const deeper = tasks.filter((t) => tree.parentOf(t.id) !== null && !included.has(t.id))
    for (const match of applyFilterChain(deeper, filters, projects, now, weekStartsOn, noteIndex)) {
      if (included.has(match.id) && !contextIds.has(match.id)) continue
      const ancestorIds = tree.ancestorIds(match.id)
      // Under a missing parent the task is in no tree, so it shows nowhere.
      const top = ancestorIds[ancestorIds.length - 1]
      if (top === undefined || tree.parentOf(top) !== null) continue
      for (const ancestorId of ancestorIds) {
        if (included.has(ancestorId)) continue
        included.add(ancestorId)
        contextIds.add(ancestorId)
      }
      includeBranch(match.id)
    }
  }

  return {
    // Roots first, then deeper rows, each in input order: the order the sort
    // breaks ties by, which the `task-filtering` vectors pin.
    tasks: sortTasksAdvanced(
      [
        ...roots.filter((t) => included.has(t.id)),
        ...tasks.filter((t) => included.has(t.id) && tree.parentOf(t.id) !== null)
      ],
      sort,
      projects
    ),
    contextIds
  }
}

export const applyFiltersAndSort = <T extends FilterTask>(
  tasks: T[],
  filters: TaskFilters,
  sort: TaskSort,
  projects: readonly FilterProject[],
  now: Date,
  weekStartsOn: 0 | 1,
  /** Required for `folderPaths`/`noteIds` and `location` rules to match anything; see `filterByLocation`. */
  noteIndex?: TaskNoteIndex
): T[] =>
  applyFiltersAndSortWithContext(tasks, filters, sort, projects, now, weekStartsOn, noteIndex).tasks

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
    filters.hasTime !== 'all' ||
    hasLocation(filters) ||
    countTaskFilterRules(filters.expression) > 0
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
  if (hasLocation(filters)) count++
  // Each advanced rule counts on its own, so the badge reads "3" for three rules.
  return count + countTaskFilterRules(filters.expression)
}
