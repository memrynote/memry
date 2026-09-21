import type { Task, Priority } from '@/data/task-model'
import type { Project, SortField, SortDirection, StatusType } from '@/data/tasks-data'
import { priorityConfig } from '@/data/task-model'
import { tasksT } from '@/data/tasks-data'
import {
  groupTasksByDueDate,
  startOfDay,
  differenceInDays,
  type TaskGroupByDate
} from '@/lib/task-utils'
import { getTaskNoteId, type TaskNoteIndex } from '@/lib/task-note-index'

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

// ============================================================================
// DUE DATE GROUPING
// ============================================================================

const DUE_DATE_GROUP_ORDER: (keyof TaskGroupByDate)[] = [
  'overdue',
  'today',
  'tomorrow',
  'upcoming',
  'later',
  'noDueDate'
]

const DUE_DATE_LABELS: Record<
  keyof TaskGroupByDate,
  { label: string; color?: string; variant?: 'overdue' | 'default' }
> = {
  overdue: { label: 'Overdue', color: '#ef4444', variant: 'overdue' },
  today: { label: 'Today', color: '#E5993E' },
  tomorrow: { label: 'Tomorrow', color: '#3B82F6' },
  upcoming: { label: 'This Week', color: '#50505A' },
  later: { label: 'Later' },
  noDueDate: { label: 'No Due Date', color: '#50505A' }
}

export const groupByDueDate = (tasks: Task[]): TaskGroup[] => {
  const grouped = groupTasksByDueDate(tasks, true)

  return DUE_DATE_GROUP_ORDER.map((key) => ({
    key,
    label: DUE_DATE_LABELS[key].label,
    tasks: grouped[key],
    color: DUE_DATE_LABELS[key].color,
    variant: DUE_DATE_LABELS[key].variant
  })).filter((g) => g.tasks.length > 0)
}

// ============================================================================
// PRIORITY GROUPING
// ============================================================================

const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No Priority'
}

export const groupByPriority = (tasks: Task[]): TaskGroup[] => {
  const buckets = new Map<Priority, Task[]>(PRIORITY_ORDER.map((p) => [p, []]))

  tasks.forEach((task) => {
    const priority = task.priority || 'none'
    buckets.get(priority)!.push(task)
  })

  return PRIORITY_ORDER.map((priority) => ({
    key: priority,
    label: PRIORITY_LABELS[priority],
    tasks: buckets.get(priority)!,
    color: priorityConfig[priority].color ?? undefined
  })).filter((g) => g.tasks.length > 0)
}

// ============================================================================
// PROJECT GROUPING
// ============================================================================

export const groupByProject = (tasks: Task[], projects: Project[]): TaskGroup[] => {
  const projectMap = new Map(projects.map((p) => [p.id, p]))
  const buckets = new Map<string, Task[]>()
  const noProject: Task[] = []

  tasks.forEach((task) => {
    if (task.projectId && projectMap.has(task.projectId)) {
      if (!buckets.has(task.projectId)) buckets.set(task.projectId, [])
      buckets.get(task.projectId)!.push(task)
    } else {
      noProject.push(task)
    }
  })

  const result: TaskGroup[] = []

  for (const [projectId, projectTasks] of buckets) {
    const project = projectMap.get(projectId)!
    result.push({
      key: projectId,
      label: project.name,
      tasks: projectTasks,
      color: project.color
    })
  }

  result.sort((a, b) => a.label.localeCompare(b.label))

  if (noProject.length > 0) {
    result.push({ key: 'no-project', label: 'No Project', tasks: noProject })
  }

  return result
}

// ============================================================================
// CREATED DATE GROUPING
// ============================================================================

const CREATED_DATE_ORDER = ['today', 'yesterday', 'thisWeek', 'earlier'] as const

const CREATED_DATE_LABELS: Record<string, { label: string; color?: string }> = {
  today: { label: 'Today', color: '#E5993E' },
  yesterday: { label: 'Yesterday', color: '#3B82F6' },
  thisWeek: { label: 'This Week', color: '#50505A' },
  earlier: { label: 'Earlier', color: '#6b7280' }
}

export const groupByCreatedDate = (tasks: Task[]): TaskGroup[] => {
  const today = startOfDay(new Date())
  const buckets: Record<string, Task[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: []
  }

  tasks.forEach((task) => {
    const createdDate = startOfDay(task.createdAt)
    const daysAgo = differenceInDays(today, createdDate)

    if (daysAgo <= 0) buckets.today.push(task)
    else if (daysAgo === 1) buckets.yesterday.push(task)
    else if (daysAgo <= 7) buckets.thisWeek.push(task)
    else buckets.earlier.push(task)
  })

  return CREATED_DATE_ORDER.map((key) => ({
    key,
    label: CREATED_DATE_LABELS[key].label,
    tasks: buckets[key],
    color: CREATED_DATE_LABELS[key].color
  })).filter((g) => g.tasks.length > 0)
}

// ============================================================================
// STATUS GROUPING
// ============================================================================

const STATUS_TYPE_ORDER: StatusType[] = ['todo', 'in_progress']

const STATUS_TYPE_LABELS: Record<StatusType, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done'
}

export const groupByStatus = (tasks: Task[], projects: Project[]): TaskGroup[] => {
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

  const buckets = new Map<StatusType, Task[]>()
  const uncategorized: Task[] = []

  tasks.forEach((task) => {
    const info = statusLookup.get(task.statusId)
    if (info) {
      if (info.type === 'done') return
      if (!buckets.has(info.type)) buckets.set(info.type, [])
      buckets.get(info.type)!.push(task)
    } else {
      uncategorized.push(task)
    }
  })

  const result: TaskGroup[] = STATUS_TYPE_ORDER.filter((type) => buckets.has(type)).map((type) => ({
    key: type,
    label: STATUS_TYPE_LABELS[type],
    tasks: buckets.get(type)!,
    color: typeColors.get(type)
  }))

  if (uncategorized.length > 0) {
    result.push({ key: 'uncategorized', label: 'Uncategorized', tasks: uncategorized })
  }

  return result
}

// ============================================================================
// FOLDER / NOTE GROUPING
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

const vaultRootLabel = (): string => tasksT()?.('filters.groups.vaultRoot') ?? 'Vault root'
const noNoteLabel = (): string => tasksT()?.('filters.groups.noNote') ?? 'No note'

/** `Acme/Legal/NDA` reads as `Acme / Legal / NDA` in a group header. */
const folderGroupLabel = (folderPath: string): string => folderPath.split('/').join(' / ')

interface NoteBucket {
  folderPath: string
  title: string
  tasks: Task[]
}

/**
 * Splits tasks into "has a resolvable source note" and "does not".
 *
 * A note id that the index cannot resolve — a note deleted after the task was
 * written, or one outside the fetched page — counts as unfiled rather than
 * inventing a group with no folder behind it.
 */
const bucketTasksByNote = (
  tasks: Task[],
  noteIndex: TaskNoteIndex
): { byNote: Map<string, NoteBucket>; unfiled: Task[] } => {
  const byNote = new Map<string, NoteBucket>()
  const unfiled: Task[] = []

  tasks.forEach((task) => {
    const noteId = getTaskNoteId(task)
    const info = noteId ? noteIndex.get(noteId) : undefined

    if (!info) {
      unfiled.push(task)
      return
    }

    const bucket = byNote.get(info.id)
    if (bucket) {
      bucket.tasks.push(task)
      return
    }

    byNote.set(info.id, { folderPath: info.folderPath, title: info.title, tasks: [task] })
  })

  return { byNote, unfiled }
}

/**
 * One group per vault folder, ordered by path so a parent folder sits next to
 * its subfolders. Vault-root notes come after the named folders, because the
 * deliberate structure is what the user is scanning for; loose notes and
 * unfiled tasks belong at the bottom.
 */
export const groupByFolder = (tasks: Task[], noteIndex: TaskNoteIndex): TaskGroup[] => {
  const { byNote, unfiled } = bucketTasksByNote(tasks, noteIndex)

  const byFolder = new Map<string, Task[]>()
  for (const bucket of byNote.values()) {
    const folderTasks = byFolder.get(bucket.folderPath)
    if (folderTasks) folderTasks.push(...bucket.tasks)
    else byFolder.set(bucket.folderPath, [...bucket.tasks])
  }

  const result: TaskGroup[] = [...byFolder.entries()]
    .filter(([folderPath]) => folderPath !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folderPath, folderTasks]) => ({
      key: `${FOLDER_GROUP_PREFIX}${folderPath}`,
      label: folderGroupLabel(folderPath),
      tasks: folderTasks
    }))

  const rootTasks = byFolder.get('')
  if (rootTasks && rootTasks.length > 0) {
    result.push({ key: ROOT_FOLDER_GROUP_KEY, label: vaultRootLabel(), tasks: rootTasks })
  }

  if (unfiled.length > 0) {
    result.push({ key: NO_NOTE_GROUP_KEY, label: noNoteLabel(), tasks: unfiled })
  }

  return result
}

/**
 * One group per source note, ordered by folder path first so notes from the
 * same folder stay together and the list reads like the vault tree.
 */
export const groupByNote = (tasks: Task[], noteIndex: TaskNoteIndex): TaskGroup[] => {
  const { byNote, unfiled } = bucketTasksByNote(tasks, noteIndex)

  const result: TaskGroup[] = [...byNote.entries()]
    .sort(
      ([, a], [, b]) => a.folderPath.localeCompare(b.folderPath) || a.title.localeCompare(b.title)
    )
    .map(([noteId, bucket]) => ({
      key: `${NOTE_GROUP_PREFIX}${noteId}`,
      label: bucket.title,
      tasks: bucket.tasks
    }))

  if (unfiled.length > 0) {
    result.push({ key: NO_NOTE_GROUP_KEY, label: noNoteLabel(), tasks: unfiled })
  }

  return result
}

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
): TaskGroup[] => {
  if (sortField === 'title' || sortField === 'completedAt') return []

  let groups: TaskGroup[]

  switch (sortField) {
    case 'dueDate':
      groups = groupByDueDate(tasks)
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
      groups = groupByCreatedDate(tasks)
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
