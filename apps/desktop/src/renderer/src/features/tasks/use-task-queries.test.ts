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
