import type { Priority } from '@/data/sample-tasks'
import type { Project, StatusType } from '@/data/tasks-data'
import { startOfDay, addDays } from '@/lib/task-utils'

export type ColumnDropResult =
  | { type: 'priority'; priority: Priority }
  | { type: 'dueDate'; dueDate: Date | null; bucketLabel: string }
  | { type: 'project'; projectId: string }
  | { type: 'canonicalStatus'; statusType: StatusType }
  | { type: 'projectStatus'; columnId: string; project: Project }

const VALID_PRIORITIES = new Set<string>(['urgent', 'high', 'medium', 'low', 'none'])
const CANONICAL_STATUSES = new Set<string>(['todo', 'in_progress', 'done'])

export const dueBucketToDate = (bucket: string): { date: Date | null; label: string } => {
  const now = new Date()
  switch (bucket) {
    case 'overdue':
      return { date: null, label: 'No Due Date' }
    case 'today':
      return { date: startOfDay(now), label: 'Today' }
    case 'tomorrow':
      return { date: startOfDay(addDays(now, 1)), label: 'Tomorrow' }
    case 'upcoming':
      return { date: startOfDay(addDays(now, 3)), label: 'This Week' }
    case 'later':
      return { date: startOfDay(addDays(now, 14)), label: 'Later' }
    case 'noDueDate':
      return { date: null, label: 'No Due Date' }
    default:
      return { date: null, label: 'No Due Date' }
  }
}

export const resolveColumnDrop = (
  targetColumnId: string,
  projects: Project[]
): ColumnDropResult | null => {
  if (targetColumnId.startsWith('priority-')) {
    const level = targetColumnId.slice('priority-'.length)
    if (VALID_PRIORITIES.has(level)) {
      return { type: 'priority', priority: level as Priority }
    }
    return null
  }

  if (targetColumnId.startsWith('due-')) {
    const bucket = targetColumnId.slice('due-'.length)
    const { date, label } = dueBucketToDate(bucket)
    return { type: 'dueDate', dueDate: date, bucketLabel: label }
  }

  if (targetColumnId.startsWith('project-')) {
    const projectId = targetColumnId.slice('project-'.length)
    return { type: 'project', projectId }
  }

  if (CANONICAL_STATUSES.has(targetColumnId)) {
    return { type: 'canonicalStatus', statusType: targetColumnId as StatusType }
  }

  const project = projects.find((p) => p.statuses.some((s) => s.id === targetColumnId))
  if (project) {
    return { type: 'projectStatus', columnId: targetColumnId, project }
  }

  return null
}
