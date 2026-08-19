import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { getTasksInDueWindow, getCompletedTasksInDueWindow } from './task-view-helpers'
import { createDefaultTask, type Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'

// Fixed "now" so day boundaries are not a coin flip near midnight.
const NOW = new Date('2026-08-19T10:00:00.000Z')

const at = (dayOffset: number, hour = 9): Date => {
  const date = new Date(NOW)
  date.setHours(hour, 0, 0, 0)
  date.setDate(date.getDate() + dayOffset)
  return date
}

const project: Project = {
  id: 'p1',
  name: 'Personal',
  description: '',
  icon: 'Folder',
  color: '#f59e0b',
  statuses: [
    { id: 'todo', name: 'Todo', color: '#888', type: 'todo', order: 0 },
    { id: 'done', name: 'Done', color: '#0a0', type: 'done', order: 1 }
  ],
  isDefault: true,
  isArchived: false,
  createdAt: NOW,
  taskCount: 0
}

const makeTask = (id: string, dueDate: Date | null, overrides: Partial<Task> = {}): Task => ({
  ...createDefaultTask('p1', 'todo', id, dueDate),
  id,
  ...overrides
})

const titles = (tasks: Task[]): string[] => tasks.map((t) => t.id)

describe('getTasksInDueWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const overdue = makeTask('overdue', at(-2))
  const today = makeTask('today', at(0))
  const tomorrow = makeTask('tomorrow', at(1))
  const daySix = makeTask('day-6', at(6))
  const daySeven = makeTask('day-7', at(7))
  const noDate = makeTask('no-date', null)
  const done = makeTask('done', at(0), { statusId: 'done', completedAt: NOW })

  const all = [overdue, today, tomorrow, daySix, daySeven, noDate, done]

  it('leads with overdue work on the today window', () => {
    expect(titles(getTasksInDueWindow(all, [project], 'today'))).toEqual(['overdue', 'today'])
  })

  it('shows only tomorrow on the tomorrow window, with no overdue backlog', () => {
    expect(titles(getTasksInDueWindow(all, [project], 'tomorrow'))).toEqual(['tomorrow'])
  })

  it('spans today through day six on the next-7 window, overdue first', () => {
    expect(titles(getTasksInDueWindow(all, [project], 'next7'))).toEqual([
      'overdue',
      'today',
      'tomorrow',
      'day-6'
    ])
  })

  it('excludes completed and undated tasks from every window', () => {
    for (const window of ['today', 'tomorrow', 'next7'] as const) {
      const ids = titles(getTasksInDueWindow(all, [project], window))
      expect(ids).not.toContain('done')
      expect(ids).not.toContain('no-date')
    }
  })

  it('carries subtasks along with a matching parent', () => {
    const parent = makeTask('parent', at(1), { subtaskIds: ['child'] })
    const child = makeTask('child', null, { parentId: 'parent' })

    expect(titles(getTasksInDueWindow([parent, child], [project], 'tomorrow'))).toEqual([
      'parent',
      'child'
    ])
  })
})

describe('getCompletedTasksInDueWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns done tasks whose due date lands in the window', () => {
    const tasks = [
      makeTask('done-tomorrow', at(1), { statusId: 'done', completedAt: NOW }),
      makeTask('done-today', at(0), { statusId: 'done', completedAt: NOW }),
      makeTask('open-tomorrow', at(1)),
      makeTask('archived', at(1), { statusId: 'done', completedAt: NOW, archivedAt: NOW })
    ]

    expect(titles(getCompletedTasksInDueWindow(tasks, 'tomorrow'))).toEqual(['done-tomorrow'])
  })
})
