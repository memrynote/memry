import type { Task } from '@/data/task-model'
import type { DueDateFilter, Project, TaskFilters, TaskSort } from '@/data/tasks-data'
import { getWeekStartsOn } from '@/lib/week-start'
import {
  applyFiltersAndSort as applyFiltersAndSortAt,
  filterByDueDateRange as filterByDueDateRangeAt
} from '@memry/domain-tasks/filtering'

// The filter and sort rules live in `@memry/domain-tasks/filtering`, pinned for
// the iOS core by the `task-filtering` vectors (spec 004 TP015). This module
// supplies the renderer's clock and the Calendar week-start setting.

export {
  countActiveFilters,
  filterByCompletion,
  filterByHasTime,
  filterByPriorities,
  filterByProjects,
  filterByRepeatType,
  filterBySearch,
  filterByStatuses,
  filterByTags,
  hasActiveFilters,
  sortTasksAdvanced
} from '@memry/domain-tasks/filtering'

export const scopeTasksByProject = (tasks: Task[], projectId: string | null): Task[] => {
  if (!projectId) return tasks
  return tasks.filter((task) => task.projectId === projectId)
}

export const filterByDueDateRange = (
  tasks: Task[],
  filter: DueDateFilter,
  now: Date = new Date()
): Task[] => filterByDueDateRangeAt(tasks, filter, now, getWeekStartsOn())

export const applyFiltersAndSort = (
  tasks: Task[],
  filters: TaskFilters,
  sort: TaskSort,
  projects: Project[],
  now: Date = new Date()
): Task[] => applyFiltersAndSortAt(tasks, filters, sort, projects, now, getWeekStartsOn())
