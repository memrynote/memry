/**
 * Task field values through the real desktop tasks domain, storage and
 * data.db: callers see plain values, and only storage stamps versions
 * (chapter 06 section 6.11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

let activeDb: unknown = null

vi.mock('../database', () => ({
  getDatabase: () => activeDb,
  requireDatabase: () => activeDb
}))

import type { TasksDomainPublisher } from '@memry/domain-tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { tasks } from '@memry/db-schema/schema/tasks'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { initTaskSyncService, resetTaskSyncService } from '@memry/sync-client/task-sync'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb } from '../database/client'
import { createDesktopTasksDomain } from './domain'

let testDb: TestDatabaseResult
let db: DataDb
let publisher: TasksDomainPublisher
let domain: ReturnType<typeof createDesktopTasksDomain>
let nextId = 0

beforeEach(() => {
  testDb = createTestDataDb()
  db = asClientDb(testDb.db)
  activeDb = db
  initTaskSyncService({ queue: new SyncQueueManager(db), db, getDeviceId: () => 'device-a' })
  db.insert(projects).values({ id: 'proj-1', name: 'Project', color: '#000' }).run()
  publisher = {
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
    statusDeleted: vi.fn()
  }
  domain = createDesktopTasksDomain(db, publisher, () => `task-${++nextId}`)
})

afterEach(() => {
  resetTaskSyncService()
  activeDb = null
  testDb.close()
})

function stored(id: string): unknown {
  return db.select({ fields: tasks.fields }).from(tasks).where(eq(tasks.id, id)).get()?.fields
}

async function createWithOwner(): Promise<string> {
  const created = await domain.createTask({
    projectId: 'proj-1',
    title: 'Ask Ahmet',
    fields: { Owner: 'Ahmet' }
  })
  return created.task!.id
}

describe('task fields through the tasks domain', () => {
  it('stamps a new task’s map at t = 1 and reads back only the values', async () => {
    const created = await domain.createTask({
      projectId: 'proj-1',
      title: 'Ask Ahmet',
      fields: { 'Waiting on': ['memry://note/n1'], Thread: null }
    })
    const id = created.task!.id

    expect(created.task!.fields).toEqual({ 'Waiting on': ['memry://note/n1'] })
    expect(stored(id)).toEqual({ 'Waiting on': { v: ['memry://note/n1'], t: 1 } })
    expect(domain.getTask(id)?.fields).toEqual({ 'Waiting on': ['memry://note/n1'] })
  })

  it('stamps a patch above the task clock, removes with null, and reports the change', async () => {
    const id = await createWithOwner()
    db.update(tasks)
      .set({ clock: { 'device-b': 4, _offline: 1 } })
      .where(eq(tasks.id, id))
      .run()

    const updated = await domain.updateTask({
      id,
      fields: { Owner: null, 'Follow up': '2026-05-14' }
    })

    expect(stored(id)).toEqual({
      Owner: { v: null, t: 6 },
      'Follow up': { v: '2026-05-14', t: 6 }
    })
    expect(updated.task!.fields).toEqual({ 'Follow up': '2026-05-14' })
    expect(publisher.taskUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFields: ['fields'],
        changes: expect.objectContaining({ fields: { 'Follow up': '2026-05-14' } }),
        previous: { fields: { Owner: 'Ahmet' } }
      })
    )
  })

  it('stamps nothing and reports no change when the patch changes no value', async () => {
    const id = await createWithOwner()

    await domain.updateTask({ id, fields: { Owner: 'Ahmet', Missing: null } })

    expect(stored(id)).toEqual({ Owner: { v: 'Ahmet', t: 1 } })
    expect(publisher.taskUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ changedFields: [] })
    )
  })

  it('copies the map, versions included, to a duplicate', async () => {
    const id = await createWithOwner()
    await domain.updateTask({ id, fields: { Owner: 'Deniz' } })

    const duplicated = await domain.duplicateTask(id)

    expect(duplicated.task!.fields).toEqual({ Owner: 'Deniz' })
    expect(stored(duplicated.task!.id)).toEqual(stored(id))
  })
})
