import type { Priority, Task } from '@/data/task-model'
import type { Project, StatusType } from '@/data/tasks-data'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { EVENT_TYPE_COLORS } from '@/lib/event-type-colors'
import {
  addLocalDays,
  addLocalMonths,
  dayIndexFromDate,
  getStartOfWeek,
  isMultiDaySpan,
  isWeekend,
  parseLocalDate,
  spanEndDateKey,
  spanStartDateKey,
  toLocalDateString
} from './date-utils'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type TimelineZoom = 'weeks' | 'months' | 'quarters'
export type TimelineGroupBy = 'project' | 'status' | 'priority' | 'none'
export type TimelineOrderBy = 'start' | 'due' | 'title'

export const TIMELINE_ZOOMS: TimelineZoom[] = ['weeks', 'months', 'quarters']
export const TIMELINE_GROUP_BYS: TimelineGroupBy[] = ['project', 'status', 'priority', 'none']
export const TIMELINE_ORDER_BYS: TimelineOrderBy[] = ['start', 'due', 'title']

export interface TimelineSettings {
  zoom: TimelineZoom
  groupBy: TimelineGroupBy
  orderBy: TimelineOrderBy
  showEvents: boolean
  showUndated: boolean
  showCompleted: boolean
  showSubtasks: boolean
}

export const DEFAULT_TIMELINE_SETTINGS: TimelineSettings = {
  zoom: 'months',
  groupBy: 'project',
  orderBy: 'start',
  showEvents: true,
  showUndated: true,
  showCompleted: false,
  showSubtasks: false
}

/** Width of one day column, in px, at each zoom. */
export const TIMELINE_DAY_WIDTH: Record<TimelineZoom, number> = {
  weeks: 48,
  months: 26,
  quarters: 8
}

/**
 * How far an open-ended (start date only) bar reaches before it fades out.
 * It is a hint that the work has begun, not a claim about when it ends.
 */
export const OPEN_ENDED_DAYS = 5

// ---------------------------------------------------------------------------
// Window: the continuous stretch of days the timeline lays out
// ---------------------------------------------------------------------------

/** Inclusive range of local day keys. */
export interface TimelineWindow {
  start: string
  end: string
  dayCount: number
}

function makeWindow(start: string, end: string): TimelineWindow {
  return { start, end, dayCount: dayIndexFromDate(end) - dayIndexFromDate(start) + 1 }
}

function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`
}

function startOfQuarter(date: string): string {
  const month = Number(date.slice(5, 7))
  const quarterMonth = Math.floor((month - 1) / 3) * 3 + 1
  return `${date.slice(0, 4)}-${String(quarterMonth).padStart(2, '0')}-01`
}

/**
 * The days laid out around `anchor`. Generous on both sides so a scroll rarely
 * reaches an edge; when it does, the anchor moves and the window moves with
 * it (see the view's scroll compensation).
 */
export function getTimelineWindow(
  anchor: string,
  zoom: TimelineZoom,
  weekStartsOn: 0 | 1
): TimelineWindow {
  switch (zoom) {
    case 'weeks': {
      const weekStart = getStartOfWeek(anchor, weekStartsOn)
      return makeWindow(addLocalDays(weekStart, -21), addLocalDays(weekStart, 7 * 7 - 1))
    }
    case 'months': {
      const monthStart = startOfMonth(anchor)
      return makeWindow(
        addLocalMonths(monthStart, -2),
        addLocalDays(addLocalMonths(monthStart, 4), -1)
      )
    }
    case 'quarters': {
      const quarterStart = startOfQuarter(anchor)
      return makeWindow(
        addLocalMonths(quarterStart, -6),
        addLocalDays(addLocalMonths(quarterStart, 12), -1)
      )
    }
  }
}

/** Previous / next step of the toolbar arrows. */
export function stepTimelineAnchor(anchor: string, zoom: TimelineZoom, direction: 1 | -1): string {
  switch (zoom) {
    case 'weeks':
      return addLocalDays(anchor, 7 * direction)
    case 'months':
      return addLocalMonths(anchor, direction)
    case 'quarters':
      return addLocalMonths(anchor, 3 * direction)
  }
}

/** The date a toolbar step lands the view on: the start of the stepped period. */
export function timelinePeriodStart(
  anchor: string,
  zoom: TimelineZoom,
  weekStartsOn: 0 | 1
): string {
  switch (zoom) {
    case 'weeks':
      return getStartOfWeek(anchor, weekStartsOn)
    case 'months':
      return startOfMonth(anchor)
    case 'quarters':
      return startOfQuarter(anchor)
  }
}

/** Two dates in the same period need no anchor change while scrolling. */
export function isSameTimelinePeriod(
  a: string,
  b: string,
  zoom: TimelineZoom,
  weekStartsOn: 0 | 1
): boolean {
  return timelinePeriodStart(a, zoom, weekStartsOn) === timelinePeriodStart(b, zoom, weekStartsOn)
}

/** Day offset of `date` from the window's first day. May be outside the window. */
export function dayOffset(date: string, window: TimelineWindow): number {
  return dayIndexFromDate(date) - dayIndexFromDate(window.start)
}

export function dateAtOffset(offset: number, window: TimelineWindow): string {
  return addLocalDays(window.start, offset)
}

// ---------------------------------------------------------------------------
// Axis
// ---------------------------------------------------------------------------

export interface TimelineMonthSpan {
  /** First day of the month, even when the window starts later. */
  month: string
  offset: number
  length: number
}

export function getMonthSpans(window: TimelineWindow): TimelineMonthSpan[] {
  const spans: TimelineMonthSpan[] = []
  let cursor = startOfMonth(window.start)
  while (cursor <= window.end) {
    const next = addLocalMonths(cursor, 1)
    const from = Math.max(0, dayOffset(cursor, window))
    const to = Math.min(window.dayCount, dayOffset(next, window))
    spans.push({ month: cursor, offset: from, length: to - from })
    cursor = next
  }
  return spans
}

export interface TimelineTick {
  date: string
  offset: number
  isWeekend: boolean
}

/**
 * Day labels under the month row. Quarters are too dense for a label per day,
 * so they label each week start instead.
 */
export function getAxisTicks(
  window: TimelineWindow,
  zoom: TimelineZoom,
  weekStartsOn: 0 | 1
): TimelineTick[] {
  const ticks: TimelineTick[] = []
  for (let offset = 0; offset < window.dayCount; offset++) {
    const date = dateAtOffset(offset, window)
    if (zoom === 'quarters' && parseLocalDate(date).getDay() !== weekStartsOn) continue
    ticks.push({ date, offset, isWeekend: isWeekend(date) })
  }
  return ticks
}

/** Offsets of weekend days, for shading. Empty at quarter zoom, where it is noise. */
export function getWeekendOffsets(window: TimelineWindow, zoom: TimelineZoom): number[] {
  if (zoom === 'quarters') return []
  const offsets: number[] = []
  for (let offset = 0; offset < window.dayCount; offset++) {
    if (isWeekend(dateAtOffset(offset, window))) offsets.push(offset)
  }
  return offsets
}

// ---------------------------------------------------------------------------
// Shapes: what a task's dates say about when the work happens
// ---------------------------------------------------------------------------

/**
 * A task needs a start and a later due date to span. A due date alone (or a
 * start equal to it) is a milestone; a start date alone opens a bar with no
 * known end; no date at all leaves the row empty until it is scheduled.
 */
export type TimelineShape =
  | { kind: 'span'; start: string; end: string }
  | { kind: 'due'; date: string }
  | { kind: 'start'; date: string }
  | { kind: 'none' }

export function toTimelineShape(task: Pick<Task, 'startDate' | 'dueDate'>): TimelineShape {
  const start = task.startDate ? toLocalDateString(task.startDate) : null
  const due = task.dueDate ? toLocalDateString(task.dueDate) : null
  if (start && due && start < due) return { kind: 'span', start, end: due }
  if (due) return { kind: 'due', date: due }
  if (start) return { kind: 'start', date: start }
  return { kind: 'none' }
}

/** First and last day a shape draws on, or null for an unscheduled task. */
export function shapeBounds(shape: TimelineShape): { first: string; last: string } | null {
  switch (shape.kind) {
    case 'span':
      return { first: shape.start, last: shape.end }
    case 'due':
      return { first: shape.date, last: shape.date }
    case 'start':
      return { first: shape.date, last: addLocalDays(shape.date, OPEN_ENDED_DAYS - 1) }
    case 'none':
      return null
  }
}

/** Inclusive day offsets inside the window, with flags for cut ends. */
export interface TimelinePlacement {
  from: number
  to: number
  clippedStart: boolean
  clippedEnd: boolean
}

export function placeInWindow(
  first: string,
  last: string,
  window: TimelineWindow
): TimelinePlacement | null {
  if (last < window.start || first > window.end) return null
  const clippedStart = first < window.start
  const clippedEnd = last > window.end
  return {
    from: clippedStart ? 0 : dayOffset(first, window),
    to: clippedEnd ? window.dayCount - 1 : dayOffset(last, window),
    clippedStart,
    clippedEnd
  }
}

// ---------------------------------------------------------------------------
// Rows and groups
// ---------------------------------------------------------------------------

export interface TimelineTaskRow {
  type: 'task'
  key: string
  task: Task
  depth: 0 | 1
  shape: TimelineShape
  placement: TimelinePlacement | null
  /** Open task whose last day is before today. */
  isOverdue: boolean
  isCompleted: boolean
  statusType: StatusType
  statusColor: string
  projectName: string
  color: string
}

export interface TimelineEventRow {
  type: 'event'
  key: string
  item: CalendarProjectionItem
  start: string
  end: string
  placement: TimelinePlacement | null
  color: string
}

export type TimelineRow = TimelineTaskRow | TimelineEventRow

export type TimelineGroupHeading =
  | { kind: 'events' }
  | { kind: 'project'; projectId: string; name: string }
  | { kind: 'status'; status: StatusType }
  | { kind: 'priority'; priority: Priority }
  | { kind: 'all' }

export interface TimelineGroup {
  key: string
  heading: TimelineGroupHeading
  color: string | null
  rows: TimelineRow[]
  /** Extent of every scheduled row, when it covers more than one day. */
  summary: TimelinePlacement | null
}

export interface BuildTimelineInput {
  tasks: readonly Task[]
  projects: readonly Project[]
  events: readonly CalendarProjectionItem[]
  window: TimelineWindow
  today: string
  settings: TimelineSettings
}

const STATUS_ORDER: StatusType[] = ['todo', 'in_progress', 'done']
const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
const NEUTRAL_COLOR = '#9B9A97'

function resolveStatus(task: Task, project: Project): { type: StatusType; color: string } {
  const status = project.statuses.find((candidate) => candidate.id === task.statusId)
  if (status) return { type: status.type, color: status.color }
  return { type: task.completedAt ? 'done' : 'todo', color: NEUTRAL_COLOR }
}

function toTaskRow(
  task: Task,
  project: Project,
  window: TimelineWindow,
  today: string
): TimelineTaskRow | null {
  const shape = toTimelineShape(task)
  const isCompleted = Boolean(task.completedAt)
  const bounds = shapeBounds(shape)
  // An open-ended bar has no deadline, so it cannot slip.
  const lastDay = shape.kind === 'span' ? shape.end : shape.kind === 'due' ? shape.date : null
  const isOverdue = !isCompleted && lastDay !== null && lastDay < today
  const placement = bounds ? placeInWindow(bounds.first, bounds.last, window) : null
  // Overdue work stays listed while today is in view, even when its bar has
  // scrolled away: the slip line to today is the point.
  const todayInWindow = today >= window.start && today <= window.end
  if (bounds && !placement && !(isOverdue && todayInWindow)) return null
  const status = resolveStatus(task, project)
  return {
    type: 'task',
    key: `task:${task.id}`,
    task,
    depth: 0,
    shape,
    placement,
    isOverdue,
    isCompleted,
    statusType: isCompleted ? 'done' : status.type,
    statusColor: status.color,
    projectName: project.name,
    color: project.color
  }
}

function sortKeyFirst(row: TimelineTaskRow, orderBy: TimelineOrderBy): string | null {
  const { shape } = row
  if (shape.kind === 'none') return null
  if (orderBy === 'due') {
    if (shape.kind === 'span') return shape.end
    return shape.date
  }
  return shape.kind === 'span' ? shape.start : shape.date
}

function compareRows(a: TimelineTaskRow, b: TimelineTaskRow, orderBy: TimelineOrderBy): number {
  const byTitle = a.task.title.localeCompare(b.task.title)
  if (orderBy === 'title') return byTitle
  const ka = sortKeyFirst(a, orderBy)
  const kb = sortKeyFirst(b, orderBy)
  if (ka === null || kb === null) {
    if (ka !== kb) return ka === null ? 1 : -1
    return byTitle
  }
  if (ka !== kb) return ka < kb ? -1 : 1
  const ea = shapeBounds(a.shape)?.last ?? ''
  const eb = shapeBounds(b.shape)?.last ?? ''
  if (ea !== eb) return ea < eb ? -1 : 1
  return byTitle
}

/**
 * Orders rows and tucks each visible subtask under its parent. A subtask
 * whose parent is not in the same group stands on its own.
 */
function nestRows(rows: TimelineTaskRow[], orderBy: TimelineOrderBy): TimelineTaskRow[] {
  const ids = new Set(rows.map((row) => row.task.id))
  const children = new Map<string, TimelineTaskRow[]>()
  const roots: TimelineTaskRow[] = []
  for (const row of rows) {
    const parentId = row.task.parentId
    if (parentId && ids.has(parentId)) {
      const list = children.get(parentId) ?? []
      list.push({ ...row, depth: 1 })
      children.set(parentId, list)
    } else {
      roots.push(row)
    }
  }
  roots.sort((a, b) => compareRows(a, b, orderBy))
  return roots.flatMap((root) => {
    const kids = children.get(root.task.id)
    if (!kids) return [root]
    kids.sort((a, b) => compareRows(a, b, orderBy))
    return [root, ...kids]
  })
}

function summarize(rows: readonly TimelineRow[]): TimelinePlacement | null {
  const placed = rows.filter(
    (row): row is TimelineRow & { placement: TimelinePlacement } =>
      row.placement !== null && (row.type === 'event' || row.shape.kind !== 'none')
  )
  if (placed.length === 0) return null
  const summary: TimelinePlacement = {
    from: Math.min(...placed.map((row) => row.placement.from)),
    to: Math.max(...placed.map((row) => row.placement.to)),
    clippedStart: placed.some((row) => row.placement.clippedStart),
    clippedEnd: placed.some((row) => row.placement.clippedEnd)
  }
  return summary.to > summary.from ? summary : null
}

/** All-day and multi-day events: the ones that read as a stretch of time. */
export function buildEventRows(
  items: readonly CalendarProjectionItem[],
  window: TimelineWindow
): TimelineEventRow[] {
  return items
    .filter(
      (item) =>
        (item.visualType === 'event' || item.visualType === 'external_event') &&
        (item.isAllDay || isMultiDaySpan(item))
    )
    .flatMap((item) => {
      const start = spanStartDateKey(item)
      const end = spanEndDateKey(item)
      const placement = placeInWindow(start, end, window)
      if (!placement) return []
      const row: TimelineEventRow = {
        type: 'event',
        key: `event:${item.projectionId}`,
        item,
        start,
        end,
        placement,
        color: item.source.color ?? EVENT_TYPE_COLORS[item.visualType]
      }
      return [row]
    })
    .sort((a, b) =>
      a.start !== b.start ? (a.start < b.start ? -1 : 1) : a.item.title.localeCompare(b.item.title)
    )
}

export function buildTimelineGroups({
  tasks,
  projects,
  events,
  window,
  today,
  settings
}: BuildTimelineInput): TimelineGroup[] {
  const projectById = new Map(projects.map((project) => [project.id, project]))
  const rows: TimelineTaskRow[] = []

  for (const task of tasks) {
    if (task.archivedAt) continue
    if (task.completedAt && !settings.showCompleted) continue
    if (task.parentId && !settings.showSubtasks) continue
    const project = projectById.get(task.projectId)
    if (!project || project.isArchived) continue
    const row = toTaskRow(task, project, window, today)
    if (!row) continue
    if (row.shape.kind === 'none' && (!settings.showUndated || row.isCompleted)) continue
    rows.push(row)
  }

  const groups: TimelineGroup[] = []

  if (settings.showEvents) {
    const eventRows = buildEventRows(events, window)
    if (eventRows.length > 0) {
      groups.push({
        key: 'events',
        heading: { kind: 'events' },
        color: null,
        rows: eventRows,
        summary: null
      })
    }
  }

  const pushGroup = (
    key: string,
    heading: TimelineGroupHeading,
    color: string | null,
    members: TimelineTaskRow[]
  ): void => {
    if (members.length === 0) return
    const ordered = nestRows(members, settings.orderBy)
    groups.push({ key, heading, color, rows: ordered, summary: summarize(ordered) })
  }

  switch (settings.groupBy) {
    case 'project':
      for (const project of projects) {
        if (project.isArchived) continue
        pushGroup(
          `project:${project.id}`,
          { kind: 'project', projectId: project.id, name: project.name },
          project.color,
          rows.filter((row) => row.task.projectId === project.id)
        )
      }
      break
    case 'status':
      for (const status of STATUS_ORDER) {
        pushGroup(
          `status:${status}`,
          { kind: 'status', status },
          null,
          rows.filter((row) => row.statusType === status)
        )
      }
      break
    case 'priority':
      for (const priority of PRIORITY_ORDER) {
        pushGroup(
          `priority:${priority}`,
          { kind: 'priority', priority },
          null,
          rows.filter((row) => row.task.priority === priority)
        )
      }
      break
    case 'none':
      pushGroup('all', { kind: 'all' }, null, rows)
      break
  }

  return groups
}

// ---------------------------------------------------------------------------
// Edits: date math behind drag, keyboard and the action panel
// ---------------------------------------------------------------------------

export type TimelineEdit = 'move' | 'resize-start' | 'resize-end'

export interface TimelineDates {
  startDate: string | null
  dueDate: string | null
}

export function shapeToDates(shape: TimelineShape): TimelineDates {
  switch (shape.kind) {
    case 'span':
      return { startDate: shape.start, dueDate: shape.end }
    case 'due':
      return { startDate: null, dueDate: shape.date }
    case 'start':
      return { startDate: shape.date, dueDate: null }
    case 'none':
      return { startDate: null, dueDate: null }
  }
}

/**
 * The task's dates after dragging (or nudging) by `deltaDays`.
 *
 * - Move shifts every date the task has.
 * - Resizing the end changes the due date, never before the start; a
 *   milestone stretched forward becomes a span that starts on its old day,
 *   and an open-ended bar gains a due date.
 * - Resizing the start changes the start date, never past the due date.
 *
 * A span squeezed to one day keeps both dates equal, which reads as a
 * milestone and keeps the start for when it is stretched again.
 */
export function applyTimelineEdit(
  shape: TimelineShape,
  edit: TimelineEdit,
  deltaDays: number
): TimelineDates {
  const current = shapeToDates(shape)
  if (shape.kind === 'none' || deltaDays === 0) return current
  const shift = (date: string | null): string | null =>
    date === null ? null : addLocalDays(date, deltaDays)

  if (edit === 'move') {
    return { startDate: shift(current.startDate), dueDate: shift(current.dueDate) }
  }

  if (edit === 'resize-end') {
    if (shape.kind === 'span') {
      const due = addLocalDays(shape.end, deltaDays)
      return { startDate: shape.start, dueDate: due < shape.start ? shape.start : due }
    }
    const anchor = shape.date
    const due = addLocalDays(anchor, deltaDays)
    if (due <= anchor) return current
    return { startDate: anchor, dueDate: due }
  }

  // resize-start
  if (shape.kind === 'span') {
    const start = addLocalDays(shape.start, deltaDays)
    return { startDate: start > shape.end ? shape.end : start, dueDate: shape.end }
  }
  if (shape.kind === 'start') return { startDate: shift(shape.date), dueDate: null }
  const start = addLocalDays(shape.date, deltaDays)
  if (start >= shape.date) return current
  return { startDate: start, dueDate: shape.date }
}

/** Dates for an unscheduled task given a click (one day) or a dragged range. */
export function scheduleRange(from: string, to: string): TimelineDates {
  if (from === to) return { startDate: null, dueDate: from }
  return from < to ? { startDate: from, dueDate: to } : { startDate: to, dueDate: from }
}

/** Inclusive day count of a span; 1 for a single day. */
export function inclusiveDays(first: string, last: string): number {
  return dayIndexFromDate(last) - dayIndexFromDate(first) + 1
}
