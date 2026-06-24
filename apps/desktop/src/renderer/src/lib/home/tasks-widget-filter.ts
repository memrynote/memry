import { getFilteredTasks } from '@/lib/task-utils/task-view-helpers'
import { applyFiltersAndSort } from '@/lib/task-utils/task-filters'
import { defaultSort, type Project, type SavedFilter } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'

// Hardcoded date views offered by the Tasks widget header pill.
export type TaskWidgetView = 'today' | 'tomorrow' | 'week'
export const TASK_WIDGET_VIEWS: TaskWidgetView[] = ['today', 'tomorrow', 'week']

export type ResolvedTasksFilter =
  | { kind: 'view'; viewId: TaskWidgetView }
  | { kind: 'saved'; savedFilterId: string }

/** What the header pill should reflect: a saved filter wins, otherwise a date view (default today). */
export function resolveTasksFilter(config: Record<string, unknown>): ResolvedTasksFilter {
  const savedFilterId = typeof config.savedFilterId === 'string' ? config.savedFilterId : null
  if (savedFilterId) return { kind: 'saved', savedFilterId }

  const dateRange = typeof config.dateRange === 'string' ? config.dateRange : 'today'
  const viewId = TASK_WIDGET_VIEWS.includes(dateRange as TaskWidgetView)
    ? (dateRange as TaskWidgetView)
    : 'today'
  return { kind: 'view', viewId }
}

/**
 * Tasks selected for the widget given its config — the single source of truth shared by the
 * widget body (sliced for display), the header pill label, and the header count (length).
 * Mirrors the original widget logic: saved filter > projectId > dateRange view.
 */
export function selectTasksForWidget(
  tasks: Task[],
  projects: Project[],
  savedFilters: SavedFilter[],
  config: Record<string, unknown>
): Task[] {
  const savedFilterId = typeof config.savedFilterId === 'string' ? config.savedFilterId : null
  const savedFilter = savedFilterId ? savedFilters.find((f) => f.id === savedFilterId) : null
  if (savedFilter) {
    return applyFiltersAndSort(
      tasks,
      savedFilter.filters,
      savedFilter.sort ?? defaultSort,
      projects
    )
  }

  const projectId = typeof config.projectId === 'string' ? config.projectId : null
  const dateRange = typeof config.dateRange === 'string' ? config.dateRange : 'today'
  const selectedId = projectId ?? dateRange
  const selectedType = projectId ? 'project' : 'view'
  return getFilteredTasks(tasks, selectedId, selectedType, projects)
}
