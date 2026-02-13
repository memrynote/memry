import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { tasks } from '@shared/db/schema/tasks'
import { projects } from '@shared/db/schema/projects'
import type { VectorClock } from '@shared/contracts/sync-api'
import { ItemApplier, type EmitToWindows } from './apply-item'

const TEST_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  color: '#000',
  position: 0,
  isInbox: false
}

function makeTaskPayload(overrides: Record<string, unknown> = {}): Uint8Array {
  const data = {
    id: 'task-1',
    projectId: 'proj-1',
    title: 'Remote Task',
    description: null,
    priority: 0,
    position: 0,
    statusId: null,
    parentId: null,
    dueDate: null,
    dueTime: null,
    startDate: null,
    repeatConfig: null,
    repeatFrom: null,
    sourceNoteId: null,
    completedAt: null,
    archivedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  }
  return new TextEncoder().encode(JSON.stringify(data))
}

describe('ItemApplier', () => {
  let testDb: TestDatabaseResult
  let emitToWindows: EmitToWindows
  let applier: ItemApplier

  beforeEach(() => {
    testDb = createTestDataDb()
    emitToWindows = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applier = new ItemApplier(testDb.db as any, emitToWindows)

    testDb.db.insert(projects).values(TEST_PROJECT).run()
  })

  afterEach(() => {
    testDb.close()
  })

  describe('#given no local task #when create applied', () => {
    it('#then inserts task and emits CREATED', () => {
      const result = applier.apply({
        itemId: 'task-1',
        type: 'task',
        operation: 'create',
        content: makeTaskPayload(),
        clock: { 'device-B': 1 }
      })

      expect(result).toBe('applied')

      const task = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
      expect(task).toBeDefined()
      expect(task!.title).toBe('Remote Task')
      expect(task!.clock).toEqual({ 'device-B': 1 })
      expect(task!.syncedAt).toBeDefined()

      expect(emitToWindows).toHaveBeenCalledWith(
        expect.stringContaining('created'),
        expect.objectContaining({ task: expect.objectContaining({ id: 'task-1' }) })
      )
    })
  })

  describe('#given local task with older clock #when update applied', () => {
    it('#then updates task and emits UPDATED', () => {
      testDb.db.insert(tasks).values({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Old Title',
        priority: 0,
        position: 0,
        clock: { 'device-B': 1 } satisfies VectorClock
      }).run()

      const result = applier.apply({
        itemId: 'task-1',
        type: 'task',
        operation: 'update',
        content: makeTaskPayload({ title: 'New Title', clock: { 'device-B': 2 } }),
        clock: { 'device-B': 2 }
      })

      expect(result).toBe('applied')

      const task = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
      expect(task!.title).toBe('New Title')
      expect(task!.clock).toEqual({ 'device-B': 2 })
    })
  })

  describe('#given local task with newer clock #when update applied', () => {
    it('#then skips the update', () => {
      testDb.db.insert(tasks).values({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Local Title',
        priority: 0,
        position: 0,
        clock: { 'device-A': 3 } satisfies VectorClock
      }).run()

      const result = applier.apply({
        itemId: 'task-1',
        type: 'task',
        operation: 'update',
        content: makeTaskPayload({ title: 'Remote Title' }),
        clock: { 'device-A': 1 }
      })

      expect(result).toBe('skipped')

      const task = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
      expect(task!.title).toBe('Local Title')
    })
  })

  describe('#given concurrent clocks #when update applied', () => {
    it('#then applies with merged clock and returns conflict', () => {
      testDb.db.insert(tasks).values({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Local Title',
        priority: 0,
        position: 0,
        clock: { 'device-A': 2 } satisfies VectorClock
      }).run()

      const result = applier.apply({
        itemId: 'task-1',
        type: 'task',
        operation: 'update',
        content: makeTaskPayload({ title: 'Remote Title' }),
        clock: { 'device-B': 2 }
      })

      expect(result).toBe('conflict')

      const task = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
      expect(task!.title).toBe('Remote Title')
      expect(task!.clock).toEqual({ 'device-A': 2, 'device-B': 2 })
    })
  })

  describe('#given existing task #when delete applied', () => {
    it('#then removes task and emits DELETED', () => {
      testDb.db.insert(tasks).values({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'To Delete',
        priority: 0,
        position: 0
      }).run()

      const result = applier.apply({
        itemId: 'task-1',
        type: 'task',
        operation: 'delete',
        content: new Uint8Array(),
        deletedAt: Date.now()
      })

      expect(result).toBe('applied')

      const task = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
      expect(task).toBeUndefined()

      expect(emitToWindows).toHaveBeenCalledWith(
        expect.stringContaining('deleted'),
        { id: 'task-1' }
      )
    })
  })

  describe('#given no local task #when delete applied', () => {
    it('#then skips silently', () => {
      const result = applier.apply({
        itemId: 'nonexistent',
        type: 'task',
        operation: 'delete',
        content: new Uint8Array(),
        deletedAt: Date.now()
      })

      expect(result).toBe('skipped')
      expect(emitToWindows).not.toHaveBeenCalled()
    })
  })

  describe('#given unsupported type #when apply called', () => {
    it('#then skips', () => {
      const result = applier.apply({
        itemId: 'x',
        type: 'note',
        operation: 'create',
        content: new Uint8Array()
      })

      expect(result).toBe('skipped')
    })
  })

  describe('#given local task with newer clock #when delete applied', () => {
    it('#then skips the delete', () => {
      testDb.db.insert(tasks).values({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Keep Me',
        priority: 0,
        position: 0,
        clock: { 'device-A': 5 } satisfies VectorClock
      }).run()

      const result = applier.apply({
        itemId: 'task-1',
        type: 'task',
        operation: 'delete',
        content: new Uint8Array(),
        clock: { 'device-B': 1 },
        deletedAt: Date.now()
      })

      expect(result).toBe('skipped')

      const task = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
      expect(task).toBeDefined()
    })
  })
})
