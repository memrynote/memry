/**
 * Tasks publisher tests
 *
 * Regression: creating/updating a task's tags must broadcast `notes:tags-changed`
 * so the tag list (tasks filter sidebar) refreshes without an app restart.
 *
 * @module tasks/publisher.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Task } from '@memry/domain-tasks'

const mockSend = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mockSend } }
    ])
  }
}))

vi.mock('./runtime-effects', () => ({
  syncTaskCreate: vi.fn(),
  syncTaskUpdate: vi.fn(),
  syncTaskDelete: vi.fn(),
  syncProjectCreate: vi.fn(),
  syncProjectUpdate: vi.fn(),
  syncProjectDelete: vi.fn()
}))

vi.mock('../telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))

import { createTasksPublisher } from './publisher'

const TAGS_CHANGED = 'notes:tags-changed'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    statusId: null,
    parentId: null,
    title: 'Task',
    description: null,
    priority: 0,
    position: 0,
    dueDate: null,
    dueTime: null,
    startDate: null,
    repeatConfig: null,
    repeatFrom: null,
    sourceNoteId: null,
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    modifiedAt: '2026-07-22T00:00:00.000Z',
    tags: [],
    linkedNoteIds: [],
    ...overrides
  } as Task
}

describe('createTasksPublisher tags-changed broadcast', () => {
  beforeEach(() => {
    mockSend.mockClear()
  })

  it('broadcasts notes:tags-changed when a created task has tags', () => {
    const publisher = createTasksPublisher()
    publisher.taskCreated({ task: makeTask({ tags: ['urgent'] }) })
    expect(mockSend).toHaveBeenCalledWith(TAGS_CHANGED, {})
  })

  it('does not broadcast notes:tags-changed when a created task has no tags', () => {
    const publisher = createTasksPublisher()
    publisher.taskCreated({ task: makeTask({ tags: [] }) })
    expect(mockSend).not.toHaveBeenCalledWith(TAGS_CHANGED, {})
  })

  it('broadcasts notes:tags-changed when an update changes tags', () => {
    const publisher = createTasksPublisher()
    publisher.taskUpdated({
      id: 'task-1',
      task: makeTask({ tags: ['new'] }),
      changes: { tags: ['new'] },
      changedFields: ['tags']
    })
    expect(mockSend).toHaveBeenCalledWith(TAGS_CHANGED, {})
  })

  it('does not broadcast notes:tags-changed when an update does not touch tags', () => {
    const publisher = createTasksPublisher()
    publisher.taskUpdated({
      id: 'task-1',
      task: makeTask({ title: 'Renamed' }),
      changes: { title: 'Renamed' },
      changedFields: ['title']
    })
    expect(mockSend).not.toHaveBeenCalledWith(TAGS_CHANGED, {})
  })

  it('broadcasts notes:tags-changed when a deleted task had tags', () => {
    const publisher = createTasksPublisher()
    publisher.taskDeleted({ id: 'task-1', snapshot: makeTask({ tags: ['urgent'] }) })
    expect(mockSend).toHaveBeenCalledWith(TAGS_CHANGED, {})
  })

  it('does not broadcast notes:tags-changed when a deleted task had no tags', () => {
    const publisher = createTasksPublisher()
    publisher.taskDeleted({ id: 'task-1', snapshot: makeTask({ tags: [] }) })
    expect(mockSend).not.toHaveBeenCalledWith(TAGS_CHANGED, {})
  })
})
