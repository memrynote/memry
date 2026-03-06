import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { savedFilters } from '@memry/db-schema/schema/settings'
import { syncState } from '@memry/db-schema/schema/sync-state'
import type { VectorClock } from '@memry/contracts/sync-api'
import { SyncQueueManager } from './queue'
import { runInitialSeed, type InitialSeedDeps } from './initial-seed'

const DEVICE_ID = 'device-A'

const TEST_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  color: '#000',
  position: 0,
  isInbox: false,
  clock: { [DEVICE_ID]: 1 }
}

describe('runInitialSeed', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let deps: InitialSeedDeps

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(
      testDb.db as unknown as ConstructorParameters<typeof SyncQueueManager>[0]
    )
    testDb.db.insert(projects).values(TEST_PROJECT).run()
    deps = {
      db: testDb.db as unknown as InitialSeedDeps['db'],
      queue,
      deviceId: DEVICE_ID
    }
  })

  afterEach(() => {
    testDb.close()
  })

  describe('#given tasks with NULL clock #when seed runs', () => {
    it('#then stamps clock and enqueues each task', () => {
      // #given
      testDb.db
        .insert(tasks)
        .values({
          id: 'task-1',
          projectId: 'proj-1',
          title: 'Local Task',
          priority: 0,
          position: 0
        })
        .run()

      // #when
      runInitialSeed(deps)

      // #then
      const task = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
      expect(task?.clock).toEqual({ [DEVICE_ID]: 1 })
      expect(queue.getSize()).toBe(1)

      const item = queue.peek(1)[0]
      expect(item?.type).toBe('task')
      expect(item?.itemId).toBe('task-1')
      expect(item?.operation).toBe('create')
      expect(item).toBeDefined()
      if (!item) throw new Error('Expected queued item to be present')
      const payload = JSON.parse(item.payload) as { clock?: VectorClock }
      expect(payload.clock).toEqual({ [DEVICE_ID]: 1 })
    })
  })

  describe('#given inbox items with localOnly=true #when seed runs', () => {
    it('#then skips localOnly items', () => {
      // #given
      testDb.db
        .insert(inboxItems)
        .values({ id: 'inbox-1', type: 'note', title: 'Local Only', localOnly: true })
        .run()

      // #when
      runInitialSeed(deps)

      // #then
      const item = testDb.db.select().from(inboxItems).where(eq(inboxItems.id, 'inbox-1')).get()
      expect(item?.clock).toBeNull()
      expect(queue.getSize()).toBe(0)
    })
  })

  describe('#given inbox items with localOnly=false #when seed runs', () => {
    it('#then stamps clock and enqueues inbox item', () => {
      // #given
      testDb.db
        .insert(inboxItems)
        .values({ id: 'inbox-2', type: 'link', title: 'Syncable Inbox', localOnly: false })
        .run()

      // #when
      runInitialSeed(deps)

      // #then
      const item = testDb.db.select().from(inboxItems).where(eq(inboxItems.id, 'inbox-2')).get()
      expect(item?.clock).toEqual({ [DEVICE_ID]: 1 })
      expect(queue.getSize()).toBe(1)

      const queued = queue.peek(1)[0]
      expect(queued?.type).toBe('inbox')
      expect(queued?.itemId).toBe('inbox-2')
    })
  })

  describe('#given saved filters with NULL clock #when seed runs', () => {
    it('#then stamps clock and enqueues each filter', () => {
      // #given
      testDb.db
        .insert(savedFilters)
        .values({ id: 'filter-1', name: 'My Filter', config: { priority: 'high' }, position: 0 })
        .run()

      // #when
      runInitialSeed(deps)

      // #then
      const filter = testDb.db
        .select()
        .from(savedFilters)
        .where(eq(savedFilters.id, 'filter-1'))
        .get()
      expect(filter?.clock).toEqual({ [DEVICE_ID]: 1 })
      expect(queue.getSize()).toBe(1)

      const queued = queue.peek(1)[0]
      expect(queued?.type).toBe('filter')
      expect(queued?.itemId).toBe('filter-1')
    })
  })

  describe('#given seed already done #when seed runs again', () => {
    it('#then re-seeds if unclocked items still exist', () => {
      // #given
      testDb.db
        .insert(tasks)
        .values({
          id: 'task-2',
          projectId: 'proj-1',
          title: 'Another Task',
          priority: 0,
          position: 0
        })
        .run()
      testDb.db
        .insert(syncState)
        .values({ key: 'initialSeedDone', value: 'true', updatedAt: new Date() })
        .run()

      // #when
      runInitialSeed(deps)

      // #then
      const task = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-2')).get()
      expect(task?.clock).toEqual({ [DEVICE_ID]: 1 })
      expect(queue.getSize()).toBe(1)
    })
  })

  describe('#given no NULL-clock items #when seed runs', () => {
    it('#then sets flag and enqueues nothing', () => {
      // #given — empty vault

      // #when
      runInitialSeed(deps)

      // #then
      expect(queue.getSize()).toBe(0)
      const flag = testDb.db
        .select()
        .from(syncState)
        .where(eq(syncState.key, 'initialSeedDone'))
        .get()
      expect(flag?.value).toBe('true')
    })
  })

  describe('#given seed already done and no NULL-clock items #when seed runs', () => {
    it('#then no-ops without enqueuing', () => {
      // #given
      testDb.db
        .insert(syncState)
        .values({ key: 'initialSeedDone', value: 'true', updatedAt: new Date() })
        .run()

      // #when
      runInitialSeed(deps)

      // #then
      expect(queue.getSize()).toBe(0)
      const flag = testDb.db
        .select()
        .from(syncState)
        .where(eq(syncState.key, 'initialSeedDone'))
        .get()
      expect(flag?.value).toBe('true')
    })
  })

  describe('#given mixed clocked and unclocked items #when seed runs', () => {
    it('#then only seeds unclocked items', () => {
      // #given
      const existingClock: VectorClock = { 'device-B': 3 }
      testDb.db
        .insert(tasks)
        .values([
          {
            id: 'task-clocked',
            projectId: 'proj-1',
            title: 'Already Synced',
            priority: 0,
            position: 0,
            clock: existingClock
          },
          {
            id: 'task-unclocked',
            projectId: 'proj-1',
            title: 'Local Only',
            priority: 0,
            position: 1
          }
        ])
        .run()

      // #when
      runInitialSeed(deps)

      // #then
      const clocked = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-clocked')).get()
      expect(clocked?.clock).toEqual(existingClock)

      const unclocked = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-unclocked')).get()
      expect(unclocked?.clock).toEqual({ [DEVICE_ID]: 1 })

      expect(queue.getSize()).toBe(1)
      const queued = queue.peek(1)[0]
      expect(queued?.itemId).toBe('task-unclocked')
    })
  })
})
