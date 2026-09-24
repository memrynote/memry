/**
 * Task list grouping (spec 004 TP015), moved from the renderer's
 * `task-grouping.ts` and `groupTasksByDueDate`.
 *
 * A fixed group carries a **label key** (`dueDate.overdue`, `status.todo`, …)
 * rather than display text, so each surface localizes it; a group named by user
 * data (a project, a folder, a note) carries that `name`. `now` is the caller's.
 */
import { startOfDay } from '../parsing/dates.ts'
import type { Priority, StatusType } from '../parsing/types.ts'
import type { FilterProject, FilterTask, SortDirection, SortField, TaskNoteIndex } from './types.ts'

export interface TaskGroup<T> {
  key: string
  /** Stable key for a fixed label; null when `name` is the label. */
  labelKey: string | null
  /** User data naming the group (project, folder path, note title). */
  name: string | null
  tasks: T[]
  color?: string
  variant?: 'overdue' | 'default'
}

const MS_PER_DAY = 1000 * 60 * 60 * 24

const differenceInDays = (date1: Date, date2: Date): number =>
  Math.floor((date1.getTime() - date2.getTime()) / MS_PER_DAY)

// ============================================================================
// DUE DATE
// ============================================================================

const DUE_DATE_GROUP_ORDER = [
  'overdue',
  'today',
  'tomorrow',
  'upcoming',
  'later',
  'noDueDate'
] as const
type DueDateGroupKey = (typeof DUE_DATE_GROUP_ORDER)[number]

const DUE_DATE_STYLE: Record<DueDateGroupKey, { color?: string; variant?: 'overdue' }> = {
  overdue: { color: '#ef4444', variant: 'overdue' },
  today: { color: '#E5993E' },
  tomorrow: { color: '#3B82F6' },
  upcoming: { color: '#50505A' },
  later: {},
  noDueDate: { color: '#50505A' }
}

/** Buckets by due date relative to `now`, keeping input order within a bucket. */
export const bucketTasksByDueDate = <T extends FilterTask>(
  tasks: readonly T[],
  now: Date
): Record<DueDateGroupKey, T[]> => {
  const groups: Record<DueDateGroupKey, T[]> = {
    overdue: [],
    today: [],
    tomorrow: [],
    upcoming: [],
    later: [],
    noDueDate: []
  }
  const today = startOfDay(now)

  tasks.forEach((task) => {
    if (!task.dueDate) {
      groups.noDueDate.push(task)
      return
    }
    const daysUntil = differenceInDays(startOfDay(task.dueDate), today)
    if (daysUntil < 0) groups.overdue.push(task)
    else if (daysUntil === 0) groups.today.push(task)
    else if (daysUntil === 1) groups.tomorrow.push(task)
    else if (daysUntil <= 7) groups.upcoming.push(task)
    else groups.later.push(task)
  })

  return groups
}

export const groupByDueDate = <T extends FilterTask>(tasks: T[], now: Date): TaskGroup<T>[] => {
  const grouped = bucketTasksByDueDate(tasks, now)
  return DUE_DATE_GROUP_ORDER.map((key) => ({
    key,
    labelKey: `dueDate.${key}`,
    name: null,
    tasks: grouped[key],
    color: DUE_DATE_STYLE[key].color,
    variant: DUE_DATE_STYLE[key].variant
  })).filter((g) => g.tasks.length > 0)
}

// ============================================================================
// PRIORITY
// ============================================================================

const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

/** Desktop's `priorityConfig[priority].color`. */
export const PRIORITY_COLOR_VARS: Record<Priority, string> = {
  urgent: 'var(--task-priority-urgent)',
  high: 'var(--task-priority-high)',
  medium: 'var(--task-priority-medium)',
  low: 'var(--task-priority-low)',
  none: 'var(--task-priority-none)'
}

export const groupByPriority = <T extends FilterTask>(tasks: T[]): TaskGroup<T>[] => {
  const buckets = new Map<Priority, T[]>(PRIORITY_ORDER.map((p) => [p, []]))

  tasks.forEach((task) => {
    const priority = task.priority || 'none'
    buckets.get(priority)?.push(task)
  })

  return PRIORITY_ORDER.map((priority) => ({
    key: priority,
    labelKey: `priority.${priority}`,
    name: null,
    tasks: buckets.get(priority) ?? [],
    color: PRIORITY_COLOR_VARS[priority]
  })).filter((g) => g.tasks.length > 0)
}

// ============================================================================
// PROJECT
// ============================================================================

export const groupByProject = <T extends FilterTask>(
  tasks: T[],
  projects: readonly FilterProject[]
): TaskGroup<T>[] => {
  const projectMap = new Map(projects.map((p) => [p.id, p]))
  const buckets = new Map<string, T[]>()
  const noProject: T[] = []

  tasks.forEach((task) => {
    const bucket = buckets.get(task.projectId)
    if (bucket) bucket.push(task)
    else if (task.projectId && projectMap.has(task.projectId)) buckets.set(task.projectId, [task])
    else noProject.push(task)
  })

  const result: TaskGroup<T>[] = []
  for (const [projectId, projectTasks] of buckets) {
    const project = projectMap.get(projectId)
    if (!project) continue
    result.push({
      key: projectId,
      labelKey: null,
      name: project.name,
      tasks: projectTasks,
      color: project.color
    })
  }

  result.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))

  if (noProject.length > 0) {
    result.push({ key: 'no-project', labelKey: 'project.none', name: null, tasks: noProject })
  }

  return result
}

// ============================================================================
// CREATED DATE
// ============================================================================

const CREATED_DATE_ORDER = ['today', 'yesterday', 'thisWeek', 'earlier'] as const

const CREATED_DATE_COLORS: Record<(typeof CREATED_DATE_ORDER)[number], string> = {
  today: '#E5993E',
  yesterday: '#3B82F6',
  thisWeek: '#50505A',
  earlier: '#6b7280'
}

export const groupByCreatedDate = <T extends FilterTask>(tasks: T[], now: Date): TaskGroup<T>[] => {
  const today = startOfDay(now)
  const buckets: Record<(typeof CREATED_DATE_ORDER)[number], T[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: []
  }

  tasks.forEach((task) => {
    const daysAgo = differenceInDays(today, startOfDay(task.createdAt))
    if (daysAgo <= 0) buckets.today.push(task)
    else if (daysAgo === 1) buckets.yesterday.push(task)
    else if (daysAgo <= 7) buckets.thisWeek.push(task)
    else buckets.earlier.push(task)
  })

  return CREATED_DATE_ORDER.map((key) => ({
    key,
    labelKey: `createdAt.${key}`,
    name: null,
    tasks: buckets[key],
    color: CREATED_DATE_COLORS[key]
  })).filter((g) => g.tasks.length > 0)
}

// ============================================================================
// STATUS
// ============================================================================

const STATUS_TYPE_ORDER: StatusType[] = ['todo', 'in_progress']

export const groupByStatus = <T extends FilterTask>(
  tasks: T[],
  projects: readonly FilterProject[]
): TaskGroup<T>[] => {
  const statusLookup = new Map<string, { type: StatusType; color: string }>()
  projects.forEach((project) => {
    project.statuses.forEach((status) => {
      if (!statusLookup.has(status.id)) {
        statusLookup.set(status.id, { type: status.type, color: status.color })
      }
    })
  })

  const typeColors = new Map<StatusType, string>()
  for (const { type, color } of statusLookup.values()) {
    if (!typeColors.has(type)) typeColors.set(type, color)
  }

  const buckets = new Map<StatusType, T[]>()
  const uncategorized: T[] = []

  tasks.forEach((task) => {
    const info = statusLookup.get(task.statusId)
    if (!info) {
      uncategorized.push(task)
      return
    }
    if (info.type === 'done') return
    const bucket = buckets.get(info.type)
    if (bucket) bucket.push(task)
    else buckets.set(info.type, [task])
  })

  const result: TaskGroup<T>[] = STATUS_TYPE_ORDER.filter((type) => buckets.has(type)).map(
    (type) => ({
      key: type,
      labelKey: `status.${type}`,
      name: null,
      tasks: buckets.get(type) ?? [],
      color: typeColors.get(type)
    })
  )

  if (uncategorized.length > 0) {
    result.push({
      key: 'uncategorized',
      labelKey: 'status.uncategorized',
      name: null,
      tasks: uncategorized
    })
  }

  return result
}

// ============================================================================
// FOLDER / NOTE
// ============================================================================

/**
 * Group keys are namespaced because the collapsed-group set is stored per tab
 * and shared by every grouping mode. Without the prefix a folder literally
 * named `done` would open collapsed, since `done` is a default-collapsed key.
 */
const FOLDER_GROUP_PREFIX = 'folder-'
const NOTE_GROUP_PREFIX = 'note-'
const ROOT_FOLDER_GROUP_KEY = 'folder-vault-root'
const NO_NOTE_GROUP_KEY = 'no-source-note'

/** `Acme/Legal/NDA` reads as `Acme / Legal / NDA` in a group header. */
const folderGroupLabel = (folderPath: string): string => folderPath.split('/').join(' / ')

/**
 * The note a task is filed under: `sourceNoteId`, else the first related note,
 * else none.
 */
export const getTaskNoteId = (task: FilterTask): string | null =>
  task.sourceNoteId ?? task.linkedNoteIds[0] ?? null

interface NoteBucket<T> {
  folderPath: string
  title: string
  tasks: T[]
}

const bucketTasksByNote = <T extends FilterTask>(
  tasks: T[],
  noteIndex: TaskNoteIndex
): { byNote: Map<string, NoteBucket<T>>; unfiled: T[] } => {
  const byNote = new Map<string, NoteBucket<T>>()
  const unfiled: T[] = []

  tasks.forEach((task) => {
    const noteId = getTaskNoteId(task)
    const info = noteId ? noteIndex.get(noteId) : undefined
    if (!info) {
      unfiled.push(task)
      return
    }
    const bucket = byNote.get(info.id)
    if (bucket) bucket.tasks.push(task)
    else byNote.set(info.id, { folderPath: info.folderPath, title: info.title, tasks: [task] })
  })

  return { byNote, unfiled }
}

export const groupByFolder = <T extends FilterTask>(
  tasks: T[],
  noteIndex: TaskNoteIndex
): TaskGroup<T>[] => {
  const { byNote, unfiled } = bucketTasksByNote(tasks, noteIndex)

  const byFolder = new Map<string, T[]>()
  for (const bucket of byNote.values()) {
    const folderTasks = byFolder.get(bucket.folderPath)
    if (folderTasks) folderTasks.push(...bucket.tasks)
    else byFolder.set(bucket.folderPath, [...bucket.tasks])
  }

  const result: TaskGroup<T>[] = [...byFolder.entries()]
    .filter(([folderPath]) => folderPath !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folderPath, folderTasks]) => ({
      key: `${FOLDER_GROUP_PREFIX}${folderPath}`,
      labelKey: null,
      name: folderGroupLabel(folderPath),
      tasks: folderTasks
    }))

  const rootTasks = byFolder.get('')
  if (rootTasks && rootTasks.length > 0) {
    result.push({
      key: ROOT_FOLDER_GROUP_KEY,
      labelKey: 'folder.vaultRoot',
      name: null,
      tasks: rootTasks
    })
  }

  if (unfiled.length > 0) {
    result.push({ key: NO_NOTE_GROUP_KEY, labelKey: 'note.none', name: null, tasks: unfiled })
  }

  return result
}

export const groupByNote = <T extends FilterTask>(
  tasks: T[],
  noteIndex: TaskNoteIndex
): TaskGroup<T>[] => {
  const { byNote, unfiled } = bucketTasksByNote(tasks, noteIndex)

  const result: TaskGroup<T>[] = [...byNote.entries()]
    .sort(
      ([, a], [, b]) => a.folderPath.localeCompare(b.folderPath) || a.title.localeCompare(b.title)
    )
    .map(([noteId, bucket]) => ({
      key: `${NOTE_GROUP_PREFIX}${noteId}`,
      labelKey: null,
      name: bucket.title,
      tasks: bucket.tasks
    }))

  if (unfiled.length > 0) {
    result.push({ key: NO_NOTE_GROUP_KEY, labelKey: 'note.none', name: null, tasks: unfiled })
  }

  return result
}

// ============================================================================
// DISPATCHER
// ============================================================================

export const groupTasksForSort = <T extends FilterTask>(
  tasks: T[],
  sortField: SortField,
  sortDirection: SortDirection,
  projects: readonly FilterProject[],
  now: Date,
  /**
   * Required by the `folder` and `note` modes only. While the notes list is
   * still loading it is undefined, and those modes return no groups so the
   * caller renders the flat list.
   */
  noteIndex?: TaskNoteIndex
): TaskGroup<T>[] => {
  if (sortField === 'title' || sortField === 'completedAt') return []

  let groups: TaskGroup<T>[]

  switch (sortField) {
    case 'dueDate':
      groups = groupByDueDate(tasks, now)
      break
    case 'priority':
      groups = groupByPriority(tasks)
      break
    case 'status':
      groups = groupByStatus(tasks, projects)
      break
    case 'project':
      groups = groupByProject(tasks, projects)
      break
    case 'createdAt':
      groups = groupByCreatedDate(tasks, now)
      break
    case 'folder':
      if (!noteIndex) return []
      groups = groupByFolder(tasks, noteIndex)
      break
    case 'note':
      if (!noteIndex) return []
      groups = groupByNote(tasks, noteIndex)
      break
    default:
      return []
  }

  if (sortDirection === 'desc') {
    groups = [...groups].reverse()
  }

  return groups
}
