import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'

let activeDb: unknown = null

vi.mock('../database', () => ({
  getDatabase: () => activeDb,
  requireDatabase: () => activeDb
}))

import type {
  ProjectWithStatuses,
  Task,
  TasksDomainEvent,
  TasksDomainPublisher
} from '@memry/domain-tasks'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { syncIntents } from '@memry/db-schema/schema/sync-intents'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import type { DataDb } from '../database/client'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { initTaskSyncService, resetTaskSyncService } from '@memry/sync-client/task-sync'
import { initProjectSyncService, resetProjectSyncService } from '@memry/sync-client/project-sync'
import { drainSyncIntents } from '../sync/sync-intents'
import { createDesktopTasksDomain } from './domain'
import { tasksEventSyncIntents } from './sync-intents'
import { commitTaskRetag } from '../tags/runtime-effects'

const DEVICE_ID = 'device-A'

describe('tasksEventSyncIntents (#2301)', () => {
  const task = { id: 'task-1', projectId: 'proj-1', title: 'Task' } as Task
  const project = { id: 'proj-1', name: 'Project', statuses: [] } as unknown as ProjectWithStatuses
  const status = {
    id: 'status-1',
    projectId: 'proj-1',
    name: 'Todo',
    color: '#ccc',
    position: 0,
    isDefault: true,
    isDone: false,
    createdAt: 'n'
  }

  // #2301: one row per event kind, mirroring the sync calls the publisher
  // used to make, so the wire sees exactly the same mutations as before.
  it.each<[string, TasksDomainEvent, ReturnType<typeof tasksEventSyncIntents>]>([
    [
      'taskCreated',
      { kind: 'taskCreated', payload: { task } },
      [{ type: 'task', itemId: 'task-1', op: 'create', args: [] }]
    ],
    [
      'taskUpdated',
      {
        kind: 'taskUpdated',
        payload: { id: 'task-1', task, changes: {}, changedFields: ['title'] }
      },
      [{ type: 'task', itemId: 'task-1', op: 'update', args: [['title']] }]
    ],
    [
      'taskCompleted',
      { kind: 'taskCompleted', payload: { id: 'task-1', task } },
      [{ type: 'task', itemId: 'task-1', op: 'update', args: [['completedAt']] }]
    ],
    [
      'taskMoved',
      { kind: 'taskMoved', payload: { id: 'task-1', task, changedFields: ['position'] } },
      [{ type: 'task', itemId: 'task-1', op: 'update', args: [['position']] }]
    ],
    [
      'taskReordered',
      { kind: 'taskReordered', payload: { id: 'task-1', changedFields: ['position'] } },
      [{ type: 'task', itemId: 'task-1', op: 'update', args: [['position']] }]
    ],
    [
      'taskDeleted',
      { kind: 'taskDeleted', payload: { id: 'task-1', snapshot: task } },
      [{ type: 'task', itemId: 'task-1', op: 'delete', args: [JSON.stringify(task)] }]
    ],
    ['taskDeleted without snapshot', { kind: 'taskDeleted', payload: { id: 'task-1' } }, []],
    [
      'projectCreated',
      { kind: 'projectCreated', payload: { project } },
      [{ type: 'project', itemId: 'proj-1', op: 'create', args: [] }]
    ],
    [
      'projectUpdated',
      { kind: 'projectUpdated', payload: { id: 'proj-1', project, changedFields: ['name'] } },
      [{ type: 'project', itemId: 'proj-1', op: 'update', args: [['name']] }]
    ],
    [
      'projectUpdated without fields',
      { kind: 'projectUpdated', payload: { id: 'proj-1', project } },
      [{ type: 'project', itemId: 'proj-1', op: 'update', args: [] }]
    ],
    [
      'projectDeleted',
      { kind: 'projectDeleted', payload: { id: 'proj-1', snapshot: project } },
      [{ type: 'project', itemId: 'proj-1', op: 'delete', args: [JSON.stringify(project)] }]
    ],
    ['projectDeleted without snapshot', { kind: 'projectDeleted', payload: { id: 'proj-1' } }, []],
    [
      'statusCreated',
      { kind: 'statusCreated', payload: { status } },
      [{ type: 'project', itemId: 'proj-1', op: 'update', args: [['statuses']] }]
    ],
    [
      'statusUpdated',
      { kind: 'statusUpdated', payload: { status } },
      [{ type: 'project', itemId: 'proj-1', op: 'update', args: [['statuses']] }]
    ],
    [
      'statusDeleted',
      { kind: 'statusDeleted', payload: { id: 'status-1', projectId: 'proj-1' } },
      [{ type: 'project', itemId: 'proj-1', op: 'update', args: [['statuses']] }]
    ]
  ])('maps %s', (_name, event, expected) => {
    expect(tasksEventSyncIntents(event)).toEqual(expected)
  })
})

describe('desktop tasks domain commits sync with the write (#2301)', () => {
  let testDb: TestDatabaseResult
  let db: DataDb
  let queue: SyncQueueManager

  beforeEach(() => {
    testDb = createTestDataDb()
    db = asClientDb(testDb.db)
    activeDb = db
    queue = new SyncQueueManager(db)
    initTaskSyncService({ queue, db, getDeviceId: () => DEVICE_ID })
    initProjectSyncService({ queue, db, getDeviceId: () => DEVICE_ID })
    db.insert(syncDevices)
      .values({
        id: DEVICE_ID,
        name: 'Test device',
        platform: 'darwin',
        appVersion: '2026.8.19',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'pk'
      })
      .run()
    db.insert(projects).values({ id: 'proj-1', name: 'Project', color: '#000' }).run()
    for (const id of ['task-1', 'task-2', 'task-3']) {
      db.insert(tasks)
        .values({ id, projectId: 'proj-1', title: id, priority: 0, position: 0 })
        .run()
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetTaskSyncService()
    resetProjectSyncService()
    activeDb = null
    testDb.close()
  })

  function publisher(overrides: Partial<TasksDomainPublisher> = {}): TasksDomainPublisher {
    return {
      taskCreated: vi.fn(),
      taskUpdated: vi.fn(),
      taskDeleted: vi.fn(),
      taskCompleted: vi.fn(),
      taskMoved: vi.fn(),
      taskReordered: vi.fn(),
      projectCreated: vi.fn(),
      projectUpdated: vi.fn(),
      projectDeleted: vi.fn(),
      statusCreated: vi.fn(),
      statusUpdated: vi.fn(),
      statusDeleted: vi.fn(),
      ...overrides
    }
  }

  function queuedDeletes(): string[] {
    return queue
      .peek(50)
      .filter((row) => row.operation === 'delete')
      .map((row) => `${row.type}:${row.itemId}`)
      .sort()
  }

  // #2301: the old publisher loop enqueued one tombstone per cascaded task
  // and stopped at the first throw. Every tombstone now commits before any
  // publisher code runs.
  // #2301 review B-8: one failing side effect neither drops the rest nor
  // rejects a command whose write already committed.
  it('queues a delete for the project and every cascaded task even when the publisher throws', async () => {
    const taskDeleted = vi.fn((event: { id: string }) => {
      if (event.id === 'task-1') throw new Error('file cleanup failed')
    })
    const domain = createDesktopTasksDomain(db, publisher({ taskDeleted }), () => 'unused')

    await expect(domain.deleteProject('proj-1')).resolves.toEqual({ success: true })
    expect(taskDeleted.mock.calls.map(([event]) => event.id).sort()).toEqual([
      'task-1',
      'task-2',
      'task-3'
    ])

    expect(db.select().from(projects).all()).toEqual([])
    expect(queuedDeletes()).toEqual(['project:proj-1', 'task:task-1', 'task:task-2', 'task:task-3'])
    expect(db.select().from(syncIntents).all()).toEqual([])
  })

  // #2301: a crash between the delete commit and the queueing leaves the
  // tombstone intents written with the row delete; the next drain queues them.
  it('keeps every cascade tombstone as an intent when queueing fails, and replays it', async () => {
    vi.spyOn(queue, 'enqueue').mockImplementation(() => {
      throw new Error('queue broke')
    })
    const domain = createDesktopTasksDomain(db, publisher(), () => 'unused')

    await expect(domain.deleteProject('proj-1')).resolves.toEqual({ success: true })

    expect(db.select().from(projects).all()).toEqual([])
    expect(
      db
        .select()
        .from(syncIntents)
        .all()
        .map((row) => `${row.op}:${row.type}:${row.itemId}`)
    ).toEqual([
      'delete:project:proj-1',
      'delete:task:task-1',
      'delete:task:task-2',
      'delete:task:task-3'
    ])

    vi.mocked(queue.enqueue).mockRestore()
    expect(drainSyncIntents(db, 'startup')).toMatchObject({ applied: 4, failed: 0 })
    expect(queuedDeletes()).toEqual(['project:proj-1', 'task:task-1', 'task:task-2', 'task:task-3'])
  })

  // #2301 review A-7: cascade tombstones carry each task's real clock. A
  // tombstone at a fresh clock is dominated by the row's and loses.
  it('queues cascade deletes whose clock dominates each task row', async () => {
    db.update(tasks)
      .set({ clock: { 'device-B': 3 } })
      .run()
    const domain = createDesktopTasksDomain(db, publisher(), () => 'unused')

    await domain.deleteProject('proj-1')

    const taskDeletes = queue.peek(50).filter((row) => row.type === 'task')
    expect(taskDeletes).toHaveLength(3)
    for (const row of taskDeletes) {
      expect(JSON.parse(row.payload).clock).toEqual({ 'device-B': 3, [DEVICE_ID]: 1 })
    }
  })

  // #2301 review A-3: a tag merge's task_tags write does not move
  // modified_at, so its task pushes commit with it instead of after an await.
  // #2301 review r2 B-5: the retag owes the tags field only, not an
  // all-field bump that would make concurrent peer edits tie and flip.
  it('commits a task retag with an update intent per retagged task', () => {
    const result = commitTaskRetag(db, () => ({ taskIds: ['task-1', 'task-2'], affected: 2 }))
    const fieldClocks = db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
      ?.fieldClocks as Record<string, Record<string, number>>
    expect(fieldClocks.tags).toEqual({ [DEVICE_ID]: 1 })
    expect(fieldClocks.title).toEqual({})

    expect(result).toEqual({ taskIds: ['task-1', 'task-2'], affected: 2 })
    expect(queue.peek(10).map((row) => [row.itemId, row.operation])).toEqual([
      ['task-1', 'update'],
      ['task-2', 'update']
    ])
    expect(db.select().from(syncIntents).all()).toEqual([])
  })

  // #2301
  it('queues a task update with its changed fields and bumps the clock once', async () => {
    const domain = createDesktopTasksDomain(db, publisher(), () => 'unused')

    await domain.updateTask({ id: 'task-1', title: 'Renamed' })

    const queued = queue.peek(10)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ type: 'task', itemId: 'task-1', operation: 'update' })
    expect(JSON.parse(queued[0]?.payload ?? '{}')).toMatchObject({
      title: 'Renamed',
      clock: { [DEVICE_ID]: 1 }
    })
  })
})
