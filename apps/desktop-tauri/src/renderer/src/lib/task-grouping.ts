import type { Task } from '@/data/task-model'
import type { Project, SortField, SortDirection } from '@/data/tasks-data'
import { tasksT } from '@/data/tasks-data'
import type { TaskNoteIndex } from '@/lib/task-note-index'
import {
  groupByCreatedDate as groupByCreatedDateAt,
  groupByDueDate as groupByDueDateAt,
  groupByFolder as groupByFolderAt,
  groupByNote as groupByNoteAt,
  groupByPriority as groupByPriorityAt,
  groupByProject as groupByProjectAt,
  groupByStatus as groupByStatusAt,
  groupTasksForSort as groupTasksForSortAt,
  type TaskGroup as CoreTaskGroup
} from '@memry/domain-tasks/filtering'

// The grouping rules live in `@memry/domain-tasks/filtering`, pinned for the iOS
// core by the `task-filtering` vectors (spec 004 TP015). Groups there carry a
// label key; this module turns keys into the labels desktop has always shown.

// ============================================================================
// TYPES
// ============================================================================

export interface TaskGroup {
  key: string
  label: string
  tasks: Task[]
  color?: string
  variant?: 'overdue' | 'default'
}

const FIXED_LABELS: Record<string, () => string> = {
  'dueDate.overdue': () => 'Overdue',
  'dueDate.today': () => 'Today',
  'dueDate.tomorrow': () => 'Tomorrow',
  'dueDate.upcoming': () => 'This Week',
  'dueDate.later': () => 'Later',
  'dueDate.noDueDate': () => 'No Due Date',
  'priority.urgent': () => 'Urgent',
  'priority.high': () => 'High',
  'priority.medium': () => 'Medium',
  'priority.low': () => 'Low',
  'priority.none': () => 'No Priority',
  'project.none': () => 'No Project',
  'createdAt.today': () => 'Today',
  'createdAt.yesterday': () => 'Yesterday',
  'createdAt.thisWeek': () => 'This Week',
  'createdAt.earlier': () => 'Earlier',
  'status.todo': () => 'To Do',
  'status.in_progress': () => 'In Progress',
  'status.done': () => 'Done',
  'status.uncategorized': () => 'Uncategorized',
  'folder.vaultRoot': () => tasksT()?.('filters.groups.vaultRoot') ?? 'Vault root',
  'note.none': () => tasksT()?.('filters.groups.noNote') ?? 'No note'
}

const toGroup = (group: CoreTaskGroup<Task>): TaskGroup => {
  const label = group.labelKey
    ? (FIXED_LABELS[group.labelKey]?.() ?? group.labelKey)
    : (group.name ?? '')
  const result: TaskGroup = { key: group.key, label, tasks: group.tasks }
  if (group.color !== undefined) result.color = group.color
  if (group.variant !== undefined) result.variant = group.variant
  return result
}

export const groupByDueDate = (tasks: Task[], now: Date = new Date()): TaskGroup[] =>
  groupByDueDateAt(tasks, now).map(toGroup)

export const groupByPriority = (tasks: Task[]): TaskGroup[] => groupByPriorityAt(tasks).map(toGroup)

export const groupByProject = (tasks: Task[], projects: Project[]): TaskGroup[] =>
  groupByProjectAt(tasks, projects).map(toGroup)

export const groupByCreatedDate = (tasks: Task[], now: Date = new Date()): TaskGroup[] =>
  groupByCreatedDateAt(tasks, now).map(toGroup)

export const groupByStatus = (tasks: Task[], projects: Project[]): TaskGroup[] =>
  groupByStatusAt(tasks, projects).map(toGroup)

/**
 * One group per vault folder, ordered by path so a parent folder sits next to
 * its subfolders. Vault-root notes come after the named folders; unfiled tasks
 * at the bottom.
 */
export const groupByFolder = (tasks: Task[], noteIndex: TaskNoteIndex): TaskGroup[] =>
  groupByFolderAt(tasks, noteIndex).map(toGroup)

/** One group per source note, ordered by folder path first, then title. */
export const groupByNote = (tasks: Task[], noteIndex: TaskNoteIndex): TaskGroup[] =>
  groupByNoteAt(tasks, noteIndex).map(toGroup)

// ============================================================================
// DISPATCHER
// ============================================================================

export const groupTasksForSort = (
  tasks: Task[],
  sortField: SortField,
  sortDirection: SortDirection,
  projects: Project[],
  /**
   * Required by the `folder` and `note` modes only. While the notes list is
   * still loading it is undefined, and those modes return no groups so the
   * caller renders the flat list instead of parking every task under "No note"
   * for a frame.
   */
  noteIndex?: TaskNoteIndex
): TaskGroup[] =>
  groupTasksForSortAt(tasks, sortField, sortDirection, projects, new Date(), noteIndex).map(toGroup)
