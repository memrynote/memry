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

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

vi.mock('../projections', () => ({ publishProjectionEvent: vi.fn() }))
vi.mock('../calendar/change-events', () => ({ emitCalendarProjectionChanged: vi.fn() }))
vi.mock('../calendar/google/local-sync-effects', () => ({
  scheduleGoogleCalendarSourceSync: vi.fn()
}))

vi.mock('./activity-log', () => ({
  recordTaskCompleted: vi.fn(),
  recordTaskCreated: vi.fn(),
  recordTaskDeleted: vi.fn(),
  recordTaskMoved: vi.fn(),
  recordTaskUpdated: vi.fn()
}))

vi.mock('../telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))

vi.mock('./remove-task-line-from-note', () => ({
  removeTaskLineFromSourceNote: vi.fn(async () => {})
}))

import { createTasksPublisher } from './publisher'
import { removeTaskLineFromSourceNote } from './remove-task-line-from-note'
import * as localMutations from '../sync/local-mutations'
import { publishProjectionEvent } from '../projections'

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

describe('createTasksPublisher source-note cleanup', () => {
  beforeEach(() => {
    vi.mocked(removeTaskLineFromSourceNote).mockClear()
  })

  it('removes the checkbox line from the note a deleted task came from', async () => {
    const publisher = createTasksPublisher()
    await publisher.taskDeleted({
      id: 'task-1',
      snapshot: makeTask({ sourceNoteId: 'note-1' })
    })
    expect(removeTaskLineFromSourceNote).toHaveBeenCalledWith('task-1', 'note-1')
  })

  it('touches no note when the deleted task did not come from one', async () => {
    const publisher = createTasksPublisher()
    await publisher.taskDeleted({ id: 'task-1', snapshot: makeTask({ sourceNoteId: null }) })
    expect(removeTaskLineFromSourceNote).not.toHaveBeenCalled()
  })

  it('touches no note when the delete carries no snapshot', async () => {
    const publisher = createTasksPublisher()
    await publisher.taskDeleted({ id: 'task-1' })
    expect(removeTaskLineFromSourceNote).not.toHaveBeenCalled()
  })
})

// #2301: sync for tasks and projects is committed by the domain's unit of work
// together with the row (tasks/sync-intents.ts). The publisher runs after that
// commit and must not enqueue a second time.
describe('createTasksPublisher leaves sync to the unit of work', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('never enqueues a task or project sync, and still refreshes task projections', async () => {
    const publisher = createTasksPublisher()
    const task = makeTask()
    const project = { id: 'proj-1', name: 'P' } as never
    const status = { id: 's-1', projectId: 'proj-1' } as never

    publisher.taskCreated({ task })
    publisher.taskUpdated({ id: 'task-1', task, changes: {}, changedFields: ['title'] })
    publisher.taskCompleted({ id: 'task-1', task })
    publisher.taskMoved({ id: 'task-1', task, changedFields: ['position'] })
    publisher.taskReordered?.({ id: 'task-1', changedFields: ['position'] })
    await publisher.taskDeleted({ id: 'task-1', snapshot: task })
    publisher.projectCreated({ project })
    publisher.projectUpdated({ id: 'proj-1', project, changedFields: ['name'] })
    publisher.projectDeleted({ id: 'proj-1', snapshot: project })
    publisher.statusCreated({ status })
    publisher.statusUpdated({ status })
    publisher.statusDeleted({ id: 's-1', projectId: 'proj-1' })

    expect(localMutations.enqueueLocalSyncCreate).not.toHaveBeenCalled()
    expect(localMutations.enqueueLocalSyncUpdate).not.toHaveBeenCalled()
    expect(localMutations.enqueueLocalSyncDelete).not.toHaveBeenCalled()
    expect(vi.mocked(publishProjectionEvent).mock.calls).toEqual([
      ...Array.from({ length: 5 }, () => [{ type: 'task.upserted', taskId: 'task-1' }]),
      [{ type: 'task.deleted', taskId: 'task-1' }]
    ])
  })
})
