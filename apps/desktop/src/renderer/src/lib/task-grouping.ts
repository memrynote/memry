import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, SortField, SortDirection } from '@/data/tasks-data'
import { priorityConfig } from '@/data/sample-tasks'
import {
  groupTasksByDueDate,
  startOfDay,
  differenceInDays,
  type TaskGroupByDate
} from '@/lib/task-utils'

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
  noDueDate: { label: 'No Due Date' }
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
// DISPATCHER
// ============================================================================

export const groupTasksForSort = (
  tasks: Task[],
  sortField: SortField,
  sortDirection: SortDirection,
  projects: Project[]
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
    case 'project':
      groups = groupByProject(tasks, projects)
      break
    case 'createdAt':
      groups = groupByCreatedDate(tasks)
      break
    default:
      return []
  }

  if (sortDirection === 'desc') {
    groups = [...groups].reverse()
  }

  return groups
}
