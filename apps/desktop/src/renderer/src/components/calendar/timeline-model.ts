import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { parseLocalDate, toLocalDateString } from './date-utils'

/**
 * What a task's dates say about when the work happens. A task needs both a
 * start and a later due date to span; a single date is a point in time.
 */
export type TimelineSchedule =
  | { kind: 'span'; startDate: string; dueDate: string }
  | { kind: 'due'; dueDate: string }
  | { kind: 'start'; startDate: string }

/** Column range inside the visible window, 0-based and inclusive. */
export interface TimelineBar {
  columnStart: number
  columnEnd: number
  continuesBefore: boolean
  continuesAfter: boolean
}

export interface TimelineTaskRow {
  taskId: string
  title: string
  schedule: TimelineSchedule
  bar: TimelineBar
}

export interface TimelineProjectGroup {
  projectId: string
  name: string
  color: string
  bar: TimelineBar
  rows: TimelineTaskRow[]
}

export function getMonthDays(anchorDate: string): string[] {
  const anchor = parseLocalDate(anchorDate)
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  return Array.from({ length: daysInMonth }, (_, i) =>
    toLocalDateString(new Date(year, month, i + 1))
  )
}

export function toTimelineSchedule(
  task: Pick<Task, 'startDate' | 'dueDate'>
): TimelineSchedule | null {
  const startDate = task.startDate ? toLocalDateString(task.startDate) : null
  const dueDate = task.dueDate ? toLocalDateString(task.dueDate) : null
  if (startDate && dueDate && startDate < dueDate) return { kind: 'span', startDate, dueDate }
  if (dueDate) return { kind: 'due', dueDate }
  if (startDate) return { kind: 'start', startDate }
  return null
}

function scheduleBounds(schedule: TimelineSchedule): { first: string; last: string } {
  switch (schedule.kind) {
    case 'span':
      return { first: schedule.startDate, last: schedule.dueDate }
    case 'due':
      return { first: schedule.dueDate, last: schedule.dueDate }
    case 'start':
      return { first: schedule.startDate, last: schedule.startDate }
  }
}

function clipToWindow(first: string, last: string, days: string[]): TimelineBar | null {
  const windowStart = days[0]
  const windowEnd = days[days.length - 1]
  if (!windowStart || last < windowStart || first > windowEnd) return null
  const continuesBefore = first < windowStart
  const continuesAfter = last > windowEnd
  return {
    columnStart: continuesBefore ? 0 : days.indexOf(first),
    columnEnd: continuesAfter ? days.length - 1 : days.indexOf(last),
    continuesBefore,
    continuesAfter
  }
}

/**
 * Open, dated tasks that touch `days`, grouped under their project in the
 * order `projects` gives. Each project carries one summary bar covering its
 * rows so the group's extent reads at a glance.
 */
export function buildTimelineGroups(
  tasks: readonly Task[],
  projects: readonly Project[],
  days: string[]
): TimelineProjectGroup[] {
  const rowsByProject = new Map<string, TimelineTaskRow[]>()

  for (const task of tasks) {
    if (task.completedAt || task.archivedAt) continue
    const schedule = toTimelineSchedule(task)
    if (!schedule) continue
    const { first, last } = scheduleBounds(schedule)
    const bar = clipToWindow(first, last, days)
    if (!bar) continue
    const rows = rowsByProject.get(task.projectId) ?? []
    rows.push({ taskId: task.id, title: task.title, schedule, bar })
    rowsByProject.set(task.projectId, rows)
  }

  return projects.flatMap((project) => {
    const rows = rowsByProject.get(project.id)
    if (project.isArchived || !rows) return []
    rows.sort(
      (a, b) =>
        a.bar.columnStart - b.bar.columnStart ||
        a.bar.columnEnd - b.bar.columnEnd ||
        a.title.localeCompare(b.title)
    )
    return [
      {
        projectId: project.id,
        name: project.name,
        color: project.color,
        bar: {
          columnStart: Math.min(...rows.map((row) => row.bar.columnStart)),
          columnEnd: Math.max(...rows.map((row) => row.bar.columnEnd)),
          continuesBefore: rows.some((row) => row.bar.continuesBefore),
          continuesAfter: rows.some((row) => row.bar.continuesAfter)
        },
        rows
      }
    ]
  })
}
