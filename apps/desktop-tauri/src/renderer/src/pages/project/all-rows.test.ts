import { describe, it, expect } from 'vitest'
import { createDefaultTask, type Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import type { ProjectLinkedEvent, ProjectLinkedNote } from '@memry/rpc/tasks'
import { buildAllRows, daysLeft, sortAllRows } from './all-rows'

const NOW = new Date(2025, 1, 8, 12)
const day = (n: number, hour = 12): Date => new Date(2025, 1, 8 + n, hour)

const project: Project = {
  id: 'p1',
  name: 'Site',
  description: '',
  icon: '',
  color: '',
  statuses: [
    { id: 'todo', name: 'To do', color: '', type: 'todo', order: 0 },
    { id: 'done', name: 'Done', color: '', type: 'done', order: 1 }
  ],
  isDefault: false,
  isArchived: false,
  createdAt: NOW,
  taskCount: 0
}

const task = (title: string, due: Date | null, over: Partial<Task> = {}): Task => ({
  ...createDefaultTask('p1', 'todo', title, due),
  id: title,
  ...over
})

const note = (id: string): ProjectLinkedNote => ({
  id,
  title: id,
  emoji: null,
  modifiedAt: NOW.toISOString(),
  pinned: false
})

const event = (id: string, start: Date, end: Date | null = null): ProjectLinkedEvent => ({
  id,
  title: id,
  startAt: start.toISOString(),
  endAt: end?.toISOString() ?? null,
  isAllDay: false
})

const build = (over: Partial<Parameters<typeof buildAllRows>[0]> = {}) =>
  buildAllRows({
    project,
    projectTasks: [],
    allTasks: [],
    notes: [],
    events: [],
    now: NOW,
    showDone: false,
    ...over
  })

describe('daysLeft', () => {
  it('counts whole local days and goes negative once past', () => {
    expect(daysLeft(day(0, 23), NOW)).toBe(0)
    expect(daysLeft(day(5, 1), NOW)).toBe(5)
    expect(daysLeft(day(-2), NOW)).toBe(-2)
  })
})

describe('buildAllRows', () => {
  it('nests a task under the note it was written in, even from another project', () => {
    const outside = task('Elsewhere', day(3), { projectId: 'other', sourceNoteId: 'brief' })
    const rows = build({ notes: [note('brief')], allTasks: [outside] })
    expect(rows.map((r) => [r.key, r.parentNoteId])).toEqual([
      ['note:brief', null],
      ['task:Elsewhere', 'brief']
    ])
  })

  it('lists a task linked to two notes once, under the first', () => {
    const t = task('Shared', day(1), { sourceNoteId: null, linkedNoteIds: ['a', 'b'] })
    const rows = build({ notes: [note('a'), note('b')], projectTasks: [t] })
    expect(rows.filter((r) => r.type === 'task')).toHaveLength(1)
    expect(rows.find((r) => r.type === 'task')?.parentNoteId).toBe('a')
  })

  it('derives a note from its open tasks and hides done work by default', () => {
    const open = task('Open', day(4), { sourceNoteId: 'n', startDate: day(1) })
    const later = task('Later', day(9), { sourceNoteId: 'n' })
    const done = task('Done', day(-1), { sourceNoteId: 'n', completedAt: day(-1) })
    const rows = build({ notes: [note('n')], projectTasks: [open, later, done] })
    const n = rows[0]
    expect(n.start).toEqual(day(1))
    expect(n.due).toEqual(day(9))
    expect(n.status).toBe('active')
    expect(n.taskSummary).toEqual({ open: 2, total: 3 })
    expect(rows.map((r) => r.id)).toEqual(['n', 'Open', 'Later'])
  })

  it('treats a done-type status as done without a completedAt', () => {
    const t = task('Shipped', day(1), { statusId: 'done' })
    expect(build({ projectTasks: [t] })).toEqual([])
    expect(build({ projectTasks: [t], showDone: true })).toHaveLength(1)
  })

  it('hides a note whose tasks are all done, and a past event, until showDone', () => {
    const done = task('Done', day(-1), { sourceNoteId: 'n', completedAt: day(-1) })
    const past = event('old', day(-3), day(-3, 13))
    const args = { notes: [note('n')], projectTasks: [done], events: [past] }
    expect(build(args)).toEqual([])
    expect(build({ ...args, showDone: true }).map((r) => r.id)).toEqual(['old', 'n', 'Done'])
  })

  it('orders top-level items by due date with undated last', () => {
    const rows = build({
      notes: [note('plain')],
      projectTasks: [task('Late', day(9)), task('Soon', day(1))],
      events: [event('Meet', day(4))]
    })
    expect(rows.map((r) => r.id)).toEqual(['Soon', 'Meet', 'Late', 'plain'])
  })

  it('leaves out subtasks and archived tasks', () => {
    const rows = build({
      projectTasks: [
        task('Sub', day(1), { parentId: 'x' }),
        task('Gone', day(1), { archivedAt: NOW })
      ]
    })
    expect(rows).toEqual([])
  })
})

describe('sortAllRows', () => {
  const rows = build({
    projectTasks: [task('b', day(5)), task('a', day(2)), task('none', null)]
  })

  it('sorts by due and keeps undated rows last in both directions', () => {
    expect(sortAllRows(rows, { key: 'due', dir: 'asc' }).map((r) => r.id)).toEqual([
      'a',
      'b',
      'none'
    ])
    expect(sortAllRows(rows, { key: 'due', dir: 'desc' }).map((r) => r.id)).toEqual([
      'b',
      'a',
      'none'
    ])
  })

  it('sorts by title', () => {
    expect(sortAllRows(rows, { key: 'title', dir: 'desc' }).map((r) => r.id)).toEqual([
      'none',
      'b',
      'a'
    ])
  })
})
