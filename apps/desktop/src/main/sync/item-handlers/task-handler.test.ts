import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import { tasks } from '@memry/db-schema/schema/tasks'
import { taskTags, taskNotes } from '@memry/db-schema/schema/task-relations'
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

describe('taskHandler buildPushPayload', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
    testDb.db.insert(projects).values(TEST_PROJECT).run()
    testDb.db.insert(statuses).values(TEST_STATUSES).run()
  })

  afterEach(() => {
    testDb.close()
  })

  it('includes tags and linkedNoteIds from junction tables', () => {
    // #given
    testDb.db
      .insert(tasks)
      .values({
        id: 'task-push-1',
        projectId: 'proj-1',
        statusId: 'status-todo',
        title: 'Task with tags',
        priority: 0,
        position: 0,
        clock: { 'device-A': 1 }
      })
      .run()

    testDb.db
      .insert(taskTags)
      .values([
        { taskId: 'task-push-1', tag: 'urgent' },
        { taskId: 'task-push-1', tag: 'bug' }
      ])
      .run()
    testDb.db
      .insert(taskNotes)
      .values([
        { taskId: 'task-push-1', noteId: 'note-1' },
        { taskId: 'task-push-1', noteId: 'note-2' }
      ])
      .run()

    // #when
    const payload = taskHandler.buildPushPayload(
      testDb.db as unknown as DrizzleDb,
      'task-push-1',
      'device-A',
      'update'
    )

    // #then
    expect(payload).not.toBeNull()
    const parsed = JSON.parse(payload!)
    expect(parsed.tags).toBeDefined()
    expect(parsed.tags.sort()).toEqual(['bug', 'urgent'])
    expect(parsed.linkedNoteIds).toBeDefined()
    expect(parsed.linkedNoteIds.sort()).toEqual(['note-1', 'note-2'])
  })

  it('includes empty arrays when no junction data exists', () => {
    // #given
    testDb.db
      .insert(tasks)
      .values({
        id: 'task-push-2',
        projectId: 'proj-1',
        statusId: 'status-todo',
        title: 'Task without tags',
        priority: 0,
        position: 0,
        clock: { 'device-A': 1 }
      })
      .run()

    // #when
    const payload = taskHandler.buildPushPayload(
      testDb.db as unknown as DrizzleDb,
      'task-push-2',
      'device-A',
      'update'
    )

    // #then
    expect(payload).not.toBeNull()
    const parsed = JSON.parse(payload!)
    expect(parsed.tags).toEqual([])
    expect(parsed.linkedNoteIds).toEqual([])
  })
})

describe('taskHandler applyUpsert with tags/linkedNoteIds', () => {
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

  function getTagsForTask(taskId: string): string[] {
    return testDb.db
      .select({ tag: taskTags.tag })
      .from(taskTags)
      .where(eq(taskTags.taskId, taskId))
      .all()
      .map((r) => r.tag)
      .sort()
  }

  function getNoteIdsForTask(taskId: string): string[] {
    return testDb.db
      .select({ noteId: taskNotes.noteId })
      .from(taskNotes)
      .where(eq(taskNotes.taskId, taskId))
      .all()
      .map((r) => r.noteId)
      .sort()
  }

  it('writes remote tags and linkedNoteIds on INSERT (new task)', () => {
    // #given — no local task exists
    // #when
    const result = taskHandler.applyUpsert(
      ctx,
      'task-new-1',
      makeTaskPayload({
        tags: ['feature', 'v2'],
        linkedNoteIds: ['note-a', 'note-b']
      }),
      { 'device-B': 1 }
    )

    // #then
    expect(result).toBe('applied')
    expect(getTagsForTask('task-new-1')).toEqual(['feature', 'v2'])
    expect(getNoteIdsForTask('task-new-1')).toEqual(['note-a', 'note-b'])
  })

  it('replaces local tags with remote on APPLY (remote wins)', () => {
    // #given — local task with tags, remote has newer clock
    testDb.db
      .insert(tasks)
      .values({
        id: 'task-apply-1',
        projectId: 'proj-1',
        statusId: 'status-todo',
        title: 'Task',
        priority: 0,
        position: 0,
        clock: { 'device-A': 1 }
      })
      .run()
    testDb.db
      .insert(taskTags)
      .values([{ taskId: 'task-apply-1', tag: 'old-tag' }])
      .run()
    testDb.db
      .insert(taskNotes)
      .values([{ taskId: 'task-apply-1', noteId: 'old-note' }])
      .run()

    // #when — remote wins (dominates local clock on same device)
    const result = taskHandler.applyUpsert(
      ctx,
      'task-apply-1',
      makeTaskPayload({
        tags: ['new-tag-1', 'new-tag-2'],
        linkedNoteIds: ['new-note']
      }),
      { 'device-A': 5 }
    )

    // #then — remote tags replace local
    expect(result).toBe('applied')
    expect(getTagsForTask('task-apply-1')).toEqual(['new-tag-1', 'new-tag-2'])
    expect(getNoteIdsForTask('task-apply-1')).toEqual(['new-note'])
  })

  it('unions local and remote tags on MERGE (concurrent edits)', () => {
    // #given — local task with tags, concurrent clock
    const localFC = initAllFieldClocks({ 'device-A': 1 }, TASK_SYNCABLE_FIELDS)
    testDb.db
      .insert(tasks)
      .values({
        id: 'task-merge-1',
        projectId: 'proj-1',
        statusId: 'status-todo',
        title: 'Task',
        priority: 0,
        position: 0,
        clock: { 'device-A': 2 },
        fieldClocks: localFC
      })
      .run()
    testDb.db
      .insert(taskTags)
      .values([
        { taskId: 'task-merge-1', tag: 'local-only' },
        { taskId: 'task-merge-1', tag: 'shared' }
      ])
      .run()
    testDb.db
      .insert(taskNotes)
      .values([{ taskId: 'task-merge-1', noteId: 'local-note' }])
      .run()

    // #when — concurrent clocks trigger merge
    const remoteFC = initAllFieldClocks({ 'device-B': 1 }, TASK_SYNCABLE_FIELDS)
    const result = taskHandler.applyUpsert(
      ctx,
      'task-merge-1',
      makeTaskPayload({
        tags: ['remote-only', 'shared'],
        linkedNoteIds: ['remote-note'],
        fieldClocks: remoteFC
      }),
      { 'device-B': 2 }
    )

    // #then — union of both sides
    expect(['applied', 'conflict']).toContain(result)
    expect(getTagsForTask('task-merge-1')).toEqual(['local-only', 'remote-only', 'shared'])
    expect(getNoteIdsForTask('task-merge-1')).toEqual(['local-note', 'remote-note'])
  })

  it('preserves existing tags when remote payload omits them', () => {
    // #given — local task with tags
    testDb.db
      .insert(tasks)
      .values({
        id: 'task-omit-1',
        projectId: 'proj-1',
        statusId: 'status-todo',
        title: 'Task',
        priority: 0,
        position: 0,
        clock: { 'device-A': 1 }
      })
      .run()
    testDb.db
      .insert(taskTags)
      .values([{ taskId: 'task-omit-1', tag: 'keep-me' }])
      .run()

    // #when — remote payload has no tags field (undefined)
    taskHandler.applyUpsert(ctx, 'task-omit-1', makeTaskPayload({}), { 'device-B': 5 })

    // #then — local tags preserved (not wiped)
    expect(getTagsForTask('task-omit-1')).toEqual(['keep-me'])
  })
})
