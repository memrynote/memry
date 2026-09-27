import type { TaskUpdateInput } from '@memry/rpc/tasks'
import { formatDateKey } from '@/lib/task-utils'
import type { Task as UiTask, RepeatConfig as UiRepeatConfig } from '@/data/task-model'

export const priorityReverseMap: Record<UiTask['priority'], number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4
}

export function toServiceRepeatConfig(config: UiRepeatConfig | null | undefined) {
  if (config === undefined) return undefined
  if (config === null) return null

  return {
    frequency: config.frequency,
    interval: config.interval,
    daysOfWeek: config.daysOfWeek,
    monthlyType: config.monthlyType,
    dayOfMonth: config.dayOfMonth,
    weekOfMonth: config.weekOfMonth,
    dayOfWeekForMonth: config.dayOfWeekForMonth,
    endType: config.endType,
    endDate: config.endDate ? formatDateKey(config.endDate) : null,
    endCount: config.endCount,
    completedCount: config.completedCount,
    createdAt: config.createdAt.toISOString()
  }
}

const toDateKey = (date: Date | null | undefined): string | null =>
  date ? formatDateKey(date) : null

/**
 * The `tasks:update` payload for a view-model edit. A key the edit does not
 * carry is left out entirely: main reads a missing key as "untouched", so an
 * `undefined` here must never become a `null` (that would clear the column).
 * Dates and times are the reverse: `null` in the edit means "clear it" and has
 * to reach main as `null`.
 *
 * `completedAt` and `archivedAt` are not fields of this payload; they go
 * through `complete` / `archive` and are the caller's to split off.
 */
export function toTaskUpdateInput(taskId: string, updates: Partial<UiTask>): TaskUpdateInput {
  const input: TaskUpdateInput = {
    id: taskId,
    title: updates.title,
    description: updates.description ?? undefined,
    priority: updates.priority !== undefined ? priorityReverseMap[updates.priority] : undefined,
    projectId: updates.projectId,
    statusId: updates.statusId ?? undefined,
    parentId: updates.parentId ?? undefined,
    dueDate: 'dueDate' in updates ? toDateKey(updates.dueDate) : undefined,
    startDate: 'startDate' in updates ? toDateKey(updates.startDate) : undefined,
    dueTime: 'dueTime' in updates ? updates.dueTime : undefined,
    isRepeating: updates.isRepeating,
    repeatConfig: toServiceRepeatConfig(updates.repeatConfig),
    repeatFrom: updates.repeatFrom,
    linkedNoteIds: updates.linkedNoteIds,
    linkedCanvasIds: updates.linkedCanvasIds,
    tags: updates.tags
  }
  for (const key of Object.keys(input) as (keyof TaskUpdateInput)[]) {
    if (input[key] === undefined) delete input[key]
  }
  return input
}
