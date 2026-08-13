/**
 * Task activity log — write path.
 *
 * These run the REAL publisher against a REAL SQLite database, with only the
 * outward effects (electron broadcast, sync enqueue, telemetry) mocked. That is
 * deliberate: a test that asserts "the publisher called a mocked writer" passes
 * just as happily when the writer is wired to nothing, so the assertions here
 * are on rows that actually landed in `task_activity`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { taskActivity } from '@memry/db-schema/schema/task-activity'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import type { Task } from '@memry/domain-tasks'

let testDb: TestDatabaseResult

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}))

vi.mock('../database', () => ({
  getDatabase: () => testDb.db,
  requireDatabase: () => testDb.db
}))

const enqueueLocalSyncCreate = vi.fn()
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: (...args: unknown[]) => enqueueLocalSyncCreate(...args),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

vi.mock('./runtime-effects', () => ({
  syncTaskCreate: vi.fn(),
  syncTaskUpdate: vi.fn(),
  syncTaskDelete: vi.fn(),
  syncProjectCreate: vi.fn(),
  syncProjectUpdate: vi.fn(),
  syncProjectDelete: vi.fn()
}))

vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))

import { createTasksPublisher } from './publisher'
import { recordTaskSuperseded, taskSupersededActivityId } from './activity-log'

const DEVICE = 'device-A'

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
    createdAt: '2026-08-13T00:00:00.000Z',
    modifiedAt: '2026-08-13T00:00:00.000Z',
    tags: [],
    linkedNoteIds: [],
    isRepeating: false,
    ...overrides
  } as unknown as Task
}

function rows(): Array<typeof taskActivity.$inferSelect> {
  return testDb.db.select().from(taskActivity).all()
}

describe('task activity write path', () => {
  beforeEach(() => {
    testDb = createTestDataDb()
    enqueueLocalSyncCreate.mockClear()
    testDb.db
      .insert(syncDevices)
      .values({
        id: DEVICE,
        name: 'A',
        platform: 'darwin',
        appVersion: '1.0.0',
        linkedAt: new Date(0),
        isCurrentDevice: true,
        signingPublicKey: 'pk'
      })
      .run()
  })

  afterEach(() => {
    testDb.close()
  })

  it('writes a created row through the publisher and enqueues it for sync', () => {
    createTasksPublisher().taskCreated({ task: makeTask({ title: 'Buy milk' }) })

    const [row] = rows()
    expect(row.taskId).toBe('task-1')
    expect(row.action).toBe('created')
    expect(row.newValue).toBe(JSON.stringify('Buy milk'))
    expect(row.deviceId).toBe(DEVICE)
    expect(enqueueLocalSyncCreate).toHaveBeenCalledWith('task_activity', row.id)
  })

  it('writes one row per changed field with old and new values', () => {
    createTasksPublisher().taskUpdated({
      id: 'task-1',
      task: makeTask({ priority: 2, dueDate: '2026-08-20' }),
      changes: { priority: 2, dueDate: '2026-08-20' },
      changedFields: ['priority', 'dueDate'],
      previous: { priority: 0, dueDate: '2026-08-12' }
    })

    const all = rows()
    expect(all).toHaveLength(2)
    const due = all.find((row) => row.field === 'dueDate')
    expect(due?.oldValue).toBe(JSON.stringify('2026-08-12'))
    expect(due?.newValue).toBe(JSON.stringify('2026-08-20'))
  })

  it('never stores the description body — only a length delta', () => {
    const body = 'a'.repeat(500)
    createTasksPublisher().taskUpdated({
      id: 'task-1',
      task: makeTask({ description: body }),
      changes: { description: body },
      changedFields: ['description'],
      previous: {}
    })

    const [row] = rows()
    expect(row.oldValue).toBeNull()
    expect(row.newValue).toBe(JSON.stringify({ delta: 500 }))
    expect(JSON.stringify(row)).not.toContain(body)
  })

  it('writes nothing for a position-only change', () => {
    createTasksPublisher().taskUpdated({
      id: 'task-1',
      task: makeTask({ position: 7 }),
      changes: { position: 7 },
      changedFields: ['position'],
      previous: { position: 3 }
    })

    expect(rows()).toHaveLength(0)
    expect(enqueueLocalSyncCreate).not.toHaveBeenCalled()
  })

  it('writes nothing when the differ reports a no-op', () => {
    createTasksPublisher().taskUpdated({
      id: 'task-1',
      task: makeTask(),
      changes: {},
      changedFields: [],
      previous: {}
    })

    expect(rows()).toHaveLength(0)
  })

  it('does not hook taskReordered — a 200-task drag must not write 200 rows', () => {
    const publisher = createTasksPublisher()
    for (let index = 0; index < 200; index += 1) {
      publisher.taskReordered?.({ id: `task-${index}`, changedFields: ['position'] })
    }

    expect(rows()).toHaveLength(0)
  })

  it('distinguishes completed from reopened', () => {
    const publisher = createTasksPublisher()
    publisher.taskCompleted({
      id: 'task-1',
      task: makeTask({ completedAt: '2026-08-13T10:00:00.000Z' }),
      previous: { completedAt: null }
    })
    publisher.taskCompleted({
      id: 'task-1',
      task: makeTask({ completedAt: null }),
      previous: { completedAt: '2026-08-13T10:00:00.000Z' }
    })

    expect(rows().map((row) => row.action)).toEqual(['completed', 'uncompleted'])
  })

  it('writes nothing when completion did not actually flip', () => {
    createTasksPublisher().taskCompleted({
      id: 'task-1',
      task: makeTask({ completedAt: '2026-08-13T10:00:00.000Z' }),
      previous: { completedAt: '2026-08-13T09:00:00.000Z' }
    })

    expect(rows()).toHaveLength(0)
  })

  it('keeps the deleted entry, which is what outlives the task', () => {
    createTasksPublisher().taskDeleted({ id: 'task-1', snapshot: makeTask({ title: 'Gone' }) })

    const [row] = rows()
    expect(row.action).toBe('deleted')
    expect(row.oldValue).toBe(JSON.stringify('Gone'))
  })

  it('a database failure cannot take the mutation down with it', () => {
    testDb.close()

    expect(() => createTasksPublisher().taskCreated({ task: makeTask() })).not.toThrow()
  })
})

describe('superseded rows', () => {
  beforeEach(() => {
    testDb = createTestDataDb()
    enqueueLocalSyncCreate.mockClear()
  })

  afterEach(() => {
    testDb.close()
  })

  it('mints the same id on both sides of the same conflict, so the row collapses', () => {
    // Mirror images: each device sees its own value as local and the peer's as
    // remote. The merged clock is the union, which is commutative — so both
    // sides land on one id.
    const mergedClock = { 'device-A': 2, 'device-B': 2 }

    recordTaskSuperseded({
      taskId: 'task-1',
      field: 'dueDate',
      losingValue: '2026-08-12',
      winningValue: '2026-08-20',
      mergedClock
    })
    recordTaskSuperseded({
      taskId: 'task-1',
      field: 'dueDate',
      losingValue: '2026-08-20',
      winningValue: '2026-08-12',
      mergedClock: { 'device-B': 2, 'device-A': 2 }
    })

    const all = rows()
    expect(all).toHaveLength(1)
    expect(all[0].action).toBe('superseded')
    expect(all[0].actor).toBe('sync')
    expect(all[0].oldValue).toBe(JSON.stringify('2026-08-12'))
  })

  it('key order in the clock cannot change the id', () => {
    expect(taskSupersededActivityId('t', 'f', { b: 1, a: 2 })).toBe(
      taskSupersededActivityId('t', 'f', { a: 2, b: 1 })
    )
  })

  it('a different field or task is a different row', () => {
    const clock = { 'device-A': 1 }
    expect(taskSupersededActivityId('t1', 'dueDate', clock)).not.toBe(
      taskSupersededActivityId('t1', 'priority', clock)
    )
    expect(taskSupersededActivityId('t1', 'dueDate', clock)).not.toBe(
      taskSupersededActivityId('t2', 'dueDate', clock)
    )
  })
})
