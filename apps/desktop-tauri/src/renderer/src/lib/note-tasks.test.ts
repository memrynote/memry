import { describe, expect, it } from 'vitest'

import type { Task } from '@/data/task-model'
import { groupTasksByNote } from './note-tasks'

const task = (overrides: Partial<Task> & { id: string }): Task => ({
  title: overrides.id,
  description: '',
  projectId: 'p1',
  statusId: 's1',
  priority: 'none',
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  repeatFrom: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  tags: [],
  parentId: null,
  subtaskIds: [],
  createdAt: new Date('2026-01-01'),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

describe('groupTasksByNote', () => {
  it('files a task under its source note and under every note it is linked to', () => {
    const result = groupTasksByNote(
      [
        task({ id: 'a', sourceNoteId: 'n1' }),
        task({ id: 'b', linkedNoteIds: ['n2', 'n1'] }),
        task({ id: 'c', sourceNoteId: 'elsewhere' }),
        task({ id: 'd' })
      ],
      new Set(['n1', 'n2'])
    )

    expect([...result.keys()].toSorted()).toEqual(['n1', 'n2'])
    expect(result.get('n1')?.tasks.map((t) => t.id)).toEqual(['a', 'b'])
    expect(result.get('n2')?.tasks.map((t) => t.id)).toEqual(['b'])
  })

  it('lists a task once when its source note is also linked', () => {
    const result = groupTasksByNote(
      [task({ id: 'a', sourceNoteId: 'n1', linkedNoteIds: ['n1'] })],
      new Set(['n1'])
    )
    expect(result.get('n1')?.total).toBe(1)
  })

  it('counts open tasks, finds the next due date, and lists done tasks last', () => {
    const later = new Date('2026-05-10')
    const sooner = new Date('2026-05-02')
    const result = groupTasksByNote(
      [
        task({
          id: 'done',
          sourceNoteId: 'n1',
          completedAt: new Date(),
          dueDate: new Date('2026-01-01')
        }),
        task({ id: 'undated', sourceNoteId: 'n1' }),
        task({ id: 'later', sourceNoteId: 'n1', dueDate: later }),
        task({ id: 'sooner', sourceNoteId: 'n1', dueDate: sooner })
      ],
      new Set(['n1'])
    )

    const note = result.get('n1')
    expect(note?.tasks.map((t) => t.id)).toEqual(['sooner', 'later', 'undated', 'done'])
    expect(note?.total).toBe(4)
    expect(note?.open).toBe(3)
    expect(note?.nextDue).toEqual(sooner)
  })

  it('ignores archived tasks', () => {
    const result = groupTasksByNote(
      [task({ id: 'a', sourceNoteId: 'n1', archivedAt: new Date() })],
      new Set(['n1'])
    )
    expect(result.size).toBe(0)
  })
})
