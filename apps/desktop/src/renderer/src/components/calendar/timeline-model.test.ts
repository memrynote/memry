import { describe, expect, it } from 'vitest'
import { createDefaultTask, type Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import {
  DEFAULT_TIMELINE_SETTINGS,
  applyTimelineEdit,
  buildEventRows,
  buildTimelineGroups,
  getAxisTicks,
  getMonthSpans,
  getTimelineWindow,
  getWeekendOffsets,
  inclusiveDays,
  isSameTimelinePeriod,
  placeInWindow,
  scheduleRange,
  shapeBounds,
  stepTimelineAnchor,
  timelinePeriodStart,
  toTimelineShape,
  type TimelineSettings,
  type TimelineTaskRow
} from './timeline-model'

const d = (value: string): Date => {
  const [y, m, day] = value.split('-').map(Number)
  return new Date(y, m - 1, day)
}

function project(id: string, name: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name,
    description: '',
    icon: 'folder',
    color: `#${id.padEnd(6, '0').slice(0, 6)}`,
    statuses: [
      { id: `${id}-todo`, name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
      { id: `${id}-doing`, name: 'Doing', color: '#f59e0b', type: 'in_progress', order: 1 },
      { id: `${id}-done`, name: 'Done', color: '#10b981', type: 'done', order: 2 }
    ],
    isDefault: false,
    isArchived: false,
    createdAt: new Date(2026, 0, 1),
    taskCount: 0,
    ...extra
  }
}

function task(
  id: string,
  projectId: string,
  start: string | null,
  due: string | null,
  extra: Partial<Task> = {}
): Task {
  return {
    ...createDefaultTask(projectId, `${projectId}-todo`, id),
    id,
    startDate: start ? d(start) : null,
    dueDate: due ? d(due) : null,
    ...extra
  }
}

const SEPTEMBER = getTimelineWindow('2026-09-23', 'months', 1)
const TODAY = '2026-09-23'

function build(
  tasks: Task[],
  projects: Project[],
  settings: Partial<TimelineSettings> = {},
  events: CalendarProjectionItem[] = []
) {
  return buildTimelineGroups({
    tasks,
    projects,
    events,
    window: SEPTEMBER,
    today: TODAY,
    settings: { ...DEFAULT_TIMELINE_SETTINGS, ...settings }
  })
}

const titles = (rows: readonly { type: string }[]): string[] =>
  rows.map((row) => (row as TimelineTaskRow).task.title)

describe('timeline window', () => {
  it('lays months out from two months before the anchor month to three after', () => {
    expect(SEPTEMBER).toEqual({ start: '2026-07-01', end: '2026-12-31', dayCount: 184 })
  })

  it('anchors weeks on the week start and quarters on the quarter start', () => {
    expect(getTimelineWindow('2026-09-23', 'weeks', 1)).toEqual({
      start: '2026-08-31',
      end: '2026-11-08',
      dayCount: 70
    })
    const quarters = getTimelineWindow('2026-09-23', 'quarters', 1)
    expect(quarters.start).toBe('2026-01-01')
    expect(quarters.end).toBe('2027-06-30')
  })

  it('steps and names periods per zoom', () => {
    expect(stepTimelineAnchor('2026-09-23', 'weeks', 1)).toBe('2026-09-30')
    expect(stepTimelineAnchor('2026-09-23', 'months', -1)).toBe('2026-08-23')
    expect(stepTimelineAnchor('2026-09-23', 'quarters', 1)).toBe('2026-12-23')
    expect(timelinePeriodStart('2026-09-23', 'quarters', 1)).toBe('2026-07-01')
    expect(timelinePeriodStart('2026-09-23', 'weeks', 0)).toBe('2026-09-20')
    expect(isSameTimelinePeriod('2026-09-01', '2026-09-30', 'months', 1)).toBe(true)
    expect(isSameTimelinePeriod('2026-09-30', '2026-10-01', 'months', 1)).toBe(false)
  })
})

describe('timeline axis', () => {
  it('splits the window into month spans', () => {
    const spans = getMonthSpans(SEPTEMBER)
    expect(spans.map((span) => span.month)).toEqual([
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
      '2026-11-01',
      '2026-12-01'
    ])
    expect(spans[2]).toEqual({ month: '2026-09-01', offset: 62, length: 30 })
  })

  it('labels every day, except at quarter zoom where it labels week starts', () => {
    const window = getTimelineWindow('2026-09-23', 'weeks', 1)
    expect(getAxisTicks(window, 'weeks', 1)).toHaveLength(70)
    const quarterTicks = getAxisTicks(getTimelineWindow('2026-09-23', 'quarters', 1), 'quarters', 1)
    expect(quarterTicks.every((tick) => new Date(`${tick.date}T00:00`).getDay() === 1)).toBe(true)
  })

  it('shades weekends except at quarter zoom', () => {
    const window = getTimelineWindow('2026-09-23', 'weeks', 1)
    expect(getWeekendOffsets(window, 'weeks').slice(0, 2)).toEqual([5, 6])
    expect(getWeekendOffsets(window, 'quarters')).toEqual([])
  })
})

describe('shapes and placement', () => {
  it('reads span, milestone, open-ended and unscheduled tasks', () => {
    expect(toTimelineShape({ startDate: d('2026-09-01'), dueDate: d('2026-09-05') })).toEqual({
      kind: 'span',
      start: '2026-09-01',
      end: '2026-09-05'
    })
    expect(toTimelineShape({ startDate: d('2026-09-05'), dueDate: d('2026-09-05') })).toEqual({
      kind: 'due',
      date: '2026-09-05'
    })
    expect(toTimelineShape({ startDate: d('2026-09-05'), dueDate: null })).toEqual({
      kind: 'start',
      date: '2026-09-05'
    })
    expect(toTimelineShape({ startDate: null, dueDate: null })).toEqual({ kind: 'none' })
  })

  it('gives an open-ended bar a fixed reach', () => {
    expect(shapeBounds({ kind: 'start', date: '2026-09-05' })).toEqual({
      first: '2026-09-05',
      last: '2026-09-09'
    })
  })

  it('clips a bar at the window edges', () => {
    expect(placeInWindow('2026-06-20', '2026-07-03', SEPTEMBER)).toEqual({
      from: 0,
      to: 2,
      clippedStart: true,
      clippedEnd: false
    })
    expect(placeInWindow('2026-12-30', '2027-01-04', SEPTEMBER)).toEqual({
      from: 182,
      to: 183,
      clippedStart: false,
      clippedEnd: true
    })
    expect(placeInWindow('2027-02-01', '2027-02-03', SEPTEMBER)).toBeNull()
  })
})

describe('buildTimelineGroups', () => {
  const launch = project('aa1111', 'Launch')
  const school = project('bb2222', 'School')

  it('groups by project in project order and sorts rows by start date', () => {
    const groups = build(
      [
        task('Write post', 'aa1111', null, '2026-10-02'),
        task('Ship view', 'aa1111', '2026-09-14', '2026-09-26'),
        task('Midterm', 'bb2222', '2026-09-24', '2026-10-01'),
        task('Screenshots', 'aa1111', '2026-09-28', '2026-10-06')
      ],
      [launch, school]
    )
    expect(groups.map((group) => group.key)).toEqual(['project:aa1111', 'project:bb2222'])
    expect(titles(groups[0].rows)).toEqual(['Ship view', 'Screenshots', 'Write post'])
    expect(groups[0].color).toBe(launch.color)
  })

  it('summarizes a group across its scheduled rows', () => {
    const [group] = build(
      [
        task('A', 'aa1111', '2026-09-14', '2026-09-26'),
        task('B', 'aa1111', null, '2026-10-08'),
        task('C', 'aa1111', null, null)
      ],
      [launch]
    )
    expect(group.summary).toEqual({
      from: 75,
      to: 99,
      clippedStart: false,
      clippedEnd: false
    })
  })

  it('has no summary for a group that covers a single day', () => {
    const [group] = build([task('A', 'aa1111', null, '2026-09-23')], [launch])
    expect(group.summary).toBeNull()
  })

  it('lists unscheduled tasks last, and hides them when asked', () => {
    const tasks = [
      task('Undated', 'aa1111', null, null),
      task('Dated', 'aa1111', null, '2026-09-10')
    ]
    expect(titles(build(tasks, [launch])[0].rows)).toEqual(['Dated', 'Undated'])
    expect(titles(build(tasks, [launch], { showUndated: false })[0].rows)).toEqual(['Dated'])
  })

  it('leaves out archived tasks, archived projects and, by default, completed tasks', () => {
    const archivedProject = project('cc3333', 'Old', { isArchived: true })
    const tasks = [
      task('Open', 'aa1111', null, '2026-09-10'),
      task('Done', 'aa1111', null, '2026-09-10', { completedAt: new Date() }),
      task('Archived', 'aa1111', null, '2026-09-10', { archivedAt: new Date() }),
      task('In old project', 'cc3333', null, '2026-09-10')
    ]
    expect(titles(build(tasks, [launch, archivedProject]).flatMap((g) => g.rows))).toEqual(['Open'])
    const withDone = build(tasks, [launch], { showCompleted: true })
    const done = withDone[0].rows.find(
      (row) => (row as TimelineTaskRow).task.title === 'Done'
    ) as TimelineTaskRow
    expect(done.isCompleted).toBe(true)
    expect(done.statusType).toBe('done')
  })

  it('does not list a completed task without dates even when completed tasks show', () => {
    const tasks = [task('Done undated', 'aa1111', null, null, { completedAt: new Date() })]
    expect(build(tasks, [launch], { showCompleted: true })).toEqual([])
  })

  it('flags open tasks past their last day as overdue', () => {
    const [group] = build(
      [
        task('Late', 'aa1111', '2026-09-03', '2026-09-19'),
        task('Started', 'aa1111', '2026-09-01', null),
        task('Due today', 'aa1111', null, TODAY)
      ],
      [launch]
    )
    const byTitle = Object.fromEntries(
      group.rows.map((row) => [(row as TimelineTaskRow).task.title, row as TimelineTaskRow])
    )
    expect(byTitle.Late.isOverdue).toBe(true)
    expect(byTitle.Started.isOverdue).toBe(false)
    expect(byTitle['Due today'].isOverdue).toBe(false)
  })

  it('keeps overdue work listed after its bar leaves the window', () => {
    const [group] = build([task('Ancient', 'aa1111', null, '2026-01-10')], [launch])
    const row = group.rows[0] as TimelineTaskRow
    expect(row.placement).toBeNull()
    expect(row.isOverdue).toBe(true)
  })

  it('drops future work outside the window', () => {
    expect(build([task('Next year', 'aa1111', null, '2027-05-10')], [launch])).toEqual([])
  })

  it('nests subtasks under their parent when subtasks show', () => {
    const tasks = [
      task('Parent', 'aa1111', '2026-09-01', '2026-09-20'),
      task('Child', 'aa1111', '2026-09-05', '2026-09-08', { parentId: 'Parent' }),
      task('Other', 'aa1111', '2026-09-03', '2026-09-04')
    ]
    expect(titles(build(tasks, [launch])[0].rows)).toEqual(['Parent', 'Other'])
    const rows = build(tasks, [launch], { showSubtasks: true })[0].rows as TimelineTaskRow[]
    expect(rows.map((row) => [row.task.title, row.depth])).toEqual([
      ['Parent', 0],
      ['Child', 1],
      ['Other', 0]
    ])
  })

  it('groups by status type and by priority', () => {
    const tasks = [
      task('Doing', 'aa1111', null, '2026-09-10', { statusId: 'aa1111-doing' }),
      task('Todo', 'aa1111', null, '2026-09-11', { priority: 'high' })
    ]
    expect(build(tasks, [launch], { groupBy: 'status' }).map((g) => g.key)).toEqual([
      'status:todo',
      'status:in_progress'
    ])
    expect(build(tasks, [launch], { groupBy: 'priority' }).map((g) => g.key)).toEqual([
      'priority:high',
      'priority:none'
    ])
    const [flat] = build(tasks, [launch], { groupBy: 'none' })
    expect(flat.heading).toEqual({ kind: 'all' })
    expect(titles(flat.rows)).toEqual(['Doing', 'Todo'])
  })

  it('orders by due date or title when asked', () => {
    const tasks = [
      task('B long', 'aa1111', '2026-09-01', '2026-09-30'),
      task('A short', 'aa1111', '2026-09-10', '2026-09-12')
    ]
    expect(titles(build(tasks, [launch], { orderBy: 'start' })[0].rows)).toEqual([
      'B long',
      'A short'
    ])
    expect(titles(build(tasks, [launch], { orderBy: 'due' })[0].rows)).toEqual([
      'A short',
      'B long'
    ])
    expect(titles(build(tasks, [launch], { orderBy: 'title' })[0].rows)).toEqual([
      'A short',
      'B long'
    ])
  })
})

function eventItem(
  id: string,
  startAt: string,
  endAt: string,
  extra: Partial<CalendarProjectionItem> = {}
): CalendarProjectionItem {
  return {
    projectionId: `event:${id}`,
    sourceType: 'event',
    sourceId: id,
    title: id,
    descriptionPreview: null,
    startAt,
    endAt,
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'event',
    editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
    source: {
      provider: null,
      calendarSourceId: null,
      title: null,
      color: null,
      kind: null,
      isMemryManaged: true
    },
    binding: null,
    snoozeOffsetMinutes: null,
    ...extra
  }
}

describe('event rows', () => {
  const allDay = eventItem(
    'Offsite',
    new Date(2026, 8, 9).toISOString(),
    new Date(2026, 8, 12).toISOString(),
    { isAllDay: true }
  )
  const timed = eventItem(
    'Standup',
    new Date(2026, 8, 9, 9).toISOString(),
    new Date(2026, 8, 9, 10).toISOString()
  )

  it('keeps all-day and multi-day events and drops timed single-day ones', () => {
    const rows = buildEventRows([timed, allDay], SEPTEMBER)
    expect(rows.map((row) => [row.item.title, row.start, row.end])).toEqual([
      ['Offsite', '2026-09-09', '2026-09-11']
    ])
  })

  it('puts events first and hides them when asked', () => {
    const launch = project('aa1111', 'Launch')
    const tasks = [task('A', 'aa1111', null, '2026-09-10')]
    expect(build(tasks, [launch], {}, [allDay]).map((g) => g.key)).toEqual([
      'events',
      'project:aa1111'
    ])
    expect(build(tasks, [launch], { showEvents: false }, [allDay]).map((g) => g.key)).toEqual([
      'project:aa1111'
    ])
  })
})

describe('applyTimelineEdit', () => {
  const span = { kind: 'span', start: '2026-09-10', end: '2026-09-15' } as const

  it('moves every date the task has', () => {
    expect(applyTimelineEdit(span, 'move', 3)).toEqual({
      startDate: '2026-09-13',
      dueDate: '2026-09-18'
    })
    expect(applyTimelineEdit({ kind: 'due', date: '2026-09-10' }, 'move', -2)).toEqual({
      startDate: null,
      dueDate: '2026-09-08'
    })
    expect(applyTimelineEdit({ kind: 'start', date: '2026-09-10' }, 'move', 7)).toEqual({
      startDate: '2026-09-17',
      dueDate: null
    })
  })

  it('resizes a span without crossing its other end', () => {
    expect(applyTimelineEdit(span, 'resize-end', 2).dueDate).toBe('2026-09-17')
    expect(applyTimelineEdit(span, 'resize-end', -10)).toEqual({
      startDate: '2026-09-10',
      dueDate: '2026-09-10'
    })
    expect(applyTimelineEdit(span, 'resize-start', 10)).toEqual({
      startDate: '2026-09-15',
      dueDate: '2026-09-15'
    })
  })

  it('stretches a milestone or open-ended bar into a span', () => {
    expect(applyTimelineEdit({ kind: 'due', date: '2026-09-10' }, 'resize-end', 2)).toEqual({
      startDate: '2026-09-10',
      dueDate: '2026-09-12'
    })
    expect(applyTimelineEdit({ kind: 'due', date: '2026-09-10' }, 'resize-start', -2)).toEqual({
      startDate: '2026-09-08',
      dueDate: '2026-09-10'
    })
    expect(applyTimelineEdit({ kind: 'start', date: '2026-09-10' }, 'resize-end', 1)).toEqual({
      startDate: '2026-09-10',
      dueDate: '2026-09-11'
    })
    expect(applyTimelineEdit({ kind: 'due', date: '2026-09-10' }, 'resize-end', -1)).toEqual({
      startDate: null,
      dueDate: '2026-09-10'
    })
  })

  it('schedules a click as a due date and a drag as a range', () => {
    expect(scheduleRange('2026-09-10', '2026-09-10')).toEqual({
      startDate: null,
      dueDate: '2026-09-10'
    })
    expect(scheduleRange('2026-09-12', '2026-09-10')).toEqual({
      startDate: '2026-09-10',
      dueDate: '2026-09-12'
    })
    expect(inclusiveDays('2026-09-18', '2026-09-30')).toBe(13)
  })
})
