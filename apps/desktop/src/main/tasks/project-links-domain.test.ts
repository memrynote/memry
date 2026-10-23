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
vi.mock('@memry/sync-client/project-sync', () => ({
  getProjectSyncService: vi.fn(() => null)
}))
vi.mock('@memry/sync-client/offline-clock', () => ({
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

  // project_links.project_id carries a FK (and the test DB runs foreign_keys = ON),
  // so inserting before the project lookup throws past the structured response.
  it('#then rejects linking to an unknown project without inserting or throwing', async () => {
    t = createTestDataDb()
    const d = domain(t)

    const result = await d.linkItemToProject({
      projectId: 'ghost',
      itemType: 'note',
      itemId: 'n1'
    })

    expect(result).toEqual({ success: false, error: 'Project not found' })
    expect(t.db.select().from(projectLinks).all()).toHaveLength(0)
  })

  it('#then lists project links ordered by position', async () => {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#000', position: 0 }).run()
    t.db
      .insert(projectLinks)
      .values([
        { id: 'l3', projectId: 'p1', itemType: 'note', itemId: 'third', position: 2 },
        { id: 'l1', projectId: 'p1', itemType: 'note', itemId: 'first', position: 0 },
        { id: 'l2', projectId: 'p1', itemType: 'note', itemId: 'second', position: 1 }
      ])
      .run()

    const links = domain(t).listProjectLinks('p1')
    expect(links.map((l) => l.itemId)).toEqual(['first', 'second', 'third'])
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

  // Cleanup rules (spec §4): deleting a note must not leave orphan project_links
  // rows or a dangling home_note_id. Cleanup drops the note's links everywhere and
  // nulls any project whose home note was that note.
  it('#then removes the deleted note links and clears home notes across projects', async () => {
    t = createTestDataDb()
    t.db
      .insert(projects)
      .values([
        { id: 'p1', name: 'P1', color: '#000', position: 0, homeNoteId: 'n1' },
        { id: 'p2', name: 'P2', color: '#000', position: 1, homeNoteId: 'n1' },
        { id: 'p3', name: 'P3', color: '#000', position: 2, homeNoteId: 'other' }
      ])
      .run()
    const d = domain(t)
    await d.linkItemToProject({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    await d.linkItemToProject({ projectId: 'p1', itemType: 'note', itemId: 'keep' })
    await d.linkItemToProject({ projectId: 'p2', itemType: 'note', itemId: 'n1' })

    await d.cleanupProjectLinksForDeletedNote('n1')

    const remaining = t.db.select().from(projectLinks).all()
    expect(remaining.map((l) => l.itemId).sort()).toEqual(['keep'])

    const homeById = Object.fromEntries(
      t.db
        .select()
        .from(projects)
        .all()
        .map((p) => [p.id, p.homeNoteId])
    )
    expect(homeById).toEqual({ p1: null, p2: null, p3: 'other' })
  })

  it('#then re-enqueues each affected project (publisher.projectUpdated) when a linked note is deleted', async () => {
    t = createTestDataDb()
    t.db
      .insert(projects)
      .values([
        { id: 'p1', name: 'P1', color: '#000', position: 0, homeNoteId: 'n1' },
        { id: 'p2', name: 'P2', color: '#000', position: 1 }
      ])
      .run()
    t.db
      .insert(projectLinks)
      .values([
        { id: 'l1', projectId: 'p1', itemType: 'note', itemId: 'n1' },
        { id: 'l2', projectId: 'p2', itemType: 'note', itemId: 'n1' }
      ])
      .run()
    const publisher = noopPublisher()
    const d = createTasksDomainFor(t, publisher)

    await d.cleanupProjectLinksForDeletedNote('n1')

    // p1 lost a link AND was a home note → both fields; p2 only lost a link.
    expect(publisher.projectUpdated).toHaveBeenCalledTimes(2)
    expect(publisher.projectUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', changedFields: ['links', 'homeNoteId'] })
    )
    expect(publisher.projectUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p2', changedFields: ['links'] })
    )
  })

  it('#then does nothing when the deleted note had no links or home-note references', async () => {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#000', position: 0 }).run()
    const publisher = noopPublisher()
    const d = createTasksDomainFor(t, publisher)

    await d.cleanupProjectLinksForDeletedNote('ghost')

    expect(publisher.projectUpdated).not.toHaveBeenCalled()
  })
})

function createTasksDomainFor(db: TestDatabaseResult, publisher: TasksDomainPublisher) {
  return createDesktopTasksDomain(db.db as never, publisher, generateId)
}
