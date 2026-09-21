import { describe, it, expect } from 'vitest'

import type { Task } from '@/data/task-model'

import { buildTaskNoteIndex, getTaskNoteId } from './task-note-index'

const createMockTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    title: 'Test Task',
    description: '',
    projectId: 'project-1',
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
  }) as Task

describe('task-note-index', () => {
  describe('buildTaskNoteIndex', () => {
    it('should derive the vault-relative folder from the note path', () => {
      // #given
      const notes = [{ id: 'note-1', path: 'Acme/Legal/NDA/nda-review.md', title: 'NDA review' }]

      // #when
      const index = buildTaskNoteIndex(notes)

      // #then
      expect(index.get('note-1')).toEqual({
        id: 'note-1',
        title: 'NDA review',
        folderPath: 'Acme/Legal/NDA'
      })
    })

    it('should report a root-level note as living in the vault root', () => {
      // #given
      const notes = [{ id: 'note-1', path: 'scratch.md', title: 'Scratch' }]

      // #when
      const index = buildTaskNoteIndex(notes)

      // #then
      expect(index.get('note-1')?.folderPath).toBe('')
    })

    it('should fall back to the file name when the title is blank', () => {
      // #given
      const notes = [{ id: 'note-1', path: 'Acme/counterparty-notes.md', title: '  ' }]

      // #when
      const index = buildTaskNoteIndex(notes)

      // #then
      expect(index.get('note-1')?.title).toBe('counterparty-notes')
    })
  })

  describe('getTaskNoteId', () => {
    it('should prefer the source note over related notes', () => {
      // #given
      const task = createMockTask({ sourceNoteId: 'note-source', linkedNoteIds: ['note-linked'] })

      // #when / #then
      expect(getTaskNoteId(task)).toBe('note-source')
    })

    it('should fall back to the first related note', () => {
      // #given
      const task = createMockTask({ linkedNoteIds: ['note-linked', 'note-other'] })

      // #when / #then
      expect(getTaskNoteId(task)).toBe('note-linked')
    })

    it('should return null when the task is attached to nothing', () => {
      // #given
      const task = createMockTask()

      // #when / #then
      expect(getTaskNoteId(task)).toBeNull()
    })
  })
})
