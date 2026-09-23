import { describe, expect, it } from 'vitest'
import { createDefaultTask, type Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { buildTimelineGroups, getMonthDays, toTimelineSchedule } from './timeline-model'

function day(key: string): Date {
  const [year, month, date] = key.split('-').map(Number)
  return new Date(year, month - 1, date)
}

function task(
  id: string,
  projectId: string,
  dates: { start?: string; due?: string },
  overrides: Partial<Task> = {}
): Task {
  return {
    ...createDefaultTask(projectId, 'status-todo', id),
    id,
    startDate: dates.start ? day(dates.start) : null,
    dueDate: dates.due ? day(dates.due) : null,
    ...overrides
  }
}

function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: `Project ${id}`,
    description: '',
    icon: 'folder',
    color: '#3366ff',
    statuses: [],
    isDefault: false,
    isArchived: false,
    createdAt: new Date(2026, 0, 1),
    taskCount: 0,
    ...overrides
  }
}

const MARCH = getMonthDays('2026-03-15')

describe('getMonthDays', () => {
  it('lists every local day of the anchor month', () => {
    expect(MARCH).toHaveLength(31)
    expect(MARCH[0]).toBe('2026-03-01')
    expect(MARCH[30]).toBe('2026-03-31')
    expect(getMonthDays('2028-02-10')).toHaveLength(29)
  })
})

describe('toTimelineSchedule', () => {
  it('spans only when the start precedes the due date', () => {
    expect(
      toTimelineSchedule({ startDate: day('2026-03-02'), dueDate: day('2026-03-05') })
    ).toEqual({ kind: 'span', startDate: '2026-03-02', dueDate: '2026-03-05' })
    expect(
      toTimelineSchedule({ startDate: day('2026-03-05'), dueDate: day('2026-03-05') })
    ).toEqual({ kind: 'due', dueDate: '2026-03-05' })
    expect(
      toTimelineSchedule({ startDate: day('2026-03-09'), dueDate: day('2026-03-05') })
    ).toEqual({ kind: 'due', dueDate: '2026-03-05' })
  })

  it('keeps a lone start date and drops an undated task', () => {
    expect(toTimelineSchedule({ startDate: day('2026-03-02'), dueDate: null })).toEqual({
      kind: 'start',
      startDate: '2026-03-02'
    })
    expect(toTimelineSchedule({ startDate: null, dueDate: null })).toBeNull()
  })
})

describe('buildTimelineGroups', () => {
  it('groups open dated tasks under their project and places each bar in day columns', () => {
    const groups = buildTimelineGroups(
      [
        task('write', 'p1', { start: '2026-03-03', due: '2026-03-10' }),
        task('ship', 'p1', { due: '2026-03-12' }),
        task('kickoff', 'p2', { start: '2026-03-01' })
      ],
      [project('p1'), project('p2')],
      MARCH
    )

    expect(groups).toEqual([
      {
        projectId: 'p1',
        name: 'Project p1',
        color: '#3366ff',
        bar: { columnStart: 2, columnEnd: 11, continuesBefore: false, continuesAfter: false },
        rows: [
          {
            taskId: 'write',
            title: 'write',
            schedule: { kind: 'span', startDate: '2026-03-03', dueDate: '2026-03-10' },
            bar: { columnStart: 2, columnEnd: 9, continuesBefore: false, continuesAfter: false }
          },
          {
            taskId: 'ship',
            title: 'ship',
            schedule: { kind: 'due', dueDate: '2026-03-12' },
            bar: { columnStart: 11, columnEnd: 11, continuesBefore: false, continuesAfter: false }
          }
        ]
      },
      {
        projectId: 'p2',
        name: 'Project p2',
        color: '#3366ff',
        bar: { columnStart: 0, columnEnd: 0, continuesBefore: false, continuesAfter: false },
        rows: [
          {
            taskId: 'kickoff',
            title: 'kickoff',
            schedule: { kind: 'start', startDate: '2026-03-01' },
            bar: { columnStart: 0, columnEnd: 0, continuesBefore: false, continuesAfter: false }
          }
        ]
      }
    ])
  })

  it('clips work that runs past either edge of the month and marks the continuation', () => {
    const [group] = buildTimelineGroups(
      [
        task('long', 'p1', { start: '2026-02-20', due: '2026-04-02' }),
        task('tail', 'p1', { start: '2026-03-28', due: '2026-04-05' })
      ],
      [project('p1')],
      MARCH
    )

    expect(group.rows.map((row) => [row.taskId, row.bar])).toEqual([
      ['long', { columnStart: 0, columnEnd: 30, continuesBefore: true, continuesAfter: true }],
      ['tail', { columnStart: 27, columnEnd: 30, continuesBefore: false, continuesAfter: true }]
    ])
    expect(group.bar).toEqual({
      columnStart: 0,
      columnEnd: 30,
      continuesBefore: true,
      continuesAfter: true
    })
  })

  it('leaves out finished, archived, undated and out-of-window tasks and archived projects', () => {
    const groups = buildTimelineGroups(
      [
        task('open', 'p1', { due: '2026-03-04' }),
        task('done', 'p1', { due: '2026-03-04' }, { completedAt: new Date(2026, 2, 4) }),
        task('shelved', 'p1', { due: '2026-03-04' }, { archivedAt: new Date(2026, 2, 4) }),
        task('undated', 'p1', {}),
        task('april', 'p1', { start: '2026-04-01', due: '2026-04-03' }),
        task('hidden', 'p2', { due: '2026-03-04' })
      ],
      [project('p1'), project('p2', { isArchived: true })],
      MARCH
    )

    expect(groups.map((group) => [group.projectId, group.rows.map((row) => row.taskId)])).toEqual([
      ['p1', ['open']]
    ])
  })

  it('orders rows by where they start, then where they end, then title', () => {
    const [group] = buildTimelineGroups(
      [
        task('b-late', 'p1', { due: '2026-03-20' }),
        task('b-short', 'p1', { start: '2026-03-02', due: '2026-03-04' }),
        task('a-short', 'p1', { start: '2026-03-02', due: '2026-03-04' }),
        task('long', 'p1', { start: '2026-03-02', due: '2026-03-09' })
      ],
      [project('p1')],
      MARCH
    )

    expect(group.rows.map((row) => row.taskId)).toEqual(['a-short', 'b-short', 'long', 'b-late'])
  })
})
