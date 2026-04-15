import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import type { DataDb } from '../database/client'
import { SyncQueueManager } from './queue'
import { initTaskSyncService, resetTaskSyncService } from './task-sync'
import { initProjectSyncService, resetProjectSyncService } from './project-sync'
import { recoverDirtyItems } from './dirty-recovery'

const TEST_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  color: '#000',
  position: 0,
  isInbox: false,
  modifiedAt: '2026-01-01T00:00:00Z',
  syncedAt: '2026-01-01T00:00:00Z'
}

describe('dirty-recovery', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let db: DataDb

  beforeEach(() => {
    testDb = createTestDataDb()
    db = asClientDb(testDb.db)
    queue = new SyncQueueManager(db)
    initTaskSyncService({ queue, db, getDeviceId: () => 'device-A' })
    initProjectSyncService({ queue, db, getDeviceId: () => 'device-A' })

    db.insert(projects).values(TEST_PROJECT).run()
  })

  afterEach(() => {
    resetTaskSyncService()
    resetProjectSyncService()
    testDb.close()
  })

  it('recovers tasks modified since last sync', () => {
    // #given — task synced at t=1, modified at t=2
    db.insert(tasks)
      .values({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Original',
        priority: 0,
        position: 0,
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .run()

    // #when
    const result = recoverDirtyItems(db)

    // #then
    expect(result.tasks).toBe(1)
    expect(queue.getPendingCount()).toBe(1)

    const item = queue.peek(1)[0]
    expect(item?.itemId).toBe('task-1')
    expect(item?.operation).toBe('update')
  })

  it('recovers tasks created while signed out (syncedAt = null)', () => {
    // #given — task with no syncedAt
    db.insert(tasks)
      .values({
        id: 'task-new',
        projectId: 'proj-1',
        title: 'Created offline',
        priority: 0,
        position: 0,
        modifiedAt: '2026-01-01T00:00:00Z'
      })
      .run()

    // #when
    const result = recoverDirtyItems(db)

    // #then
    expect(result.tasks).toBe(1)
    const item = queue.peek(1)[0]
    expect(item?.itemId).toBe('task-new')
    expect(item?.operation).toBe('create')
  })

  it('skips tasks already synced and unmodified', () => {
    // #given — task where syncedAt >= modifiedAt
    db.insert(tasks)
      .values({
        id: 'task-clean',
        projectId: 'proj-1',
        title: 'Clean',
        priority: 0,
        position: 0,
        syncedAt: '2026-01-02T00:00:00Z',
        modifiedAt: '2026-01-01T00:00:00Z'
      })
      .run()

    // #when
    const result = recoverDirtyItems(db)

    // #then
    expect(result.tasks).toBe(0)
    expect(queue.getPendingCount()).toBe(0)
  })

  it('preserves existing clocks for recovered tasks without offline marker', () => {
    // #given — dirty task whose clock was already advanced at write time
    db.insert(tasks)
      .values({
        id: 'task-stale',
        projectId: 'proj-1',
        title: 'Stale',
        priority: 0,
        position: 0,
        clock: { 'old-device': 1 },
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .run()

    // #when
    recoverDirtyItems(db)

    // #then — recovery should not mutate non-offline clocks
    const task = db.select().from(tasks).where(eq(tasks.id, 'task-stale')).get()
    const clock = task.clock as Record<string, number>
    expect(clock['old-device']).toBe(1)
    expect(clock['device-A']).toBeUndefined()
  })

  it('does not synthesize field clocks for recovered tasks without offline marker', () => {
    // #given
    db.insert(tasks)
      .values({
        id: 'task-nofc',
        projectId: 'proj-1',
        title: 'No field clocks',
        priority: 0,
        position: 0,
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .run()

    // #when
    recoverDirtyItems(db)

    // #then — recovery should not inflate field-level metadata
    const task = db.select().from(tasks).where(eq(tasks.id, 'task-nofc')).get()
    expect(task.fieldClocks ?? null).toBeNull()
  })

  it('rebinds offline task clocks to current device during recovery', () => {
    db.insert(tasks)
      .values({
        id: 'task-offline',
        projectId: 'proj-1',
        title: 'Offline dirty',
        priority: 0,
        position: 0,
        clock: { 'old-device': 1, _offline: 1 },
        fieldClocks: {
          title: { 'old-device': 1 },
          statusId: { 'old-device': 1, _offline: 1 },
          dueDate: { 'old-device': 1 }
        },
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .run()

    recoverDirtyItems(db)

    const queued = queue.peek(1)[0]
    expect(queued?.operation).toBe('update')
    const payload = queued ? (JSON.parse(queued.payload) as Record<string, unknown>) : null
    const payloadFieldClocks = payload?.fieldClocks as
      | Record<string, Record<string, number>>
      | undefined
    expect(payload?.clock).toEqual({ 'old-device': 1, 'device-A': 1 })
    expect(payloadFieldClocks?.statusId).toEqual({ 'old-device': 1, 'device-A': 1 })
    expect(payloadFieldClocks?.title).toEqual({ 'old-device': 1 })

    const task = db.select().from(tasks).where(eq(tasks.id, 'task-offline')).get()
    const clock = task.clock as Record<string, number>
    const fc = task.fieldClocks as Record<string, Record<string, number>>
    expect(clock._offline).toBeUndefined()
    expect(fc.statusId._offline).toBeUndefined()
  })

  it('recovers dirty projects', () => {
    // #given — project modified after last sync
    db.update(projects)
      .set({
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .where(eq(projects.id, 'proj-1'))
      .run()

    // #when
    const result = recoverDirtyItems(db)

    // #then
    expect(result.projects).toBe(1)
    expect(queue.getPendingCount()).toBe(1)
  })

  it('recovers both tasks and projects in one call', () => {
    // #given
    db.insert(tasks)
      .values({
        id: 'task-dirty',
        projectId: 'proj-1',
        title: 'Dirty task',
        priority: 0,
        position: 0,
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .run()

    db.update(projects)
      .set({
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .where(eq(projects.id, 'proj-1'))
      .run()

    // #when
    const result = recoverDirtyItems(db)

    // #then
    expect(result.tasks).toBe(1)
    expect(result.projects).toBe(1)
    expect(queue.getPendingCount()).toBe(2)
  })

  it('returns zero counts when nothing is dirty', () => {
    // #given — only clean, synced project exists (no tasks)
    db.update(projects)
      .set({
        syncedAt: '2026-01-02T00:00:00Z',
        modifiedAt: '2026-01-01T00:00:00Z'
      })
      .where(eq(projects.id, 'proj-1'))
      .run()

    // #when
    const result = recoverDirtyItems(db)

    // #then
    expect(result.tasks).toBe(0)
    expect(result.projects).toBe(0)
  })
})
