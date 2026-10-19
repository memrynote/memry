/**
 * Turn sticky text into a task create input. The first line goes through the
 * quick-add grammar (`@date`, `!priority`, `+project`, `#tag`, `every …`), the
 * rest becomes the description.
 *
 * @module main/stickies/task-input
 */

import type { TaskCreateInput } from '@memry/contracts/tasks-api'
import {
  formatDateKey,
  parseQuickAdd,
  type Priority,
  type QuickAddProject,
  type RepeatConfig
} from '@memry/domain-tasks/parsing'
import { splitStickyText } from './text'

const PRIORITY_VALUE: Record<Priority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4
}

function toRepeatInput(repeat: RepeatConfig): NonNullable<TaskCreateInput['repeatConfig']> {
  return {
    frequency: repeat.frequency,
    interval: repeat.interval,
    daysOfWeek: repeat.daysOfWeek,
    monthlyType: repeat.monthlyType,
    dayOfMonth: repeat.dayOfMonth,
    weekOfMonth: repeat.weekOfMonth,
    dayOfWeekForMonth: repeat.dayOfWeekForMonth,
    endType: repeat.endType,
    endDate: repeat.endDate ? formatDateKey(repeat.endDate) : null,
    endCount: repeat.endCount,
    completedCount: repeat.completedCount,
    createdAt: repeat.createdAt.toISOString()
  }
}

export interface StickyTaskContext {
  projects: readonly QuickAddProject[]
  /** The user's default project, when it still exists. */
  defaultProjectId: string | null
  inboxProjectId: string
  now: Date
}

export function toStickyTaskInput(text: string, context: StickyTaskContext): TaskCreateInput {
  const { firstLine, rest } = splitStickyText(text)
  const parsed = parseQuickAdd(firstLine, context.projects, context.now)

  return {
    projectId: parsed.projectId ?? context.defaultProjectId ?? context.inboxProjectId,
    // A line made only of syntax (`@tomorrow`) still needs a title.
    title: (parsed.title.trim() || firstLine).slice(0, 500),
    description: rest || null,
    priority: PRIORITY_VALUE[parsed.priority],
    dueDate: parsed.dueDate ? formatDateKey(parsed.dueDate) : null,
    dueTime: parsed.dueTime,
    tags: parsed.tags.slice(0, 20),
    isRepeating: parsed.repeat !== null,
    repeatConfig: parsed.repeat ? toRepeatInput(parsed.repeat) : null
  }
}
