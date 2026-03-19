import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import { tasks } from '@memry/db-schema/schema/tasks'
import { taskTags, taskNotes } from '@memry/db-schema/schema/task-relations'
import { ItemApplier } from './apply-item'
import { SyncQueueManager } from './queue'
import { TASK_SYNCABLE_FIELDS, initAllFieldClocks, type FieldClocks } from './field-merge'
import { TaskSyncService, initTaskSyncService, resetTaskSyncService } from './task-sync'
import { taskHandler } from './item-handlers/task-handler'
import type { DrizzleDb } from './item-handlers/types'
import { resetProjectSyncService } from './project-sync'

const BASE_PROJECT = {
  id: 'proj-1',
  name: 'Project',
  color: '#000',
  position: 0,
  isInbox: false
}

const BASE_STATUSES = [
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

function seedDevice(db: TestDatabaseResult, taskOverrides: Record<string, unknown> = {}): void {
  db.db.insert(projects).values(BASE_PROJECT).run()
  db.db.insert(statuses).values(BASE_STATUSES).run()

  const baseClock = { 'device-A': 1 }
  const baseFieldClocks = initAllFieldClocks(baseClock, TASK_SYNCABLE_FIELDS)

  db.db
    .insert(tasks)
    .values({
      id: 'task-1',
      projectId: 'proj-1',
      statusId: 'status-todo',
      title: 'Sync Test Task',
      priority: 0,
      position: 0,
      dueDate: null,
      clock: baseClock,
      fieldClocks: baseFieldClocks,
      syncedAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      ...taskOverrides
    })
    .run()
}

function seedMultipleTasks(db: TestDatabaseResult): void {
  db.db.insert(projects).values(BASE_PROJECT).run()
  db.db.insert(statuses).values(BASE_STATUSES).run()

  const baseClock = { 'device-A': 1 }
  const baseFieldClocks = initAllFieldClocks(baseClock, TASK_SYNCABLE_FIELDS)

  for (let i = 0; i < 3; i++) {
    db.db
      .insert(tasks)
      .values({
        id: `task-${i + 1}`,
        projectId: 'proj-1',
        statusId: 'status-todo',
        title: `Task ${i + 1}`,
        priority: 0,
        position: i,
        clock: baseClock,
        fieldClocks: baseFieldClocks,
        syncedAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      })
      .run()
  }
}

function getTagsFor(db: TestDatabaseResult, taskId: string): string[] {
  return db.db
    .select({ tag: taskTags.tag })
    .from(taskTags)
    .where(eq(taskTags.taskId, taskId))
    .all()
    .map((r) => r.tag)
    .sort()
}

function getNoteIdsFor(db: TestDatabaseResult, taskId: string): string[] {
  return db.db
    .select({ noteId: taskNotes.noteId })
    .from(taskNotes)
    .where(eq(taskNotes.taskId, taskId))
    .all()
    .map((r) => r.noteId)
    .sort()
}

function applyRemotePayload(
  applier: ItemApplier,
  taskId: string,
  payload: Record<string, unknown>
): string {
  return applier.apply({
    itemId: taskId,
    type: 'task',
    operation: 'update',
    content: new TextEncoder().encode(JSON.stringify(payload)),
    clock: (payload.clock as Record<string, number>) ?? {}
  })
}

describe('task sync gap fixes — E2E', () => {
  let deviceA: TestDatabaseResult
  let deviceB: TestDatabaseResult
  let queueA: SyncQueueManager
  let queueB: SyncQueueManager

  beforeEach(() => {
    resetTaskSyncService()
    resetProjectSyncService()

    deviceA = createTestDataDb()
    deviceB = createTestDataDb()

    queueA = new SyncQueueManager(deviceA.db as any)
    queueB = new SyncQueueManager(deviceB.db as any)
  })

  afterEach(() => {
    resetTaskSyncService()
    resetProjectSyncService()
    deviceA.close()
    deviceB.close()
  })

  // ===========================================================================
  // Gap 1: Reorder position sync
  // ===========================================================================
  describe('reorder position sync', () => {
    it('position changes in push payload reach remote device via applyUpsert', () => {
      // #given Device A and B start with 3 tasks at positions 0,1,2
      seedMultipleTasks(deviceA)
      seedMultipleTasks(deviceB)

      // #when Device A reorders: task-3 moves to position 0
      deviceA.db.update(tasks).set({ position: 2 }).where(eq(tasks.id, 'task-1')).run()
      deviceA.db.update(tasks).set({ position: 1 }).where(eq(tasks.id, 'task-2')).run()
      deviceA.db.update(tasks).set({ position: 0 }).where(eq(tasks.id, 'task-3')).run()

      const serviceA = new TaskSyncService({
        queue: queueA,
        db: deviceA.db as any,
        getDeviceId: () => 'device-A'
      })
      serviceA.enqueueUpdate('task-1', ['position'])
      serviceA.enqueueUpdate('task-3', ['position'])

      // #then payload includes updated positions
      const items = queueA.peek(10)
      expect(items.length).toBeGreaterThanOrEqual(1)

      // Apply task-3's payload to Device B
      const task3Item = items.find(
        (i) => JSON.parse(i.payload).position === 0 || i.itemId === 'task-3'
      )
      expect(task3Item).toBeDefined()
      const task3Payload = JSON.parse(task3Item!.payload) as Record<string, unknown>

      const applierB = new ItemApplier(deviceB.db as any, vi.fn())
      const result = applyRemotePayload(applierB, 'task-3', task3Payload)
      expect(result).toBe('applied')

      // Verify Device B sees task-3 at position 0
      const task3OnB = deviceB.db.select().from(tasks).where(eq(tasks.id, 'task-3')).get()
      expect(task3OnB).toBeDefined()
      expect(task3OnB!.position).toBe(0)
    })
  })

  // ===========================================================================
  // Gap 3: Tag sync between devices
  // ===========================================================================
  describe('tag sync between devices', () => {
    it('tags added on Device A appear on Device B after sync', () => {
      // #given identical tasks on both devices, no tags yet
      seedDevice(deviceA)
      seedDevice(deviceB)

      // #when Device A adds tags
      deviceA.db
        .insert(taskTags)
        .values([
          { taskId: 'task-1', tag: 'urgent' },
          { taskId: 'task-1', tag: 'bug' }
        ])
        .run()

      // Build push payload (includes tags now)
      const payload = taskHandler.buildPushPayload!(
        deviceA.db as unknown as DrizzleDb,
        'task-1',
        'device-A',
        'update'
      )
      expect(payload).toBeTruthy()
      const parsed = JSON.parse(payload!) as Record<string, unknown>

      // Verify payload includes tags
      expect(parsed.tags).toBeDefined()
      expect((parsed.tags as string[]).sort()).toEqual(['bug', 'urgent'])

      // #when Device B applies the payload
      const applierB = new ItemApplier(deviceB.db as any, vi.fn())
      const result = applyRemotePayload(applierB, 'task-1', parsed)
      expect(result).toBe('applied')

      // #then Device B has the tags in its junction table
      expect(getTagsFor(deviceB, 'task-1')).toEqual(['bug', 'urgent'])
    })

    it('linkedNoteIds added on Device A appear on Device B after sync', () => {
      // #given identical tasks on both devices
      seedDevice(deviceA)
      seedDevice(deviceB)

      // #when Device A links notes
      deviceA.db
        .insert(taskNotes)
        .values([
          { taskId: 'task-1', noteId: 'note-alpha' },
          { taskId: 'task-1', noteId: 'note-beta' }
        ])
        .run()

      const payload = taskHandler.buildPushPayload!(
        deviceA.db as unknown as DrizzleDb,
        'task-1',
        'device-A',
        'update'
      )
      const parsed = JSON.parse(payload!) as Record<string, unknown>
      expect((parsed.linkedNoteIds as string[]).sort()).toEqual(['note-alpha', 'note-beta'])

      // #when Device B applies
      const applierB = new ItemApplier(deviceB.db as any, vi.fn())
      applyRemotePayload(applierB, 'task-1', parsed)

      // #then Device B has linked notes
      expect(getNoteIdsFor(deviceB, 'task-1')).toEqual(['note-alpha', 'note-beta'])
    })

    it('concurrent tag edits merge via union — no tags lost', () => {
      // #given both devices have the same task with a shared tag
      seedDevice(deviceA)
      seedDevice(deviceB)
      deviceA.db.insert(taskTags).values({ taskId: 'task-1', tag: 'shared' }).run()
      deviceB.db.insert(taskTags).values({ taskId: 'task-1', tag: 'shared' }).run()

      // #when Device A adds 'frontend' tag and enqueues
      deviceA.db.insert(taskTags).values({ taskId: 'task-1', tag: 'frontend' }).run()
      const serviceA = new TaskSyncService({
        queue: queueA,
        db: deviceA.db as any,
        getDeviceId: () => 'device-A'
      })
      serviceA.enqueueUpdate('task-1', ['tags'])

      // #and Device B adds 'backend' tag and enqueues
      deviceB.db.insert(taskTags).values({ taskId: 'task-1', tag: 'backend' }).run()
      const serviceB = new TaskSyncService({
        queue: queueB,
        db: deviceB.db as any,
        getDeviceId: () => 'device-B'
      })
      serviceB.enqueueUpdate('task-1', ['tags'])

      // Cross-apply: A pulls B's payload
      const payloadFromB = JSON.parse(queueB.peek(1)[0].payload) as Record<string, unknown>
      const applierA = new ItemApplier(deviceA.db as any, vi.fn())
      const resultA = applyRemotePayload(applierA, 'task-1', payloadFromB)
      expect(['applied', 'conflict']).toContain(resultA)

      // Cross-apply: B pulls A's payload
      const payloadFromA = JSON.parse(queueA.peek(1)[0].payload) as Record<string, unknown>
      const applierB = new ItemApplier(deviceB.db as any, vi.fn())
      const resultB = applyRemotePayload(applierB, 'task-1', payloadFromA)
      expect(['applied', 'conflict']).toContain(resultB)

      // #then both devices have ALL tags (union)
      const tagsOnA = getTagsFor(deviceA, 'task-1')
      const tagsOnB = getTagsFor(deviceB, 'task-1')

      expect(tagsOnA).toEqual(['backend', 'frontend', 'shared'])
      expect(tagsOnB).toEqual(['backend', 'frontend', 'shared'])
    })

    it('tags survive when only scalar fields change remotely', () => {
      // #given Device A has tags, Device B has same task without tags
      seedDevice(deviceA)
      seedDevice(deviceB)
      deviceA.db.insert(taskTags).values({ taskId: 'task-1', tag: 'important' }).run()
      deviceB.db.insert(taskTags).values({ taskId: 'task-1', tag: 'important' }).run()

      // #when Device B changes title (no tags in payload)
      const serviceB = new TaskSyncService({
        queue: queueB,
        db: deviceB.db as any,
        getDeviceId: () => 'device-B'
      })
      deviceB.db.update(tasks).set({ title: 'Renamed Task' }).where(eq(tasks.id, 'task-1')).run()
      serviceB.enqueueUpdate('task-1', ['title'])

      // Apply B's change to A
      const payloadFromB = JSON.parse(queueB.peek(1)[0].payload) as Record<string, unknown>
      const applierA = new ItemApplier(deviceA.db as any, vi.fn())
      applyRemotePayload(applierA, 'task-1', payloadFromB)

      // #then Device A's tags are NOT wiped
      expect(getTagsFor(deviceA, 'task-1')).toEqual(['important'])

      // And title was updated
      const taskOnA = deviceA.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
      expect(taskOnA!.title).toBe('Renamed Task')
    })
  })

  // ===========================================================================
  // Full round-trip: enqueue → push payload → apply on remote
  // ===========================================================================
  describe('full enqueue-to-apply round trip', () => {
    it('TaskSyncService enqueue includes tags in payload for remote consumption', () => {
      // #given Device A has task with tags
      seedDevice(deviceA)
      seedDevice(deviceB)
      deviceA.db
        .insert(taskTags)
        .values([
          { taskId: 'task-1', tag: 'p0' },
          { taskId: 'task-1', tag: 'release' }
        ])
        .run()

      // #when enqueue via TaskSyncService (the real enqueue path)
      const serviceA = new TaskSyncService({
        queue: queueA,
        db: deviceA.db as any,
        getDeviceId: () => 'device-A'
      })
      serviceA.enqueueUpdate('task-1', ['title'])

      // #then queued payload contains tags
      const queueItem = queueA.peek(1)[0]
      expect(queueItem).toBeDefined()
      const payload = JSON.parse(queueItem.payload) as Record<string, unknown>
      expect((payload.tags as string[]).sort()).toEqual(['p0', 'release'])
      expect(payload.linkedNoteIds).toEqual([])

      // And remote device can consume it
      const applierB = new ItemApplier(deviceB.db as any, vi.fn())
      const result = applyRemotePayload(applierB, 'task-1', payload)
      expect(result).toBe('applied')
      expect(getTagsFor(deviceB, 'task-1')).toEqual(['p0', 'release'])
    })
  })
})
