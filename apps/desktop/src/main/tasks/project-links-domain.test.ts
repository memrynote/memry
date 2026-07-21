import { describe, it, expect, afterEach, vi } from 'vitest'
import { mockElectron } from '@tests/utils/mock-electron'

// The real publisher touches BrowserWindow (event broadcast) and the sync
// queue/offline-clock singletons — mock those so the isolated test DB below
// is the only database in play (matches apps/desktop/src/main/ipc/tasks-handlers.test.ts).
vi.mock('electron', () => ({
  BrowserWindow: mockElectron.BrowserWindow
}))
vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))
vi.mock('../sync/project-sync', () => ({
  getProjectSyncService: vi.fn(() => null)
}))
vi.mock('../sync/offline-clock', () => ({
  incrementProjectClocksOffline: vi.fn()
}))

import type { TasksDomainPublisher } from '@memry/domain-tasks'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { projectLinks } from '@memry/db-schema/schema/project-links'
import { createTasksPublisher } from './publisher'
import { createDesktopTasksDomain } from './domain'
import { generateId } from '../lib/id'

function domain(db: TestDatabaseResult) {
  return createDesktopTasksDomain(db.db as never, createTasksPublisher(), generateId)
}

function noopPublisher(): TasksDomainPublisher {
  return {
    taskCreated: vi.fn(),
    taskUpdated: vi.fn(),
    taskDeleted: vi.fn(),
    taskCompleted: vi.fn(),
    taskMoved: vi.fn(),
    projectCreated: vi.fn(),
    projectUpdated: vi.fn(),
    projectDeleted: vi.fn(),
    statusCreated: vi.fn(),
    statusUpdated: vi.fn(),
    statusDeleted: vi.fn()
  }
}

describe('project links domain', () => {
  let t: TestDatabaseResult
  afterEach(() => t?.close())

  it('#then links then unlinks a note', async () => {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#000', position: 0 }).run()
    const d = domain(t)

    await d.linkItemToProject({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    expect(t.db.select().from(projectLinks).all()).toHaveLength(1)

    await d.unlinkItemFromProject({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    expect(t.db.select().from(projectLinks).all()).toHaveLength(0)
  })

  it('#then linking the same item twice is idempotent', async () => {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#000', position: 0 }).run()
    const d = domain(t)
    await d.linkItemToProject({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    await d.linkItemToProject({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    expect(t.db.select().from(projectLinks).all()).toHaveLength(1)
  })

  // Links/home-note sync only because the project payload carries them, so
  // link/unlink/set-home-note must all re-enqueue a project push through the
  // exact same publisher.projectUpdated(...) call as updateProject/archiveProject —
  // a bare DB write alone does not enqueue anything (see apps/desktop/src/main/tasks/publisher.ts).
  it('#then re-enqueues a project push (via publisher.projectUpdated) on link, unlink, and set-home-note', async () => {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#000', position: 0 }).run()
    const publisher = noopPublisher()
    const d = createTasksDomainFor(t, publisher)

    await d.linkItemToProject({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    expect(publisher.projectUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))

    await d.unlinkItemFromProject({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    expect(publisher.projectUpdated).toHaveBeenCalledTimes(2)

    await d.setProjectHomeNote({ projectId: 'p1', noteId: 'n1' })
    expect(publisher.projectUpdated).toHaveBeenCalledTimes(3)
    expect(publisher.projectUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'p1', changedFields: ['homeNoteId'] })
    )
  })

  it('#then listForItem returns projects an item belongs to', async () => {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#111', position: 0 }).run()
    t.db.insert(projects).values({ id: 'p2', name: 'P2', color: '#222', position: 1 }).run()
    const d = domain(t)
    await d.linkItemToProject({ projectId: 'p1', itemType: 'calendar_event', itemId: 'e1' })
    await d.linkItemToProject({ projectId: 'p2', itemType: 'calendar_event', itemId: 'e1' })
    await d.linkItemToProject({ projectId: 'p1', itemType: 'note', itemId: 'n9' })

    const result = d.listForItem('calendar_event', 'e1')
    expect(result.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    expect(result.find((p) => p.id === 'p1')?.name).toBe('P1')
  })
})

function createTasksDomainFor(db: TestDatabaseResult, publisher: TasksDomainPublisher) {
  return createDesktopTasksDomain(db.db as never, publisher, generateId)
}
