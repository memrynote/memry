import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDataDb, asSyncDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import { projectLinks } from '@memry/db-schema/schema/project-links'
import { SyncQueueManager } from '../queue'
import { projectHandler } from './project-handler'
import type { ApplyContext, DrizzleDb } from './types'
import type { ProjectSyncPayload } from '@memry/contracts/sync-payloads'
import { TasksChannels } from '@memry/contracts/ipc-channels'

const TEST_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  color: '#000',
  position: 0,
  isInbox: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  modifiedAt: '2024-01-01T00:00:00.000Z'
}

const TEST_STATUSES = [
  {
    id: 'status-1',
    projectId: 'proj-1',
    name: 'Todo',
    color: '#gray',
    position: 0,
    isDefault: true,
    isDone: false
  },
  {
    id: 'status-2',
    projectId: 'proj-1',
    name: 'Done',
    color: '#green',
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

describe('projectHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  describe('applyUpsert', () => {
    describe('#given no existing project #when insert with statuses', () => {
      it('#then inserts project and statuses', () => {
        const data: ProjectSyncPayload = {
          name: 'Remote Project',
          color: '#ff0000',
          position: 0,
          isInbox: false,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          statuses: TEST_STATUSES.map(({ projectId, ...rest }) => rest)
        }

        const result = projectHandler.applyUpsert(ctx, 'proj-remote', data, { 'device-B': 1 })

        expect(result).toBe('applied')
        const inserted = testDb.db.select().from(projects).all()
        expect(inserted).toHaveLength(1)
        expect(inserted[0].name).toBe('Remote Project')

        const insertedStatuses = testDb.db.select().from(statuses).all()
        expect(insertedStatuses).toHaveLength(2)
        expect(insertedStatuses.map((s) => s.name).sort()).toEqual(['Done', 'Todo'])

        // Bug 1 regression: emitted event must include statuses
        expect(ctx.emit).toHaveBeenCalledWith(
          TasksChannels.events.PROJECT_CREATED,
          expect.objectContaining({
            project: expect.objectContaining({
              statuses: expect.arrayContaining([
                expect.objectContaining({ name: 'Todo' }),
                expect.objectContaining({ name: 'Done' })
              ])
            })
          })
        )
      })
    })

    describe('#given existing project #when update with status reconciliation', () => {
      it('#then updates project and reconciles statuses (adds new, removes old)', () => {
        testDb.db
          .insert(projects)
          .values({ ...TEST_PROJECT, clock: { 'device-A': 1 } })
          .run()
        testDb.db.insert(statuses).values(TEST_STATUSES).run()

        const data: ProjectSyncPayload = {
          name: 'Updated Project',
          color: '#000',
          position: 0,
          clock: { 'device-A': 1, 'device-B': 1 },
          statuses: [
            { id: 'status-1', name: 'Backlog', color: '#blue', position: 0 },
            { id: 'status-3', name: 'In Progress', color: '#yellow', position: 1 }
          ]
        }

        const result = projectHandler.applyUpsert(ctx, 'proj-1', data, {
          'device-A': 1,
          'device-B': 1
        })

        expect(result).toBe('applied')

        const updatedStatuses = testDb.db.select().from(statuses).all()
        expect(updatedStatuses).toHaveLength(2)

        const names = updatedStatuses.map((s) => s.name).sort()
        expect(names).toEqual(['Backlog', 'In Progress'])

        // Bug 1 regression: emitted event must include statuses
        expect(ctx.emit).toHaveBeenCalledWith(
          TasksChannels.events.PROJECT_UPDATED,
          expect.objectContaining({
            project: expect.objectContaining({
              statuses: expect.arrayContaining([
                expect.objectContaining({ name: 'Backlog' }),
                expect.objectContaining({ name: 'In Progress' })
              ])
            })
          })
        )
      })
    })

    describe('#given local clock is newer #when remote update arrives', () => {
      it('#then skips the update', () => {
        testDb.db
          .insert(projects)
          .values({ ...TEST_PROJECT, clock: { 'device-A': 5 } })
          .run()

        const data: ProjectSyncPayload = {
          name: 'Stale Update'
        }

        const result = projectHandler.applyUpsert(ctx, 'proj-1', data, { 'device-A': 3 })

        expect(result).toBe('skipped')
        const project = testDb.db.select().from(projects).all()[0]
        expect(project.name).toBe('Test Project')
      })
    })

    describe('#given local inbox exists #when remote inbox with different ID arrives', () => {
      it('#then skips the remote inbox insert', () => {
        testDb.db
          .insert(projects)
          .values({ id: 'local-inbox', name: 'Inbox', color: '#000', position: 0, isInbox: true })
          .run()

        const data: ProjectSyncPayload = {
          name: 'Inbox',
          isInbox: true
        }

        const result = projectHandler.applyUpsert(ctx, 'remote-inbox', data, { 'device-B': 1 })

        expect(result).toBe('skipped')
        const allProjects = testDb.db.select().from(projects).all()
        expect(allProjects).toHaveLength(1)
        expect(allProjects[0].id).toBe('local-inbox')
      })
    })

    describe('#given same inbox ID #when remote inbox update arrives', () => {
      it('#then updates the existing inbox', () => {
        testDb.db
          .insert(projects)
          .values({ id: 'shared-inbox', name: 'Inbox', color: '#000', position: 0, isInbox: true })
          .run()

        const data: ProjectSyncPayload = {
          name: 'Inbox Updated',
          isInbox: true,
          color: '#111'
        }

        const result = projectHandler.applyUpsert(ctx, 'shared-inbox', data, { 'device-B': 1 })

        expect(result).toBe('applied')
        const project = testDb.db.select().from(projects).all()[0]
        expect(project.name).toBe('Inbox Updated')
      })
    })
  })

  describe('applyDelete', () => {
    describe('#given project exists #when delete arrives', () => {
      it('#then deletes project and cascades statuses', () => {
        testDb.db.insert(projects).values(TEST_PROJECT).run()
        testDb.db.insert(statuses).values(TEST_STATUSES).run()

        const result = projectHandler.applyDelete(ctx, 'proj-1')

        expect(result).toBe('applied')
        expect(testDb.db.select().from(projects).all()).toHaveLength(0)
        expect(testDb.db.select().from(statuses).all()).toHaveLength(0)
      })
    })

    describe('#given project is inbox #when delete arrives', () => {
      it('#then refuses to delete inbox project', () => {
        testDb.db
          .insert(projects)
          .values({ ...TEST_PROJECT, isInbox: true })
          .run()

        const result = projectHandler.applyDelete(ctx, 'proj-1')

        expect(result).toBe('skipped')
        expect(testDb.db.select().from(projects).all()).toHaveLength(1)
      })
    })

    describe('#given local clock is newer #when remote delete arrives', () => {
      it('#then skips the delete', () => {
        testDb.db
          .insert(projects)
          .values({ ...TEST_PROJECT, clock: { 'device-A': 5 } })
          .run()

        const result = projectHandler.applyDelete(ctx, 'proj-1', { 'device-A': 3 })

        expect(result).toBe('skipped')
        expect(testDb.db.select().from(projects).all()).toHaveLength(1)
      })
    })

    describe('#given project does not exist #when delete arrives', () => {
      it('#then returns skipped', () => {
        const result = projectHandler.applyDelete(ctx, 'nonexistent')
        expect(result).toBe('skipped')
      })
    })
  })

  describe('fetchLocal', () => {
    it('#then returns project with embedded statuses', () => {
      testDb.db.insert(projects).values(TEST_PROJECT).run()
      testDb.db.insert(statuses).values(TEST_STATUSES).run()

      const result = projectHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'proj-1')

      expect(result).toBeDefined()
      expect(result!.name).toBe('Test Project')
      expect((result!.statuses as unknown[]).length).toBe(2)
    })

    it('#then returns undefined for nonexistent project', () => {
      const result = projectHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'nonexistent')
      expect(result).toBeUndefined()
    })
  })

  describe('seedUnclocked', () => {
    it('#then finds projects with null clock and enqueues them with statuses', () => {
      testDb.db.insert(projects).values(TEST_PROJECT).run()
      testDb.db.insert(statuses).values(TEST_STATUSES).run()

      const queue = new SyncQueueManager(asSyncDb(testDb.db))
      const count = projectHandler.seedUnclocked(
        testDb.db as unknown as DrizzleDb,
        'device-A',
        queue
      )

      expect(count).toBe(1)

      const [item] = queue.dequeue(1)
      expect(item.type).toBe('project')
      expect(item.operation).toBe('create')

      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 1 })
      expect(payload.statuses).toHaveLength(2)
    })

    it('#then skips projects that already have clocks', () => {
      testDb.db
        .insert(projects)
        .values({ ...TEST_PROJECT, clock: { 'device-A': 1 } })
        .run()

      const queue = new SyncQueueManager(asSyncDb(testDb.db))
      const count = projectHandler.seedUnclocked(
        testDb.db as unknown as DrizzleDb,
        'device-A',
        queue
      )

      expect(count).toBe(0)
    })
  })

  describe('links reconciliation', () => {
    it('#then inserts links from payload on upsert', () => {
      const data: ProjectSyncPayload = {
        name: 'P',
        links: [{ id: 'l1', itemType: 'note', itemId: 'n1', position: 0 }]
      }
      projectHandler.applyUpsert(ctx, 'proj-x', data, { 'device-B': 1 })
      const links = testDb.db.select().from(projectLinks).all()
      expect(links).toHaveLength(1)
      expect(links[0].itemId).toBe('n1')
    })

    it('#then reconciles links (adds new, removes missing)', () => {
      testDb.db
        .insert(projects)
        .values({ ...TEST_PROJECT, clock: { 'device-A': 1 } })
        .run()
      testDb.db
        .insert(projectLinks)
        .values({ id: 'l1', projectId: 'proj-1', itemType: 'note', itemId: 'old', position: 0 })
        .run()

      const data: ProjectSyncPayload = {
        name: 'P',
        clock: { 'device-A': 1, 'device-B': 1 },
        links: [{ id: 'l2', itemType: 'note', itemId: 'new', position: 0 }]
      }
      projectHandler.applyUpsert(ctx, 'proj-1', data, { 'device-A': 1, 'device-B': 1 })

      const links = testDb.db.select().from(projectLinks).all()
      expect(links.map((l) => l.itemId)).toEqual(['new'])
    })

    it('#then preserves local links when payload omits links (old client)', () => {
      testDb.db
        .insert(projects)
        .values({ ...TEST_PROJECT, clock: { 'device-A': 1 } })
        .run()
      testDb.db
        .insert(projectLinks)
        .values({ id: 'l1', projectId: 'proj-1', itemType: 'note', itemId: 'keep', position: 0 })
        .run()

      const data: ProjectSyncPayload = { name: 'Renamed', clock: { 'device-A': 1, 'device-B': 1 } }
      projectHandler.applyUpsert(ctx, 'proj-1', data, { 'device-A': 1, 'device-B': 1 })

      const links = testDb.db.select().from(projectLinks).all()
      expect(links.map((l) => l.itemId)).toEqual(['keep'])
    })

    it('#then preserves local pinned when an incoming link omits the field', () => {
      testDb.db
        .insert(projects)
        .values({ ...TEST_PROJECT, clock: { 'device-A': 1 } })
        .run()
      testDb.db
        .insert(projectLinks)
        .values({
          id: 'l1',
          projectId: 'proj-1',
          itemType: 'note',
          itemId: 'n1',
          position: 0,
          pinned: 1
        })
        .run()

      // An older client pushes the same link with no `pinned` key.
      const data: ProjectSyncPayload = {
        name: 'P',
        clock: { 'device-A': 1, 'device-B': 1 },
        links: [{ id: 'l1', itemType: 'note', itemId: 'n1', position: 0 }]
      }
      projectHandler.applyUpsert(ctx, 'proj-1', data, { 'device-A': 1, 'device-B': 1 })

      const links = testDb.db.select().from(projectLinks).all()
      expect(links[0].pinned).toBe(1)
    })

    it('#then round-trips pinned through push and apply', () => {
      testDb.db.insert(projects).values(TEST_PROJECT).run()
      testDb.db
        .insert(projectLinks)
        .values({
          id: 'l1',
          projectId: 'proj-1',
          itemType: 'note',
          itemId: 'n1',
          position: 0,
          pinned: 1
        })
        .run()

      const payload = JSON.parse(
        projectHandler.buildPushPayload(testDb.db as never, 'proj-1', 'device-A', 'update')!
      )
      expect(payload.links[0].pinned).toBe(1)

      // Fresh link ids — reusing 'l1' would hit the update branch, which never
      // reparents an existing link, so nothing would be inserted for proj-2.
      projectHandler.applyUpsert(
        ctx,
        'proj-2',
        {
          name: 'P2',
          links: payload.links.map((l: { id: string }) => ({ ...l, id: `${l.id}-copy` }))
        },
        { 'device-B': 1 }
      )
      const applied = testDb.db.select().from(projectLinks).all()
      expect(applied.find((l) => l.projectId === 'proj-2')?.pinned).toBe(1)
    })

    it('#then round-trips homeNoteId', () => {
      const data: ProjectSyncPayload = { name: 'P', homeNoteId: 'note-7' }
      projectHandler.applyUpsert(ctx, 'proj-h', data, { 'device-B': 1 })
      const row = testDb.db.select().from(projects).all()[0]
      expect(row.homeNoteId).toBe('note-7')
    })

    it('#then buildPushPayload includes links and homeNoteId', () => {
      testDb.db
        .insert(projects)
        .values({ ...TEST_PROJECT, homeNoteId: 'note-3' })
        .run()
      testDb.db
        .insert(projectLinks)
        .values({ id: 'l1', projectId: 'proj-1', itemType: 'note', itemId: 'n1', position: 0 })
        .run()

      const payload = JSON.parse(
        projectHandler.buildPushPayload(testDb.db as never, 'proj-1', 'device-A', 'update')!
      )
      expect(payload.homeNoteId).toBe('note-3')
      expect(payload.links).toHaveLength(1)
    })
  })
})
