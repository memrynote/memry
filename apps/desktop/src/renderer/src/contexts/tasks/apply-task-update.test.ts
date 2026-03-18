import { describe, it, expect } from 'vitest'
import type { Task } from '@/data/sample-tasks'
import { applyTaskUpdate } from './apply-task-update'

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Test',
  description: '',
  projectId: 'proj-1',
  statusId: 'status-todo',
  priority: 'none',
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId: null,
  subtaskIds: [],
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

describe('applyTaskUpdate', () => {
  it('should preserve parent subtaskIds when updating non-structural fields', () => {
    // #given — parent has subtasks, priority changes (not parentId)
    const parent = makeTask({ id: 'p1', priority: 'high', subtaskIds: ['s1', 's2'] })
    const sub1 = makeTask({ id: 's1', parentId: 'p1' })
    const sub2 = makeTask({ id: 's2', parentId: 'p1' })
    const prev = [parent, sub1, sub2]

    const updatedParent = makeTask({ id: 'p1', priority: 'urgent', subtaskIds: [] })

    // #when — parent priority changes (dbTaskToUiTask returns subtaskIds: [])
    const result = applyTaskUpdate(prev, updatedParent, 'p1')

    // #then — subtaskIds must be preserved from old state
    const resultParent = result.find((t) => t.id === 'p1')!
    expect(resultParent.priority).toBe('urgent')
    expect(resultParent.subtaskIds).toEqual(['s1', 's2'])
  })

  it('should preserve subtaskIds when updating subtask fields', () => {
    // #given — subtask gets updated, parent should be unaffected
    const parent = makeTask({ id: 'p1', subtaskIds: ['s1'] })
    const sub = makeTask({ id: 's1', parentId: 'p1', priority: 'low' })
    const prev = [parent, sub]

    const updatedSub = makeTask({ id: 's1', parentId: 'p1', priority: 'high', subtaskIds: [] })

    // #when
    const result = applyTaskUpdate(prev, updatedSub, 's1')

    // #then — parent's subtaskIds unchanged
    const resultParent = result.find((t) => t.id === 'p1')!
    expect(resultParent.subtaskIds).toEqual(['s1'])
    expect(result.find((t) => t.id === 's1')!.priority).toBe('high')
  })

  it('should update parent subtaskIds on promote (parentId removed)', () => {
    // #given
    const parent = makeTask({ id: 'p1', subtaskIds: ['s1', 's2'] })
    const sub1 = makeTask({ id: 's1', parentId: 'p1' })
    const sub2 = makeTask({ id: 's2', parentId: 'p1' })
    const prev = [parent, sub1, sub2]

    const promoted = makeTask({ id: 's1', parentId: null, subtaskIds: [] })

    // #when — s1 promoted to standalone
    const result = applyTaskUpdate(prev, promoted, 's1')

    // #then
    const resultParent = result.find((t) => t.id === 'p1')!
    expect(resultParent.subtaskIds).toEqual(['s2'])
    expect(result.find((t) => t.id === 's1')!.parentId).toBeNull()
  })

  it('should update parent subtaskIds on demote (parentId added)', () => {
    // #given
    const parent = makeTask({ id: 'p1', subtaskIds: ['s1'] })
    const sub1 = makeTask({ id: 's1', parentId: 'p1' })
    const standalone = makeTask({ id: 't2' })
    const prev = [parent, sub1, standalone]

    const demoted = makeTask({ id: 't2', parentId: 'p1', subtaskIds: [] })

    // #when — t2 demoted to subtask of p1
    const result = applyTaskUpdate(prev, demoted, 't2')

    // #then
    const resultParent = result.find((t) => t.id === 'p1')!
    expect(resultParent.subtaskIds).toEqual(['s1', 't2'])
  })

  it('should handle group header count correctly after priority change', () => {
    // #given — parent(high) with 2 subtasks, all in task list
    const parent = makeTask({ id: 'p1', priority: 'high', subtaskIds: ['s1', 's2'] })
    const sub1 = makeTask({ id: 's1', parentId: 'p1', priority: 'medium' })
    const sub2 = makeTask({ id: 's2', parentId: 'p1', priority: 'low' })
    const prev = [parent, sub1, sub2]

    const updatedParent = makeTask({ id: 'p1', priority: 'medium', subtaskIds: [] })

    // #when
    const result = applyTaskUpdate(prev, updatedParent, 'p1')

    // #then — parent moved to medium but keeps its subtasks
    const resultParent = result.find((t) => t.id === 'p1')!
    expect(resultParent.priority).toBe('medium')
    expect(resultParent.subtaskIds).toEqual(['s1', 's2'])
    expect(result).toHaveLength(3)
  })
})
