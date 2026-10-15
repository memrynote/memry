import { describe, it, expect } from 'vitest'
import { dbTaskToUiTask } from './use-task-queries'

const baseDbTask = {
  id: 't1',
  projectId: 'p1',
  statusId: 's1',
  parentId: null,
  title: 'Write spec',
  description: null,
  priority: 0 as const,
  position: 0,
  dueDate: null,
  dueTime: null,
  startDate: null,
  repeatConfig: null,
  repeatFrom: null,
  sourceNoteId: null,
  completedAt: null,
  archivedAt: null,
  createdAt: '2026-07-16T00:00:00.000Z',
  modifiedAt: '2026-07-16T00:00:00.000Z'
}

describe('dbTaskToUiTask tags', () => {
  it('maps tags from the db task', () => {
    const result = dbTaskToUiTask({ ...baseDbTask, tags: ['MIT', 'work'] })
    expect(result.tags).toEqual(['MIT', 'work'])
  })

  it('defaults to an empty array when tags are absent', () => {
    const result = dbTaskToUiTask(baseDbTask)
    expect(result.tags).toEqual([])
  })
})

describe('dbTaskToUiTask duration', () => {
  it('keeps the duration of a timed task', () => {
    const task = dbTaskToUiTask({ ...baseDbTask, dueTime: '09:30', durationMinutes: 90 })
    expect(task.durationMinutes).toBe(90)
  })
})

describe('dbTaskToUiTask start date', () => {
  it('loads a calendar date at local midnight', () => {
    const task = dbTaskToUiTask({ ...baseDbTask, startDate: '2026-09-07' })
    expect(task.startDate).toEqual(new Date(2026, 8, 7))
  })
  it('keeps tasks without a start date unscheduled', () => {
    expect(dbTaskToUiTask(baseDbTask).startDate).toBeNull()
  })
})
