import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { TasksChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { TaskSyncPayloadSchema, type TaskSyncPayload } from '@memry/contracts/sync-payloads'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import { taskCanvases, taskNotes, taskTags } from '@memry/db-schema/schema/task-relations'
import { tasks } from '@memry/db-schema/schema/tasks'
import type { VersionedMap } from '@memry/shared/versioned'
import { TASK_SYNCABLE_FIELDS, initAllFieldClocks } from '@memry/sync-client/field-merge'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  getTaskSyncService,
  initTaskSyncService,
  resetTaskSyncService
} from '@memry/sync-client/task-sync'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import {
  TEST_PROJECT,
  TEST_STATUSES,
  makeCtx,
  makeTaskPayload
} from '@tests/utils/fixtures/sync-item-handlers'
import { taskHandler } from './task-handler'

const WAITING_ON = { v: ['memry://note/n1'], t: 2 }
const FOLLOW_UP = { v: '2026-05-14', t: 1 }

let testDb: TestDatabaseResult
let ctx: ApplyContext
let queue: SyncQueueManager

beforeEach(() => {
  testDb = createTestDataDb()
  ctx = makeCtx(testDb)
  queue = new SyncQueueManager(asClientDb(testDb.db))
  initTaskSyncService({ queue, db: asClientDb(testDb.db), getDeviceId: () => 'device-a' })
  testDb.db.insert(projects).values(TEST_PROJECT).run()
  testDb.db
    .insert(statuses)
    .values([...TEST_STATUSES])
    .run()
})

afterEach(() => {
  resetTaskSyncService()
  testDb.close()
})

function seed(fields: VersionedMap | null, clock: VectorClock, title = 'Task'): void {
  const fieldClocks = initAllFieldClocks(clock, TASK_SYNCABLE_FIELDS)
  testDb.db
    .insert(tasks)
    .values({
      id: 'task-1',
      projectId: 'proj-1',
      statusId: 'status-todo',
      title,
      fields,
      clock,
      fieldClocks
    })
    .run()
}

function row(): { fields: unknown; clock: unknown } | undefined {
  return testDb.db
    .select({ fields: tasks.fields, clock: tasks.clock })
    .from(tasks)
    .where(eq(tasks.id, 'task-1'))
    .get()
}

function pushed(): Record<string, unknown> {
  const db = testDb.db as unknown as DrizzleDb
  return JSON.parse(taskHandler.buildPushPayload(db, 'task-1', 'device-a', 'update')!) as Record<
    string,
    unknown
  >
}

function apply(data: Partial<TaskSyncPayload>, clock: VectorClock): string {
  return taskHandler.applyUpsert(ctx, 'task-1', makeTaskPayload(data), clock)
}

describe('task.fields on pull', () => {
  it('keeps entries an older peer stripped and re-pushes them past the replay check', () => {
    seed({ 'Waiting on': WAITING_ON }, { 'device-a': 1 })

    expect(apply({}, { 'device-a': 1, 'device-b': 1 })).toBe('applied')

    expect(row()).toEqual({
      fields: { 'Waiting on': WAITING_ON },
      clock: { 'device-a': 2, 'device-b': 1 }
    })
    expect(queue.dequeue(10)).toMatchObject([
      { type: 'task', itemId: 'task-1', operation: 'update' }
    ])
    expect(pushed().fields).toEqual({ 'Waiting on': WAITING_ON })
  })

  it('rejects stale entries echoed under a newer clock (#2265 capture), keeps newer ones, and heals', () => {
    seed(
      { 'Waiting on': { v: ['memry://note/n2'], t: 4 }, 'Follow up': FOLLOW_UP },
      { 'device-a': 1 }
    )

    apply(
      {
        fields: {
          'Waiting on': { v: ['memry://note/n1'], t: 2 },
          Thread: { v: 'ts-1', t: 3 }
        }
      },
      { 'device-a': 1, 'device-b': 1 }
    )

    expect(row()?.fields).toEqual({
      'Waiting on': { v: ['memry://note/n2'], t: 4 },
      'Follow up': FOLLOW_UP,
      Thread: { v: 'ts-1', t: 3 }
    })
    expect(queue.dequeue(10)).toHaveLength(1)
  })

  it('takes newer entries without re-pushing them', () => {
    seed({ 'Follow up': FOLLOW_UP }, { 'device-a': 1 })

    apply({ fields: { 'Follow up': { v: '2026-06-01', t: 4 } } }, { 'device-a': 1, 'device-b': 1 })

    expect(row()?.fields).toEqual({ 'Follow up': { v: '2026-06-01', t: 4 } })
    expect(queue.dequeue(10)).toEqual([])
  })

  it('reads null fields as no information: nothing written, nothing re-pushed', () => {
    seed({ 'Follow up': FOLLOW_UP }, { 'device-a': 1 })

    apply({ fields: null }, { 'device-a': 1, 'device-b': 1 })

    expect(row()?.fields).toEqual({ 'Follow up': FOLLOW_UP })
    expect(queue.dequeue(10)).toEqual([])
  })

  it('applies and re-pushes nothing for its own echo', () => {
    seed({ 'Follow up': FOLLOW_UP }, { 'device-a': 2 })
    const echo = TaskSyncPayloadSchema.parse(pushed())

    expect(taskHandler.applyUpsert(ctx, 'task-1', echo, { 'device-a': 2 })).toBe('skipped')

    expect(row()).toEqual({ fields: { 'Follow up': FOLLOW_UP }, clock: { 'device-a': 2 } })
    expect(queue.dequeue(10)).toEqual([])
  })

  it('joins newer entries carried by a payload the clock skips, without a re-push', () => {
    seed({ 'Follow up': FOLLOW_UP }, { 'device-a': 3 })

    const result = apply({ fields: { 'Follow up': { v: '2026-06-01', t: 4 } } }, { 'device-a': 1 })

    expect(result).toBe('skipped')
    expect(row()).toEqual({
      fields: { 'Follow up': { v: '2026-06-01', t: 4 } },
      clock: { 'device-a': 3 }
    })
    expect(queue.dequeue(10)).toEqual([])
    expect(ctx.emit).toHaveBeenCalledWith(
      TasksChannels.events.UPDATED,
      expect.objectContaining({
        task: expect.objectContaining({ fields: { 'Follow up': '2026-06-01' } })
      })
    )
  })

  it('takes the remote map on insert and tells the renderer only the values', () => {
    apply({ fields: { 'Waiting on': WAITING_ON, Thread: { v: null, t: 3 } } }, { 'device-b': 1 })

    expect(row()?.fields).toEqual({ 'Waiting on': WAITING_ON, Thread: { v: null, t: 3 } })
    expect(queue.dequeue(10)).toEqual([])
    expect(ctx.emit).toHaveBeenCalledWith(TasksChannels.events.CREATED, {
      task: expect.objectContaining({ fields: { 'Waiting on': ['memry://note/n1'] } })
    })
  })

  it('heals after a concurrent merge that kept local entries', () => {
    seed({ 'Waiting on': WAITING_ON }, { 'device-a': 2 })

    expect(apply({}, { 'device-b': 1 })).toBe('applied')

    expect(row()).toEqual({
      fields: { 'Waiting on': WAITING_ON },
      clock: { 'device-a': 3, 'device-b': 1 }
    })
    expect(queue.dequeue(10)).toHaveLength(1)
  })

  it('leaves a conflicting merge to its conflict re-queue instead of enqueueing a heal', () => {
    seed({ 'Waiting on': WAITING_ON }, { 'device-a': 1 }, 'Mine')

    const result = apply(
      {
        title: 'Theirs',
        fieldClocks: initAllFieldClocks({ 'device-b': 1 }, TASK_SYNCABLE_FIELDS)
      },
      { 'device-b': 1 }
    )

    expect(result).toBe('conflict')
    expect(row()?.fields).toEqual({ 'Waiting on': WAITING_ON })
    expect(queue.dequeue(10)).toEqual([])
  })
})

describe('task push payload', () => {
  const SENDABLE = new Set([...Object.keys(TaskSyncPayloadSchema.shape), 'id', 'syncedAt'])

  function seedEveryColumn(fields: VersionedMap | null): void {
    testDb.db
      .insert(tasks)
      .values({
        id: 'task-1',
        projectId: 'proj-1',
        statusId: 'status-todo',
        parentId: 'task-0',
        title: 'Task',
        description: 'Body',
        priority: 2,
        position: 3,
        dueDate: '2026-05-14',
        dueTime: '09:00',
        startDate: '2026-05-13',
        repeatConfig: { frequency: 'daily' },
        repeatFrom: 'due',
        sourceNoteId: 'note-1',
        completedAt: '2026-05-15T00:00:00.000Z',
        archivedAt: '2026-05-16T00:00:00.000Z',
        fields,
        syncedAt: '2026-05-16T00:00:00.000Z'
      })
      .run()
    testDb.db.insert(taskTags).values({ taskId: 'task-1', tag: 'work' }).run()
    testDb.db.insert(taskNotes).values({ taskId: 'task-1', noteId: 'note-1' }).run()
    testDb.db.insert(taskCanvases).values({ taskId: 'task-1', canvasId: 'canvas-1' }).run()
  }

  function payloads(): Record<string, Record<string, unknown>> {
    const db = testDb.db as unknown as DrizzleDb
    taskHandler.seedUnclocked(db, 'device-a', queue)
    const seeded = JSON.parse(queue.dequeue(1)[0].payload) as Record<string, unknown>
    getTaskSyncService()!.enqueueUpdate('task-1', ['title'])
    const edited = JSON.parse(queue.dequeue(1)[0].payload) as Record<string, unknown>
    return { seeded, edited, rebuilt: pushed() }
  }

  it.each([
    ['a field map', { 'Waiting on': WAITING_ON } as VersionedMap],
    ['a NULL column', null]
  ])('sends only keys the task schema models, with %s', (_label, fields) => {
    seedEveryColumn(fields)

    for (const [site, payload] of Object.entries(payloads())) {
      expect(
        Object.keys(payload).filter((key) => !SENDABLE.has(key)),
        site
      ).toEqual([])
      if (fields === null) expect(payload, site).not.toHaveProperty('fields')
      else expect(payload.fields, site).toEqual(fields)
      expect(payload, site).toMatchObject({
        tags: ['work'],
        linkedNoteIds: ['note-1'],
        linkedCanvasIds: ['canvas-1']
      })
    }
  })
})
