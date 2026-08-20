import { getFilteredTasks, getTasksInDueWindow } from '@/lib/task-utils/task-view-helpers'
import { applyFiltersAndSort } from '@/lib/task-utils/task-filters'
import { defaultSort, type Project, type SavedFilter } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'

// Hardcoded views offered by the Tasks widget header pill. The date views mirror the Tasks page
// tab bar; `nodue` is widget-only and surfaces open work that never got a date.
export type TaskWidgetView = 'all' | 'today' | 'tomorrow' | 'next7' | 'nodue'
export const TASK_WIDGET_DATE_VIEWS: TaskWidgetView[] = ['all', 'today', 'tomorrow', 'next7']
export const TASK_WIDGET_NO_DUE_VIEW: TaskWidgetView = 'nodue'
const TASK_WIDGET_VIEWS: TaskWidgetView[] = [...TASK_WIDGET_DATE_VIEWS, TASK_WIDGET_NO_DUE_VIEW]

export type ResolvedTasksFilter =
  { kind: 'view'; viewId: TaskWidgetView } | { kind: 'saved'; savedFilterId: string }

/** Configs written before the widget adopted the Tasks page windows still say `week`. */
function normalizeView(dateRange: string): TaskWidgetView {
  if (dateRange === 'week' || dateRange === 'upcoming') return 'next7'
  return TASK_WIDGET_VIEWS.includes(dateRange as TaskWidgetView)
    ? (dateRange as TaskWidgetView)
    : 'today'
}

/** What the header pill should reflect: a saved filter wins, otherwise a date view (default today). */
export function resolveTasksFilter(config: Record<string, unknown>): ResolvedTasksFilter {
  const savedFilterId = typeof config.savedFilterId === 'string' ? config.savedFilterId : null
  if (savedFilterId) return { kind: 'saved', savedFilterId }

  const dateRange = typeof config.dateRange === 'string' ? config.dateRange : 'today'
  return { kind: 'view', viewId: normalizeView(dateRange) }
}

/** Open, non-archived tasks with no due date, plus the subtasks of the matching parents. */
function selectTasksWithoutDueDate(tasks: Task[], projects: Project[]): Task[] {
  const open = getFilteredTasks(tasks, 'all', 'view', projects)
  const parentIds = new Set(
    open.filter((task) => task.parentId === null && !task.dueDate).map((task) => task.id)
  )
  return open.filter(
    (task) => parentIds.has(task.id) || (task.parentId !== null && parentIds.has(task.parentId))
  )
}

/**
 * Tasks selected for the widget given its config — the single source of truth shared by the
 * widget body (sliced for display), the header pill label, and the header count (length).
 * Saved filter > projectId > view.
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
  if (projectId) return getFilteredTasks(tasks, projectId, 'project', projects)

  const dateRange = typeof config.dateRange === 'string' ? config.dateRange : 'today'
  const view = normalizeView(dateRange)
  if (view === 'all') return getFilteredTasks(tasks, 'all', 'view', projects)
  if (view === 'nodue') return selectTasksWithoutDueDate(tasks, projects)
  return getTasksInDueWindow(
    tasks.filter((task) => !task.archivedAt),
    projects,
    view
  )
}
