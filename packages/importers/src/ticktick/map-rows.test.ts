import { describe, it, expect } from 'vitest'
import { mapRows } from './map-rows'
import type { TickTickRow } from './types'

const NOW = '2026-06-15T00:00:00.000Z'

function row(overrides: Partial<TickTickRow> = {}): TickTickRow {
  return {
    folderName: '',
    listName: 'Inbox',
    title: 'Task',
    kind: 'TEXT',
    tags: [],
    content: '',
    isCheckList: false,
    startDate: '',
    dueDate: '',
    reminder: '',
    repeat: '',
    priority: 0,
    status: 0,
    createdTime: '',
    completedTime: '',
    order: '0',
    timezone: 'UTC',
    isAllDay: false,
    isFloating: false,
    columnName: '',
    columnOrder: '',
    viewMode: 'list',
    taskId: '',
    parentId: '',
    projectKind: 'TASK',
    ...overrides
  }
}

describe('mapRows', () => {
  it('binds the Inbox list to the existing inbox project', () => {
    const plan = mapRows([row({ listName: 'Inbox', title: 'A' })], { now: NOW })
    expect(plan.projects).toHaveLength(1)
    expect(plan.projects[0].useExistingInbox).toBe(true)
    expect(plan.stats.tasks).toBe(1)
  })

  it('creates a new project with default statuses for a list-view list', () => {
    const plan = mapRows([row({ listName: 'Books', title: 'B' })], { now: NOW })
    const proj = plan.projects.find((p) => p.name === 'Books')!
    expect(proj.useExistingInbox).toBe(false)
    expect(proj.statuses.map((s) => s.type)).toEqual(['todo', 'in_progress', 'done'])
  })

  it('builds kanban statuses from Column Name ordered by Column Order', () => {
    const rows = [
      row({
        listName: 'Vids',
        title: 'X',
        columnName: 'To Do',
        columnOrder: '-100',
        viewMode: 'kanban'
      }),
      row({
        listName: 'Vids',
        title: 'Y',
        columnName: 'Watching',
        columnOrder: '50',
        viewMode: 'kanban'
      })
    ]
    const proj = mapRows(rows, { now: NOW }).projects.find((p) => p.name === 'Vids')!
    expect(proj.statuses.map((s) => s.name)).toEqual(['To Do', 'Watching'])
    expect(proj.statuses[0].isDone).toBe(false)
  })

  it('resolves parent/child via taskId/parentId', () => {
    const rows = [
      row({ listName: 'Inbox', title: 'Parent', taskId: '1' }),
      row({ listName: 'Inbox', title: 'Child', taskId: '2', parentId: '1' })
    ]
    const plan = mapRows(rows, { now: NOW })
    const parent = plan.tasks.find((t) => t.title === 'Parent')!
    const child = plan.tasks.find((t) => t.title === 'Child')!
    expect(child.parentTempId).toBe(parent.tempId)
    expect(plan.stats.subtasks).toBe(1)
  })

  it('warns and de-parents a child whose parent is missing', () => {
    const plan = mapRows([row({ title: 'Orphan', taskId: '2', parentId: '99' })], { now: NOW })
    expect(plan.tasks[0].parentTempId).toBeNull()
    expect(plan.warnings.some((w) => /parent/i.test(w.message))).toBe(true)
  })

  it('maps completion, priority, tags, dates, repeat, and reminders', () => {
    const plan = mapRows(
      [
        row({
          title: 'Done thing',
          priority: 5,
          status: 2,
          completedTime: '2020-04-22T10:00:00+0000',
          tags: ['x'],
          dueDate: '2020-05-07T08:00:00+0000',
          timezone: 'Europe/Istanbul',
          reminder: '-PT1440M',
          repeat: 'FREQ=YEARLY;INTERVAL=1'
        })
      ],
      { now: NOW }
    )
    const t = plan.tasks[0]
    expect(t.priority).toBe(3)
    expect(t.completedAt).toBe('2020-04-22T10:00:00+0000')
    expect(t.tags).toEqual(['x'])
    expect(t.dueDate).toBe('2020-05-07')
    expect(t.dueTime).toBe('11:00')
    expect(t.repeatConfig?.frequency).toBe('yearly')
    expect(t.repeatFrom).toBe('due')
    expect(t.reminders).toHaveLength(1)
    expect(plan.stats.reminders).toBe(1)
  })

  it("marks won't-do (status -1) as archived", () => {
    const plan = mapRows([row({ title: 'Nope', status: -1 })], { now: NOW })
    expect(plan.tasks[0].archivedAt).toBe(NOW)
  })

  it('warns once when a Folder Name is present', () => {
    const plan = mapRows([row({ folderName: 'Work', title: 'Z' })], { now: NOW })
    expect(plan.warnings.some((w) => /folder/i.test(w.message))).toBe(true)
  })
})
