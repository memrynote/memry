import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import { tasks } from '@memry/db-schema/schema/tasks'
import type { TaskSyncPayload } from '@memry/contracts/sync-payloads'
import { TASK_SYNCABLE_FIELDS, initAllFieldClocks, type FieldClocks } from '../field-merge'
import { taskHandler } from './task-handler'
import type { ApplyContext, DrizzleDb } from './types'

const TEST_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  color: '#000',
  position: 0,
  isInbox: false
}

const TEST_STATUSES = [
  {
    id: 'status-todo',
    projectId: 'proj-1',
    name: 'Todo',
    color: '#6b7280',
    position: 0,
    isDefault: true,
    isDone: false
  },
  {
    id: 'status-done',
    projectId: 'proj-1',
    name: 'Done',
    color: '#22c55e',
    position: 1,
    isDefault: false,
    isDone: true
  }
]

function makeCtx(db: TestDatabaseResult): ApplyContext {
  return {
    db: db.db as unknown as DrizzleDb,
    emit: vi.fn()
  }
}

function makeTaskPayload(overrides: Partial<TaskSyncPayload> = {}): TaskSyncPayload {
  return {
    title: 'Task',
    description: null,
    projectId: 'proj-1',
    statusId: 'status-todo',
    parentId: null,
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
    modifiedAt: '2026-02-23T00:00:00.000Z',
    ...overrides
  }
}

describe('taskHandler field-level merge', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)

    testDb.db.insert(projects).values(TEST_PROJECT).run()
    testDb.db.insert(statuses).values(TEST_STATUSES).run()
  })

  afterEach(() => {
    testDb.close()
  })

  it('preserves both sides when concurrent edits touch different fields', () => {
    const localFieldClocks = initAllFieldClocks({ 'device-A': 1 }, TASK_SYNCABLE_FIELDS)
    localFieldClocks.statusId = { 'device-A': 3 }
    localFieldClocks.dueDate = { 'device-A': 1 }

    testDb.db
      .insert(tasks)
      .values({
        id: 'task-1',
        projectId: 'proj-1',
        statusId: 'status-done',
        title: 'Task',
        priority: 0,
        position: 0,
        dueDate: null,
        clock: { 'device-A': 2 },
        fieldClocks: localFieldClocks
      })
      .run()

    const remoteFieldClocks = initAllFieldClocks({ 'device-B': 1 }, TASK_SYNCABLE_FIELDS)
    remoteFieldClocks.statusId = { 'device-B': 1 }
    remoteFieldClocks.dueDate = { 'device-B': 3 }

    const result = taskHandler.applyUpsert(
      ctx,
      'task-1',
      makeTaskPayload({
        statusId: 'status-todo',
        dueDate: '2026-03-15',
        fieldClocks: remoteFieldClocks
      }),
      { 'device-B': 2 }
    )

    expect(result).toBe('applied')

    const updated = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
    expect(updated).toBeDefined()
    expect(updated!.statusId).toBe('status-done')
    expect(updated!.dueDate).toBe('2026-03-15')
  })

  it('keeps local value on equal field clocks when local contains offline marker', () => {
    const localFieldClocks = initAllFieldClocks(
      { 'device-old': 1, 'device-A': 1 },
      TASK_SYNCABLE_FIELDS
    )
    localFieldClocks.statusId = { 'device-old': 1, _offline: 1 }

    testDb.db
      .insert(tasks)
      .values({
        id: 'task-2',
        projectId: 'proj-1',
        statusId: 'status-done',
        title: 'Task',
        priority: 0,
        position: 0,
        clock: { 'device-old': 1, 'device-A': 1 },
        fieldClocks: localFieldClocks
      })
      .run()

    const remoteFieldClocks = initAllFieldClocks(
      { 'device-old': 1, 'device-B': 1 },
      TASK_SYNCABLE_FIELDS
    )
    remoteFieldClocks.statusId = { 'device-old': 1, 'device-B': 1 }

    const result = taskHandler.applyUpsert(
      ctx,
      'task-2',
      makeTaskPayload({
        statusId: 'status-todo',
        fieldClocks: remoteFieldClocks
      }),
      { 'device-old': 1, 'device-B': 1 }
    )

    expect(result).toBe('conflict')

    const updated = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-2')).get()
    expect(updated).toBeDefined()
    expect(updated!.statusId).toBe('status-done')
  })

  it('uses remote clock fallback when remote field clocks are missing', () => {
    const localFieldClocks = initAllFieldClocks({ 'device-A': 1 }, TASK_SYNCABLE_FIELDS)
    localFieldClocks.statusId = { 'device-A': 3 }
    localFieldClocks.dueDate = { 'device-A': 1 }

    testDb.db
      .insert(tasks)
      .values({
        id: 'task-3',
        projectId: 'proj-1',
        statusId: 'status-done',
        title: 'Task',
        priority: 0,
        position: 0,
        dueDate: null,
        clock: { 'device-A': 2 },
        fieldClocks: localFieldClocks
      })
      .run()

    const result = taskHandler.applyUpsert(
      ctx,
      'task-3',
      makeTaskPayload({
        statusId: 'status-todo',
        dueDate: '2026-04-01',
        fieldClocks: undefined
      }),
      { 'device-B': 2 }
    )

    expect(result).toBe('applied')

    const updated = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-3')).get()
    expect(updated).toBeDefined()
    expect(updated!.statusId).toBe('status-done')
    expect(updated!.dueDate).toBe('2026-04-01')
  })

  it('initializes local legacy items without field clocks and still merges by field clocks', () => {
    testDb.db
      .insert(tasks)
      .values({
        id: 'task-4',
        projectId: 'proj-1',
        statusId: 'status-done',
        title: 'Legacy Task',
        priority: 0,
        position: 0,
        dueDate: null,
        clock: { 'device-A': 2 },
        fieldClocks: null
      })
      .run()

    const remoteFieldClocks = initAllFieldClocks({ 'device-B': 1 }, TASK_SYNCABLE_FIELDS)
    remoteFieldClocks.statusId = { 'device-B': 1 }
    remoteFieldClocks.dueDate = { 'device-B': 3 }

    const result = taskHandler.applyUpsert(
      ctx,
      'task-4',
      makeTaskPayload({
        statusId: 'status-todo',
        dueDate: '2026-05-01',
        fieldClocks: remoteFieldClocks
      }),
      { 'device-B': 2 }
    )

    expect(result).toBe('applied')

    const updated = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-4')).get()
    expect(updated).toBeDefined()
    expect(updated!.statusId).toBe('status-done')
    expect(updated!.dueDate).toBe('2026-05-01')

    const updatedFieldClocks = (updated!.fieldClocks ?? {}) as FieldClocks
    expect(updatedFieldClocks.statusId).toBeDefined()
    expect(updatedFieldClocks.dueDate).toBeDefined()
  })
})
